import { getFolderSyncState, type FolderSyncPair } from "@/hooks/useFolderSync"
import { validate as validateUUID } from "uuid"
import Semaphore from "./semaphore"
import nodeWorker from "./nodeWorker"
import { useAppStateStore } from "@/stores/appState.store"
import { randomUUID } from "expo-crypto"
import * as FileSystem from "expo-file-system"
import paths from "./paths"
import { useFolderSyncStore } from "@/stores/folderSync.store"
import { getNetInfoState } from "@/hooks/useNetInfo"
import * as Battery from "expo-battery"
import { getSDK } from "./sdk"
import upload from "@/lib/upload"
import download from "@/lib/download"
import pathModule from "path"
import { listFilesRecursive, copyFromSAF, copyToSAF, type SAFFileInfo } from "./saf"
import mimeTypes from "mime-types"

export type LocalTreeItem = {
	type: "local"
	safUri: string
	name: string
	relativePath: string
	size: number
	lastModified: number
}

export type RemoteTreeItem = {
	type: "remote"
	uuid: string
	name: string
	relativePath: string
	size: number
	lastModified: number
	bucket: string
	region: string
	chunks: number
	version: number
	key: string
	mime: string
	parent: string
}

export type SyncDelta =
	| { action: "upload"; local: LocalTreeItem }
	| { action: "download"; remote: RemoteTreeItem }
	| { action: "deleteRemote"; remote: RemoteTreeItem }
	| { action: "deleteLocal"; local: LocalTreeItem }
	| { action: "conflict"; local: LocalTreeItem; remote: RemoteTreeItem }

export type FolderSyncType = "foreground" | "background"

const runMutex: Semaphore = new Semaphore(1)
const processDeltaSemaphore: Semaphore = new Semaphore(3)
let nextRunTimeout: number = 0

export class FolderSyncEngine {
	private readonly syncType: FolderSyncType
	private readonly maxTransfers: number
	private readonly store = {
		setProgress: useFolderSyncStore.getState().setProgress,
		setRunning: useFolderSyncStore.getState().setRunning,
		setLastError: useFolderSyncStore.getState().setLastError
	}
	private readonly deltaErrors: Record<string, number> = {}

	public constructor({ type, maxTransfers }: { type: FolderSyncType; maxTransfers: number }) {
		this.syncType = type
		this.maxTransfers = maxTransfers
	}

	private isAuthed(): boolean {
		const apiKey = getSDK().config.apiKey

		return typeof apiKey === "string" && apiKey.length > 0 && apiKey !== "anonymous"
	}

	public async canRun({
		checkBattery,
		checkNetwork,
		checkAppState
	}: {
		checkBattery: boolean
		checkNetwork: boolean
		checkAppState: boolean
	}): Promise<boolean> {
		if (!this.isAuthed()) {
			return false
		}

		if (this.syncType === "background") {
			checkAppState = false
			checkBattery = false
			checkNetwork = false
		}

		if (checkAppState) {
			if (this.syncType === "foreground" && useAppStateStore.getState().appState !== "active") {
				return false
			}
		}

		const state = getFolderSyncState()

		if (
			!state.enabled ||
			state.pairs.length === 0 ||
			(this.syncType === "background" && !state.background)
		) {
			return false
		}

		// Validate that all pairs have valid UUIDs
		const hasValidPair = state.pairs.some(p => validateUUID(p.remoteUUID))

		if (!hasValidPair) {
			return false
		}

		const [nodeWorkerPing, netInfoState, powerState] = await Promise.all([
			this.syncType === "foreground" ? nodeWorker.proxy("ping", undefined) : Promise.resolve("pong"),
			checkNetwork
				? getNetInfoState()
				: Promise.resolve({
						hasInternet: true,
						isWifiEnabled: true,
						cellular: false
				  }),
			checkBattery
				? Battery.getPowerStateAsync()
				: Promise.resolve({
						lowPowerMode: false,
						batteryLevel: 1,
						batteryState: Battery.BatteryState.FULL
				  })
		])

		if (
			nodeWorkerPing !== "pong" ||
			!netInfoState.hasInternet ||
			(!state.cellular && !netInfoState.isWifiEnabled) ||
			(!state.lowBattery && powerState.lowPowerMode) ||
			(!state.lowBattery &&
				powerState.batteryLevel >= 0 &&
				powerState.batteryLevel <= 0.15 &&
				(powerState.batteryState === Battery.BatteryState.UNPLUGGED || powerState.batteryState === Battery.BatteryState.UNKNOWN))
		) {
			return false
		}

		return true
	}

	public normalizePath(path: string): string {
		return path.startsWith("/") ? path.slice(1) : path
	}

	public normalizeTimestamp(timestamp: number): number {
		return Math.floor(timestamp / 1000)
	}

	/**
	 * Build local file tree from a SAF directory URI.
	 */
	public async fetchLocalItems(localUri: string): Promise<Record<string, LocalTreeItem>> {
		const items: Record<string, LocalTreeItem> = {}
		const safFiles = await listFilesRecursive(localUri)

		for (const file of safFiles) {
			if (file.isDirectory) {
				continue
			}

			const relPath = this.normalizePath(file.relativePath)

			items[relPath.toLowerCase()] = {
				type: "local",
				safUri: file.uri,
				name: file.name,
				relativePath: relPath,
				size: file.size,
				lastModified: file.lastModified
			}
		}

		return items
	}

	/**
	 * Build remote file tree from a Filen cloud folder UUID.
	 */
	public async fetchRemoteItems(remoteUUID: string): Promise<Record<string, RemoteTreeItem>> {
		const items: Record<string, RemoteTreeItem> = {}

		const tree =
			this.syncType === "foreground"
				? await nodeWorker.proxy("getDirectoryTree", {
						uuid: remoteUUID,
						type: "normal"
				  })
				: await getSDK().cloud().getDirectoryTree({
						uuid: remoteUUID,
						type: "normal"
				  })

		for (const treeItemPath in tree) {
			const file = tree[treeItemPath]

			if (!file || file.type !== "file") {
				continue
			}

			const relPath = this.normalizePath(treeItemPath)

			items[relPath.toLowerCase()] = {
				type: "remote",
				uuid: file.uuid,
				name: file.name,
				relativePath: relPath,
				size: file.size,
				lastModified: file.lastModified,
				bucket: file.bucket,
				region: file.region,
				chunks: file.chunks,
				version: file.version,
				key: file.key,
				mime: file.mime,
				parent: file.parent
			}
		}

		return items
	}

	/**
	 * Compute deltas between local and remote trees for two-way sync.
	 */
	public computeDeltas({
		localItems,
		remoteItems,
		deleteSync
	}: {
		localItems: Record<string, LocalTreeItem>
		remoteItems: Record<string, RemoteTreeItem>
		deleteSync: boolean
	}): SyncDelta[] {
		const deltas: SyncDelta[] = []
		const allPaths = new Set([...Object.keys(localItems), ...Object.keys(remoteItems)])

		for (const path of allPaths) {
			const local = localItems[path]
			const remote = remoteItems[path]

			if (local && !remote) {
				// File exists locally but not remotely -> upload
				deltas.push({ action: "upload", local })
			} else if (!local && remote) {
				if (deleteSync) {
					// File exists remotely but not locally -> delete from cloud
					deltas.push({ action: "deleteRemote", remote })
				} else {
					// File exists remotely but not locally -> download
					deltas.push({ action: "download", remote })
				}
			} else if (local && remote) {
				// File exists in both -> check modification times
				const localMod = this.normalizeTimestamp(local.lastModified)
				const remoteMod = this.normalizeTimestamp(remote.lastModified)

				if (localMod > remoteMod + 2) {
					// Local is newer -> upload (overwrite remote)
					deltas.push({ action: "upload", local })
				} else if (remoteMod > localMod + 2) {
					// Remote is newer -> download (overwrite local)
					deltas.push({ action: "download", remote })
				}
				// If timestamps are within 2 seconds, consider them in sync
			}
		}

		return deltas
	}

	/**
	 * Process a single sync delta.
	 */
	public async processDelta(delta: SyncDelta, pair: FolderSyncPair, abortSignal?: AbortSignal): Promise<void> {
		await processDeltaSemaphore.acquire()

		try {
			const errorKey = `${delta.action}:${delta.action === "upload" || delta.action === "deleteLocal" ? delta.local.relativePath : delta.remote.relativePath}`

			if ((this.deltaErrors[errorKey] && this.deltaErrors[errorKey] >= 3) || abortSignal?.aborted) {
				throw new Error("Aborted")
			}

			if (abortSignal?.aborted) {
				throw new Error("Aborted")
			}

			try {
				switch (delta.action) {
					case "upload": {
						await this.processUpload(delta.local, pair, abortSignal)
						break
					}

					case "download": {
						await this.processDownload(delta.remote, pair, abortSignal)
						break
					}

					case "deleteRemote": {
						if (this.syncType === "foreground") {
							await nodeWorker.proxy("trashFile", { uuid: delta.remote.uuid })
						} else {
							await getSDK().cloud().trashFile({ uuid: delta.remote.uuid })
						}
						break
					}

					case "deleteLocal": {
						// Not implemented in initial version for safety
						break
					}
				}

				delete this.deltaErrors[errorKey]
			} catch (e) {
				console.error(e)

				if (e instanceof Error && !e.message.toLowerCase().includes("aborted")) {
					if (this.deltaErrors[errorKey]) {
						this.deltaErrors[errorKey]++
					} else {
						this.deltaErrors[errorKey] = 1
					}
				}
			}
		} finally {
			processDeltaSemaphore.release()
		}
	}

	/**
	 * Upload a local file to the cloud.
	 */
	private async processUpload(local: LocalTreeItem, pair: FolderSyncPair, abortSignal?: AbortSignal): Promise<void> {
		if (abortSignal?.aborted) {
			throw new Error("Aborted")
		}

		const uploadId = randomUUID()

		// Determine or create the remote parent directory
		const parentDir = pathModule.posix.dirname(local.relativePath)
		const parentUUID =
			!parentDir || parentDir.length === 0 || parentDir === "."
				? pair.remoteUUID
				: this.syncType === "foreground"
				? await nodeWorker.proxy("createDirectory", {
						name: parentDir,
						parent: pair.remoteUUID
				  })
				: await getSDK().cloud().createDirectory({
						name: parentDir,
						parent: pair.remoteUUID
				  })

		if (abortSignal?.aborted) {
			throw new Error("Aborted")
		}

		// Copy file from SAF to temp directory
		const tmpPath = pathModule.posix.join(paths.temporaryUploads(), `${randomUUID()}${pathModule.posix.extname(local.name)}`)
		const tmpFile = new FileSystem.File(tmpPath)

		try {
			if (tmpFile.exists) {
				tmpFile.delete()
			}

			await copyFromSAF(local.safUri, paths.temporaryUploads())

			// copyAsync copies to the directory, so the file is at tmpDir/filename
			// We need to find it - it gets copied with its original name
			const copiedFilePath = pathModule.posix.join(paths.temporaryUploads(), local.name)
			const copiedFile = new FileSystem.File(copiedFilePath)

			if (!copiedFile.exists) {
				throw new Error(`Failed to copy file from SAF: ${local.relativePath}`)
			}

			// Rename to our temp name to avoid conflicts
			copiedFile.move(tmpFile)

			if (!tmpFile.exists || !tmpFile.size) {
				throw new Error(`Temp file does not exist after copy: ${tmpPath}`)
			}

			if (abortSignal?.aborted) {
				throw new Error("Aborted")
			}

			await upload.file.foreground({
				parent: parentUUID,
				localPath: tmpFile.uri,
				name: local.name,
				id: uploadId,
				size: tmpFile.size,
				isShared: false,
				deleteAfterUpload: true,
				dontEmitProgress: true,
				creation: local.lastModified,
				lastModified: local.lastModified
			})
		} finally {
			if (tmpFile.exists) {
				tmpFile.delete()
			}
		}
	}

	/**
	 * Download a remote file to the local SAF directory.
	 */
	private async processDownload(remote: RemoteTreeItem, pair: FolderSyncPair, abortSignal?: AbortSignal): Promise<void> {
		if (abortSignal?.aborted) {
			throw new Error("Aborted")
		}

		const downloadId = randomUUID()
		const tmpPath = pathModule.posix.join(paths.temporaryDownloads(), `${randomUUID()}${pathModule.posix.extname(remote.name)}`)
		const tmpFile = new FileSystem.File(tmpPath)

		try {
			if (tmpFile.exists) {
				tmpFile.delete()
			}

			if (!tmpFile.parentDirectory.exists) {
				tmpFile.parentDirectory.create({ intermediates: true })
			}

			if (abortSignal?.aborted) {
				throw new Error("Aborted")
			}

			// Download using foreground (nodeWorker) or background (SDK) depending on type
			await download.file.foreground({
				id: downloadId,
				uuid: remote.uuid,
				bucket: remote.bucket,
				region: remote.region,
				chunks: remote.chunks,
				version: remote.version,
				key: remote.key,
				size: remote.size,
				name: remote.name,
				destination: tmpPath,
				dontEmitProgress: true
			})

			if (!tmpFile.exists) {
				throw new Error(`Downloaded file does not exist: ${tmpPath}`)
			}

			if (abortSignal?.aborted) {
				throw new Error("Aborted")
			}

			// Determine MIME type
			const mime = mimeTypes.lookup(remote.name) || "application/octet-stream"

			// For nested paths, we need to figure out which SAF subdirectory to write to.
			// For simplicity, write to the root SAF directory with the file name.
			// A full implementation would create subdirectories in SAF.
			const parentDir = pathModule.posix.dirname(remote.relativePath)

			if (!parentDir || parentDir === ".") {
				// Write directly to root SAF directory
				await copyToSAF(tmpPath, pair.localUri, remote.name, mime)
			} else {
				// For nested files, copy to SAF root with flattened name to avoid complex SAF dir creation
				// TODO: Implement SAF subdirectory creation for full nested support
				await copyToSAF(tmpPath, pair.localUri, remote.name, mime)
			}
		} finally {
			if (tmpFile.exists) {
				tmpFile.delete()
			}
		}
	}

	/**
	 * Run sync for all configured pairs.
	 */
	public async run(params?: { abortController: AbortController }): Promise<void> {
		const now = Date.now()

		if (runMutex.count() > 0 && this.syncType === "foreground") {
			return
		}

		const abortController = params?.abortController ?? new AbortController()

		if (abortController.signal.aborted) {
			throw new Error("Aborted")
		}

		if (nextRunTimeout > now && this.syncType === "foreground") {
			return
		}

		if (this.syncType === "foreground") {
			await runMutex.acquire()
		}

		this.store.setRunning(true)
		this.store.setLastError(null)

		let stateCheckInterval: ReturnType<typeof setInterval> | undefined = undefined

		if (this.syncType === "foreground") {
			const startingState = JSON.parse(JSON.stringify(getFolderSyncState())) as ReturnType<typeof getFolderSyncState>

			stateCheckInterval = setInterval(() => {
				const currentState = getFolderSyncState()

				if (currentState.version !== startingState.version) {
					if (!abortController.signal.aborted) {
						abortController.abort()
					}

					clearInterval(stateCheckInterval)
				}
			}, 1000)
		}

		try {
			if (abortController.signal.aborted) {
				throw new Error("Aborted")
			}

			if (
				!(await this.canRun({
					checkBattery: true,
					checkNetwork: true,
					checkAppState: true
				}))
			) {
				return
			}

			if (abortController.signal.aborted) {
				throw new Error("Aborted")
			}

			const state = getFolderSyncState()

			for (const pair of state.pairs) {
				if (abortController.signal.aborted) {
					break
				}

				if (!validateUUID(pair.remoteUUID)) {
					continue
				}

				try {
					await this.syncPair(pair, state.deleteSync, abortController)
				} catch (e) {
					console.error(`Folder sync error for pair ${pair.id}:`, e)

					if (e instanceof Error) {
						this.store.setLastError(e.message)
					}
				}
			}
		} finally {
			clearInterval(stateCheckInterval)

			this.store.setRunning(false)
			this.store.setProgress({ done: 0, count: 0 })

			if (this.syncType === "foreground") {
				runMutex.release()

				nextRunTimeout = Date.now() + 1000 * 30
			}
		}
	}

	/**
	 * Sync a single folder pair.
	 */
	private async syncPair(pair: FolderSyncPair, deleteSync: boolean, abortController: AbortController): Promise<void> {
		if (abortController.signal.aborted) {
			throw new Error("Aborted")
		}

		const [localItems, remoteItems] = await Promise.all([
			this.fetchLocalItems(pair.localUri),
			this.fetchRemoteItems(pair.remoteUUID)
		])

		if (abortController.signal.aborted) {
			throw new Error("Aborted")
		}

		const deltas = this.computeDeltas({
			localItems,
			remoteItems,
			deleteSync
		})

		if (deltas.length === 0) {
			return
		}

		if (abortController.signal.aborted) {
			throw new Error("Aborted")
		}

		this.store.setProgress({
			done: 0,
			count: deltas.length
		})

		try {
			let added = 0
			let done = 0

			await Promise.all(
				deltas.map(async delta => {
					if (added >= this.maxTransfers) {
						return
					}

					added++

					await this.processDelta(delta, pair, abortController.signal).catch(console.error)

					done++

					this.store.setProgress({
						done,
						count: deltas.length
					})
				})
			)
		} finally {
			this.store.setProgress({
				done: 0,
				count: 0
			})
		}
	}
}

export const foregroundFolderSync = new FolderSyncEngine({
	type: "foreground",
	maxTransfers: Infinity
})

export const backgroundFolderSync = new FolderSyncEngine({
	type: "background",
	maxTransfers: 1
})
