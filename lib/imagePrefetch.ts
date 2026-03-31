import TurboImage from "react-native-turbo-image"
import { Platform } from "react-native"
import { RAW_IMAGE_EXTENSIONS, TURBO_IMAGE_SUPPORTED_EXTENSIONS } from "./constants"
import pathModule from "path"
import nodeWorker from "./nodeWorker"
import { rawPreviewCache } from "./rawPreviewCache"

function isStandardImage(name: string): boolean {
	const ext = pathModule.posix.extname(name.trim().toLowerCase())

	return TURBO_IMAGE_SUPPORTED_EXTENSIONS.includes(ext)
}

function isRawImage(name: string): boolean {
	if (Platform.OS !== "android") {
		return false
	}

	const ext = pathModule.posix.extname(name.trim().toLowerCase())

	return RAW_IMAGE_EXTENSIONS.includes(ext)
}

function buildStreamURL(file: DriveCloudItem): string | null {
	if (!nodeWorker.httpServerPort || !nodeWorker.httpAuthToken || !nodeWorker.ready || nodeWorker.httpAuthToken.length === 0 || nodeWorker.httpServerPort <= 0) {
		return null
	}

	return `http://127.0.0.1:${nodeWorker.httpServerPort}/stream?auth=${nodeWorker.httpAuthToken}&file=${encodeURIComponent(
		btoa(
			JSON.stringify({
				mime: file.mime,
				size: file.size,
				uuid: file.uuid,
				bucket: file.bucket,
				key: file.key,
				version: file.version,
				chunks: file.chunks,
				region: file.region
			})
		)
	)}`
}

/**
 * Prefetch full-size images for the given items.
 * Standard images use TurboImage.prefetch (native disk cache).
 * RAW images use the rawPreviewCache (download + extract JPEG).
 *
 * Each prefetch goes through the local streaming server (cloud download + decrypt),
 * so we prefetch one at a time to avoid bandwidth contention.
 */
export function prefetchImages(items: DriveCloudItem[]): void {
	const standardSources: { uri: string }[] = []
	const rawItems: DriveCloudItem[] = []

	for (const item of items) {
		if (item.type !== "file" || item.size <= 0) {
			continue
		}

		if (isStandardImage(item.name)) {
			const url = buildStreamURL(item)

			if (url) {
				standardSources.push({ uri: url })
			}
		} else if (isRawImage(item.name)) {
			rawItems.push(item)
		}
	}

	// Prefetch standard images sequentially so the first (closest) image
	// finishes before we start downloading the next one.
	if (standardSources.length > 0) {
		let chain = Promise.resolve(false)

		for (const source of standardSources) {
			chain = chain.then(() => TurboImage.prefetch([source], "dataCache")).catch(() => false)
		}
	}

	// RAW prefetch already has its own concurrency limiter (semaphore of 2)
	for (const rawItem of rawItems) {
		rawPreviewCache.prefetch(rawItem).catch(() => {})
	}
}

export default prefetchImages
