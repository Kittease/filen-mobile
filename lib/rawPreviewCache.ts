import { Semaphore } from "./semaphore"
import download from "./download"
import paths from "./paths"
import { normalizeFilePathForExpo } from "./utils"
import { RAW_IMAGE_EXTENSIONS } from "./constants"
import { randomUUID } from "expo-crypto"
import * as FileSystem from "expo-file-system"
import pathModule from "path"
import { Platform } from "react-native"

let extractRawPreview: ((inputPath: string, outputPath: string) => Promise<void>) | null = null

if (Platform.OS === "android") {
	try {
		const mod = require("@/modules/raw-image-converter")

		extractRawPreview = mod.extractRawPreview
	} catch {}
}

/**
 * Cache for extracted RAW image JPEG previews, keyed by file UUID.
 * Prevents re-downloading and re-extracting RAW files that have already been processed.
 */
class RawPreviewCache {
	private readonly cache = new Map<string, string>()
	private readonly semaphore = new Semaphore(2)
	private readonly uuidMutex: Record<string, Semaphore> = {}
	private readonly inFlight = new Set<string>()

	/**
	 * Returns the cached JPEG preview path for a RAW file, or null if not cached.
	 */
	public get(uuid: string): string | null {
		const cached = this.cache.get(uuid)

		if (!cached) {
			return null
		}

		try {
			const file = new FileSystem.File(normalizeFilePathForExpo(cached))

			if (file.exists) {
				return cached
			}
		} catch {}

		this.cache.delete(uuid)

		return null
	}

	/**
	 * Returns true if the file is a RAW image that can be prefetched on this platform.
	 */
	public canPrefetch(name: string): boolean {
		if (Platform.OS !== "android" || !extractRawPreview) {
			return false
		}

		return RAW_IMAGE_EXTENSIONS.includes(pathModule.posix.extname(name.trim().toLowerCase()))
	}

	/**
	 * Prefetch a RAW file: download, extract JPEG preview, cache the result.
	 * Uses per-UUID mutex to prevent duplicate work and a global semaphore to limit concurrency.
	 */
	public async prefetch(item: DriveCloudItem): Promise<string | null> {
		if (item.type !== "file" || !this.canPrefetch(item.name) || !extractRawPreview) {
			return null
		}

		// Already cached
		const existing = this.get(item.uuid)

		if (existing) {
			return existing
		}

		// Already in flight
		if (this.inFlight.has(item.uuid)) {
			return null
		}

		if (!this.uuidMutex[item.uuid]) {
			this.uuidMutex[item.uuid] = new Semaphore(1)
		}

		const uuidMutex = this.uuidMutex[item.uuid]!

		await Promise.all([this.semaphore.acquire(), uuidMutex.acquire()])

		this.inFlight.add(item.uuid)

		try {
			// Check again after acquiring locks
			const existingAfterLock = this.get(item.uuid)

			if (existingAfterLock) {
				return existingAfterLock
			}

			const id = randomUUID()
			const extname = pathModule.posix.extname(item.name)
			const tempDir = paths.temporaryDownloads()
			const rawPath = pathModule.posix.join(tempDir, `${id}${extname}`)
			const jpegOutputPath = pathModule.posix.join(tempDir, `${item.uuid}_rawcache.jpg`)

			try {
				await download.file.foreground({
					id,
					uuid: item.uuid,
					bucket: item.bucket,
					region: item.region,
					chunks: item.chunks,
					version: item.version,
					key: item.key,
					destination: normalizeFilePathForExpo(rawPath),
					size: item.size,
					name: item.name,
					dontEmitProgress: true
				})

				await extractRawPreview(rawPath, jpegOutputPath)

				// Delete the large RAW file immediately, keep only the JPEG
				try {
					const rawFile = new FileSystem.File(normalizeFilePathForExpo(rawPath))

					if (rawFile.exists) {
						rawFile.delete()
					}
				} catch {}

				this.cache.set(item.uuid, jpegOutputPath)

				return jpegOutputPath
			} catch (e) {
				// Clean up on failure
				for (const p of [rawPath, jpegOutputPath]) {
					try {
						const f = new FileSystem.File(normalizeFilePathForExpo(p))

						if (f.exists) {
							f.delete()
						}
					} catch {}
				}

				throw e
			}
		} finally {
			this.inFlight.delete(item.uuid)
			this.semaphore.release()
			uuidMutex.release()
		}
	}

	/**
	 * Clear all cached RAW previews from memory.
	 * Disk files are cleaned up via paths.clearTempDirectories().
	 */
	public clear(): void {
		this.cache.clear()
	}
}

export const rawPreviewCache = new RawPreviewCache()

export default rawPreviewCache
