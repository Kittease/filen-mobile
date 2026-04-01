import * as FileSystem from "expo-file-system"
import * as FileSystemLegacy from "expo-file-system/legacy"
import { getSDK } from "@/lib/sdk"
import { Semaphore } from "@/lib/semaphore"
import { randomUUID } from "expo-crypto"
import sqlite, { type SyncStateRow } from "@/lib/sqlite"
import { useFolderSyncStore, type SyncPairConfig } from "@/stores/folderSync.store"
import paths from "@/lib/paths"
import pathModule from "path"
import nodeWorker from "@/lib/nodeWorker"

export type LocalFileEntry = {
	relativePath: string
	size: number
	lastModified: number
}

export type RemoteFileEntry = {
	relativePath: string
	size: number
	lastModified: number
	uuid: string
	parent: string
	bucket: string
	region: string
	chunks: number
	version: number
	key: string
	mime: string
	name: string
}

export type SyncDeltas = {
	toDownload: RemoteFileEntry[]
	toUpload: { relativePath: string; localUri: string; size: number; lastModified: number }[]
	toDeleteLocal: string[]
	toDeleteRemote: { uuid: string; relativePath: string }[]
	toMkdirLocal: string[]
	toMkdirRemote: { relativePath: string; parentUUID: string }[]
}

class FolderSync {
	private autoSyncInterval: ReturnType<typeof setInterval> | null = null
	private runningSyncs = new Set<string>()

	/**
	 * Recursively scan a SAF directory and return a map of relative paths to file entries.
	 */
	public async scanLocalTree(
		safDirUri: string,
		excludeDotFiles: boolean,
		basePath: string = ""
	): Promise<Map<string, LocalFileEntry>> {
		const result = new Map<string, LocalFileEntry>()
		let children: string[]

		try {
			children = await FileSystemLegacy.StorageAccessFramework.readDirectoryAsync(safDirUri)
		} catch {
			return result
		}

		for (const childUri of children) {
			let info: FileSystemLegacy.FileInfo

			try {
				info = await FileSystemLegacy.getInfoAsync(childUri)
			} catch {
				continue
			}

			// SAF URIs may or may not be already encoded; try to extract the final segment
			const decodedUri = decodeURIComponent(childUri)
			const lastSlash = decodedUri.lastIndexOf("/")
			const name = lastSlash >= 0 ? decodedUri.substring(lastSlash + 1) : decodedUri

			if (!name || name.length === 0) {
				continue
			}

			if (excludeDotFiles && name.startsWith(".")) {
				continue
			}

			const relativePath = basePath.length > 0 ? `${basePath}/${name}` : name

			// getInfoAsync on SAF child URIs can misreport isDirectory on some Android versions.
			// Use readDirectoryAsync as a reliable fallback to detect directories.
			let isDir = info.isDirectory

			if (!isDir) {
				try {
					await FileSystemLegacy.StorageAccessFramework.readDirectoryAsync(childUri)
					isDir = true
				} catch {
					isDir = false
				}
			}

			if (isDir) {
				const subEntries = await this.scanLocalTree(childUri, excludeDotFiles, relativePath)

				for (const [subPath, entry] of subEntries) {
					result.set(subPath, entry)
				}
			} else {
				result.set(relativePath, {
					relativePath,
					size: info.size ?? 0,
					lastModified: info.modificationTime ? info.modificationTime * 1000 : Date.now()
				})
			}
		}

		return result
	}

	/**
	 * Scan the remote cloud directory tree and return a map of relative paths to file entries.
	 */
	public async scanRemoteTree(
		remoteUUID: string,
		excludeDotFiles: boolean
	): Promise<{ files: Map<string, RemoteFileEntry>; directories: Map<string, { uuid: string; parent: string }> }> {
		const files = new Map<string, RemoteFileEntry>()
		const directories = new Map<string, { uuid: string; parent: string }>()

		const tree = await getSDK().cloud().getDirectoryTree({
			uuid: remoteUUID,
			type: "normal"
		})

		for (const treePath in tree) {
			const item = tree[treePath]

			if (!item) {
				continue
			}

			// The tree path includes the root folder name at the start. Strip it.
			const parts = treePath.split("/")
			const relativePath = parts.slice(1).join("/")

			if (!relativePath || relativePath.length === 0) {
				continue
			}

			if (excludeDotFiles) {
				const pathParts = relativePath.split("/")
				const hasDotPart = pathParts.some(p => p.startsWith("."))

				if (hasDotPart) {
					continue
				}
			}

			if (item.type === "directory") {
				directories.set(relativePath, {
					uuid: item.uuid,
					parent: item.parent
				})
			} else {
				files.set(relativePath, {
					relativePath,
					size: item.size,
					lastModified: item.lastModified,
					uuid: item.uuid,
					parent: item.parent,
					bucket: item.bucket,
					region: item.region,
					chunks: item.chunks,
					version: item.version,
					key: item.key,
					mime: item.mime,
					name: item.name
				})
			}
		}

		return { files, directories }
	}

	/**
	 * Compute the changes needed to bring both sides in sync (two-way).
	 */
	public computeDeltas(
		localTree: Map<string, LocalFileEntry>,
		remoteFiles: Map<string, RemoteFileEntry>,
		remoteDirectories: Map<string, { uuid: string; parent: string }>,
		prevLocal: Map<string, SyncStateRow>,
		prevRemote: Map<string, SyncStateRow>,
		remoteRootUUID: string
	): SyncDeltas {
		const toDownload: RemoteFileEntry[] = []
		const toUpload: SyncDeltas["toUpload"] = []
		const toDeleteLocal: string[] = []
		const toDeleteRemote: SyncDeltas["toDeleteRemote"] = []
		const toMkdirLocal: string[] = []
		const toMkdirRemote: SyncDeltas["toMkdirRemote"] = []

		// Collect all directory paths needed for downloads
		const neededLocalDirs = new Set<string>()
		// Collect all directory paths needed for uploads
		const neededRemoteDirs = new Set<string>()

		// Check remote files against local
		for (const [relPath, remoteEntry] of remoteFiles) {
			const localEntry = localTree.get(relPath)
			const prevRemoteEntry = prevRemote.get(relPath)
			const prevLocalEntry = prevLocal.get(relPath)

			if (!localEntry) {
				if (!prevRemoteEntry) {
					// New file on remote, never seen before → download
					toDownload.push(remoteEntry)
					this.collectParentDirs(relPath, neededLocalDirs)
				} else if (!prevLocalEntry) {
					// Was in remote previously, never in local → download
					toDownload.push(remoteEntry)
					this.collectParentDirs(relPath, neededLocalDirs)
				} else {
					// Was in both previously, now missing locally → local deletion → delete from remote
					toDeleteRemote.push({ uuid: remoteEntry.uuid, relativePath: relPath })
				}
			} else {
				// File exists on both sides
				if (prevRemoteEntry && (remoteEntry.size !== prevRemoteEntry.size || remoteEntry.lastModified !== prevRemoteEntry.lastModified)) {
					// Remote changed since last sync
					if (prevLocalEntry && (localEntry.size !== prevLocalEntry.size || localEntry.lastModified !== prevLocalEntry.lastModified)) {
						// Both changed → conflict, last-modified-wins
						if (remoteEntry.lastModified >= localEntry.lastModified) {
							toDownload.push(remoteEntry)
						} else {
							toUpload.push({ relativePath: relPath, localUri: "", size: localEntry.size, lastModified: localEntry.lastModified })
							this.collectParentDirs(relPath, neededRemoteDirs)
						}
					} else {
						// Only remote changed → download
						toDownload.push(remoteEntry)
					}
				} else if (prevLocalEntry && (localEntry.size !== prevLocalEntry.size || localEntry.lastModified !== prevLocalEntry.lastModified)) {
					// Only local changed → upload
					toUpload.push({ relativePath: relPath, localUri: "", size: localEntry.size, lastModified: localEntry.lastModified })
					this.collectParentDirs(relPath, neededRemoteDirs)
				}
			}
		}

		// Check local files that don't exist on remote
		for (const [relPath, localEntry] of localTree) {
			if (remoteFiles.has(relPath)) {
				continue
			}

			const prevLocalEntry = prevLocal.get(relPath)
			const prevRemoteEntry = prevRemote.get(relPath)

			if (!prevLocalEntry) {
				// New file locally, never seen → upload
				toUpload.push({ relativePath: relPath, localUri: "", size: localEntry.size, lastModified: localEntry.lastModified })
				this.collectParentDirs(relPath, neededRemoteDirs)
			} else if (!prevRemoteEntry) {
				// Was in local previously, never in remote → upload
				toUpload.push({ relativePath: relPath, localUri: "", size: localEntry.size, lastModified: localEntry.lastModified })
				this.collectParentDirs(relPath, neededRemoteDirs)
			} else {
				// Was in both previously, now missing on remote → remote deletion → delete locally
				toDeleteLocal.push(relPath)
			}
		}

		// Build mkdir lists from collected directory paths
		for (const dir of neededLocalDirs) {
			toMkdirLocal.push(dir)
		}

		for (const dir of neededRemoteDirs) {
			// Find the parent UUID for this directory
			const parentDir = pathModule.posix.dirname(dir)
			const parentUUID = parentDir === "." ? remoteRootUUID : (remoteDirectories.get(parentDir)?.uuid ?? remoteRootUUID)

			toMkdirRemote.push({ relativePath: dir, parentUUID })
		}

		// Sort directories so parents are created before children
		toMkdirLocal.sort((a, b) => a.split("/").length - b.split("/").length)
		toMkdirRemote.sort((a, b) => a.relativePath.split("/").length - b.relativePath.split("/").length)

		return { toDownload, toUpload, toDeleteLocal, toDeleteRemote, toMkdirLocal, toMkdirRemote }
	}

	private collectParentDirs(filePath: string, dirSet: Set<string>): void {
		const parts = filePath.split("/")

		for (let i = 1; i < parts.length; i++) {
			dirSet.add(parts.slice(0, i).join("/"))
		}
	}

	/**
	 * Resolve a SAF child URI for a given relative path under the root SAF directory.
	 * Creates intermediate directories as needed.
	 */
	private async resolveOrCreateSafPath(rootUri: string, relativePath: string, isFile: boolean): Promise<string> {
		const parts = relativePath.split("/")
		let currentUri = rootUri

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!
			const isLastPart = i === parts.length - 1

			if (isLastPart && isFile) {
				// Create the file
				const mimeType = "application/octet-stream"

				return await FileSystemLegacy.StorageAccessFramework.createFileAsync(currentUri, part, mimeType)
			} else {
				// Create or navigate to directory
				try {
					currentUri = await FileSystemLegacy.StorageAccessFramework.makeDirectoryAsync(currentUri, part)
				} catch {
					// Directory might already exist, try to find it
					const children = await FileSystemLegacy.StorageAccessFramework.readDirectoryAsync(currentUri)
					const match = children.find(c => {
						const decoded = decodeURIComponent(c)

						return decoded.endsWith(`/${part}`) || decoded.endsWith(`%2F${part}`)
					})

					if (match) {
						currentUri = match
					} else {
						throw new Error(`Failed to create or find directory: ${part} under ${currentUri}`)
					}
				}
			}
		}

		return currentUri
	}

	/**
	 * Find the SAF URI for a file at a given relative path, without creating it.
	 */
	private async findSafFileUri(rootUri: string, relativePath: string): Promise<string | null> {
		const parts = relativePath.split("/")
		let currentUri = rootUri

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!
			const isLastPart = i === parts.length - 1
			const children = await FileSystemLegacy.StorageAccessFramework.readDirectoryAsync(currentUri)
			const match = children.find(c => {
				const decoded = decodeURIComponent(c)

				return decoded.endsWith(`/${part}`) || decoded.endsWith(`%2F${part}`)
			})

			if (!match) {
				return null
			}

			// At the final segment, verify we found a file not a directory
			if (isLastPart) {
				try {
					await FileSystemLegacy.StorageAccessFramework.readDirectoryAsync(match)
					// readDirectoryAsync succeeded → it's a directory, not a file
					return null
				} catch {
					// readDirectoryAsync threw → it's a file, good
				}
			}

			currentUri = match
		}

		return currentUri
	}

	/**
	 * Apply all computed deltas for a sync pair.
	 */
	public async applyChanges(
		deltas: SyncDeltas,
		pair: SyncPairConfig,
		remoteDirectories: Map<string, { uuid: string; parent: string }>,
		onProgress: (done: number) => void
	): Promise<void> {
		const semaphore = new Semaphore(4)
		let done = 0
		const total = deltas.toDownload.length + deltas.toUpload.length + deltas.toDeleteLocal.length + deltas.toDeleteRemote.length

		useFolderSyncStore.getState().setSyncPairState(pair.id, {
			progress: { done: 0, total }
		})

		// 1. Create local directories
		for (const dirPath of deltas.toMkdirLocal) {
			try {
				await this.resolveOrCreateSafPath(pair.localUri, dirPath, false)
			} catch (e) {
				console.error(`[FolderSync] Failed to create local dir ${dirPath}:`, e)
			}
		}

		// 2. Create remote directories
		const createdRemoteDirs = new Map<string, string>() // relativePath → uuid

		for (const { relativePath, parentUUID } of deltas.toMkdirRemote) {
			if (remoteDirectories.has(relativePath)) {
				createdRemoteDirs.set(relativePath, remoteDirectories.get(relativePath)!.uuid)

				continue
			}

			try {
				const dirName = pathModule.posix.basename(relativePath)
				const parentDir = pathModule.posix.dirname(relativePath)
				const effectiveParent = parentDir === "." ? parentUUID : (createdRemoteDirs.get(parentDir) ?? parentUUID)
				const result = await nodeWorker.proxy("createDirectory", {
					name: dirName,
					parent: effectiveParent
				})

				createdRemoteDirs.set(relativePath, result)
			} catch (e) {
				console.error(`[FolderSync] Failed to create remote dir ${relativePath}:`, e)
			}
		}

		// 3. Download files from cloud to local
		await Promise.all(
			deltas.toDownload.map(async remoteEntry => {
				await semaphore.acquire()

				try {
					// Download to temp file first, then copy to SAF
					const tempPath = pathModule.posix.join(paths.temporaryDownloads(), randomUUID())
					const tempFile = new FileSystem.File(tempPath)

					if (!tempFile.parentDirectory.exists) {
						tempFile.parentDirectory.create({ intermediates: true })
					}

					tempFile.create()

					await getSDK()
						.cloud()
						.downloadFileToReadableStream({
							uuid: remoteEntry.uuid,
							bucket: remoteEntry.bucket,
							region: remoteEntry.region,
							chunks: remoteEntry.chunks,
							version: remoteEntry.version,
							key: remoteEntry.key,
							size: remoteEntry.size
						})
						.pipeThrough(
							new TransformStream({
								transform(chunk, controller) {
									controller.enqueue(new Uint8Array(chunk))
								}
							})
						)
						.pipeTo(tempFile.writableStream())

					// Now write to SAF destination
					// First try to delete existing file at the SAF path
					const existingSafUri = await this.findSafFileUri(pair.localUri, remoteEntry.relativePath)

					if (existingSafUri) {
						try {
							await FileSystemLegacy.deleteAsync(existingSafUri, { idempotent: true })
						} catch {
							// Ignore delete errors
						}
					}

					// Create the SAF file and write the downloaded content into it
					const safFileUri = await this.resolveOrCreateSafPath(pair.localUri, remoteEntry.relativePath, true)
					const base64Content = await FileSystemLegacy.readAsStringAsync(tempFile.uri, {
						encoding: FileSystemLegacy.EncodingType.Base64
					})

					await FileSystemLegacy.writeAsStringAsync(safFileUri, base64Content, {
						encoding: FileSystemLegacy.EncodingType.Base64
					})

					// Clean up temp file
					if (tempFile.exists) {
						tempFile.delete()
					}

					done++
					onProgress(done)
				} catch (e) {
					console.error(`[FolderSync] Failed to download ${remoteEntry.relativePath}:`, e)
				} finally {
					semaphore.release()
				}
			})
		)

		// 4. Upload files from local to cloud
		await Promise.all(
			deltas.toUpload.map(async uploadEntry => {
				await semaphore.acquire()

				try {
					// Find the SAF URI for this file
					const safUri = await this.findSafFileUri(pair.localUri, uploadEntry.relativePath)

					if (!safUri) {
						console.error(`[FolderSync] Local file not found for upload: ${uploadEntry.relativePath}`)

						return
					}

					// Read SAF file and write to temp location for upload
					const tempPath = pathModule.posix.join(paths.temporaryUploads(), randomUUID())
					const tempFile = new FileSystem.File(tempPath)

					if (!tempFile.parentDirectory.exists) {
						tempFile.parentDirectory.create({ intermediates: true })
					}

					const base64Content = await FileSystemLegacy.readAsStringAsync(safUri, {
						encoding: FileSystemLegacy.EncodingType.Base64
					})

					await FileSystemLegacy.writeAsStringAsync(tempFile.uri, base64Content, {
						encoding: FileSystemLegacy.EncodingType.Base64
					})

					// Determine the parent UUID in cloud
					const parentDir = pathModule.posix.dirname(uploadEntry.relativePath)
					const parentUUID = parentDir === "."
						? pair.remoteUUID
						: (createdRemoteDirs.get(parentDir) ?? remoteDirectories.get(parentDir)?.uuid ?? pair.remoteUUID)

					const fileName = pathModule.posix.basename(uploadEntry.relativePath)

					await nodeWorker.proxy("uploadFile", {
						id: randomUUID(),
						localPath: tempFile.uri,
						parent: parentUUID,
						name: fileName,
						size: uploadEntry.size,
						lastModified: uploadEntry.lastModified,
						isShared: false
					})

					// Clean up temp file
					if (tempFile.exists) {
						tempFile.delete()
					}

					done++
					onProgress(done)
				} catch (e) {
					console.error(`[FolderSync] Failed to upload ${uploadEntry.relativePath}:`, e)
				} finally {
					semaphore.release()
				}
			})
		)

		// 5. Delete local files
		for (const relPath of deltas.toDeleteLocal) {
			try {
				const safUri = await this.findSafFileUri(pair.localUri, relPath)

				if (safUri) {
					await FileSystemLegacy.deleteAsync(safUri, { idempotent: true })
				}

				done++
				onProgress(done)
			} catch (e) {
				console.error(`[FolderSync] Failed to delete local ${relPath}:`, e)
			}
		}

		// 6. Delete remote files
		for (const { uuid } of deltas.toDeleteRemote) {
			try {
				await nodeWorker.proxy("trashFile", { uuid })

				done++
				onProgress(done)
			} catch (e) {
				console.error(`[FolderSync] Failed to trash remote file ${uuid}:`, e)
			}
		}
	}

	/**
	 * Run a full sync cycle for a given sync pair.
	 */
	public async runSync(pairId: string): Promise<void> {
		if (this.runningSyncs.has(pairId)) {
			return
		}

		this.runningSyncs.add(pairId)

		const { setSyncPairState } = useFolderSyncStore.getState()

		setSyncPairState(pairId, {
			status: "syncing",
			error: null,
			progress: { done: 0, total: 0 }
		})

		try {
			const pair = await sqlite.syncPairs.get(pairId)

			if (!pair || pair.paused) {
				return
			}

			// 1. Scan both trees
			const [localTree, { files: remoteFiles, directories: remoteDirectories }] = await Promise.all([
				this.scanLocalTree(pair.localUri, pair.excludeDotFiles),
				this.scanRemoteTree(pair.remoteUUID, pair.excludeDotFiles)
			])

			// 2. Load previous state
			const { local: prevLocal, remote: prevRemote } = await sqlite.syncState.load(pairId)

			// 3. Compute deltas
			const deltas = this.computeDeltas(
				localTree,
				remoteFiles,
				remoteDirectories,
				prevLocal,
				prevRemote,
				pair.remoteUUID
			)

			const totalOps = deltas.toDownload.length + deltas.toUpload.length + deltas.toDeleteLocal.length + deltas.toDeleteRemote.length

			if (totalOps === 0) {
				// No changes needed, just update state
				await this.saveCurrentState(pairId, localTree, remoteFiles)

				setSyncPairState(pairId, {
					status: "idle",
					lastSynced: Date.now(),
					progress: { done: 0, total: 0 }
				})

				return
			}

			// 4. Apply changes
			await this.applyChanges(deltas, pair, remoteDirectories, done => {
				setSyncPairState(pairId, {
					progress: { done, total: totalOps }
				})
			})

			// 5. Re-scan and save updated state
			const [newLocalTree, { files: newRemoteFiles }] = await Promise.all([
				this.scanLocalTree(pair.localUri, pair.excludeDotFiles),
				this.scanRemoteTree(pair.remoteUUID, pair.excludeDotFiles)
			])

			await this.saveCurrentState(pairId, newLocalTree, newRemoteFiles)

			setSyncPairState(pairId, {
				status: "idle",
				lastSynced: Date.now(),
				progress: { done: totalOps, total: totalOps }
			})
		} catch (e) {
			console.error(`[FolderSync] Sync failed for pair ${pairId}:`, e)

			setSyncPairState(pairId, {
				status: "error",
				error: e instanceof Error ? e.message : "Unknown error"
			})
		} finally {
			this.runningSyncs.delete(pairId)
		}
	}

	/**
	 * Save the current state of both trees as the "previous state" for the next sync.
	 */
	private async saveCurrentState(
		syncPairId: string,
		localTree: Map<string, LocalFileEntry>,
		remoteFiles: Map<string, RemoteFileEntry>
	): Promise<void> {
		await sqlite.syncState.clear(syncPairId)

		const entries: SyncStateRow[] = []

		for (const [relPath, entry] of localTree) {
			entries.push({
				syncPairId,
				relativePath: relPath,
				size: entry.size,
				lastModified: entry.lastModified,
				side: "local",
				fileUUID: null
			})
		}

		for (const [relPath, entry] of remoteFiles) {
			entries.push({
				syncPairId,
				relativePath: relPath,
				size: entry.size,
				lastModified: entry.lastModified,
				side: "remote",
				fileUUID: entry.uuid
			})
		}

		await sqlite.syncState.save(entries)
	}

	/**
	 * Run sync for all configured, non-paused pairs.
	 */
	public async syncAll(): Promise<void> {
		const pairs = await sqlite.syncPairs.list()

		await Promise.all(
			pairs
				.filter(p => !p.paused)
				.map(p => this.runSync(p.id))
		)
	}

	/**
	 * Start periodic auto-sync (every 5 minutes).
	 */
	public startAutoSync(): void {
		if (this.autoSyncInterval) {
			return
		}

		this.autoSyncInterval = setInterval(() => {
			this.syncAll().catch(e => {
				console.error("[FolderSync] Auto-sync error:", e)
			})
		}, 5 * 60 * 1000)
	}

	/**
	 * Stop periodic auto-sync.
	 */
	public stopAutoSync(): void {
		if (this.autoSyncInterval) {
			clearInterval(this.autoSyncInterval)

			this.autoSyncInterval = null
		}
	}

	/**
	 * Remove a sync pair and clean up its state.
	 */
	public async removeSyncPair(id: string): Promise<void> {
		this.runningSyncs.delete(id)

		await sqlite.syncPairs.remove(id)

		useFolderSyncStore.getState().removeSyncPair(id)
	}
}

export const folderSync = new FolderSync()

export default folderSync
