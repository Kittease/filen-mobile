import * as FileSystemLegacy from "expo-file-system/legacy"
import { Platform } from "react-native"

const SAF = FileSystemLegacy.StorageAccessFramework

export type SAFFileInfo = {
	uri: string
	name: string
	relativePath: string
	size: number
	lastModified: number
	isDirectory: boolean
}

/**
 * Request the user to pick a directory via Android's Storage Access Framework.
 * Returns the granted tree URI or null if the user cancelled.
 */
export async function pickDirectory(): Promise<string | null> {
	if (Platform.OS !== "android") {
		return null
	}

	const result = await SAF.requestDirectoryPermissionsAsync()

	if (!result.granted) {
		return null
	}

	return result.directoryUri
}

/**
 * List all files (recursively) in a SAF directory tree.
 * Returns flat list of file info objects with relative paths.
 */
export async function listFilesRecursive(treeUri: string, basePath: string = ""): Promise<SAFFileInfo[]> {
	const items: SAFFileInfo[] = []
	const childUris = await SAF.readDirectoryAsync(treeUri)

	for (const childUri of childUris) {
		const info = await FileSystemLegacy.getInfoAsync(childUri, { size: true })

		if (!info.exists) {
			continue
		}

		const decodedUri = decodeURIComponent(childUri)
		const name = decodedUri.split("/").pop() ?? decodedUri.split("%2F").pop() ?? ""

		if (info.isDirectory) {
			const dirRelPath = basePath ? `${basePath}/${name}` : name

			items.push({
				uri: childUri,
				name,
				relativePath: dirRelPath,
				size: 0,
				lastModified: info.modificationTime ? info.modificationTime * 1000 : 0,
				isDirectory: true
			})

			const children = await listFilesRecursive(childUri, dirRelPath)
			items.push(...children)
		} else {
			items.push({
				uri: childUri,
				name,
				relativePath: basePath ? `${basePath}/${name}` : name,
				size: info.size ?? 0,
				lastModified: info.modificationTime ? info.modificationTime * 1000 : 0,
				isDirectory: false
			})
		}
	}

	return items
}

/**
 * Copy a file from a SAF URI to a local app-private file path.
 */
export async function copyFromSAF(safUri: string, destPath: string): Promise<void> {
	await SAF.copyAsync({
		from: safUri,
		to: destPath
	})
}

/**
 * Copy a local file into a SAF directory, creating it with the given name.
 * Returns the URI of the newly created file.
 */
export async function copyToSAF(localPath: string, parentSafUri: string, fileName: string, mimeType: string): Promise<string> {
	const newFileUri = await SAF.createFileAsync(parentSafUri, fileName, mimeType)

	// Read local file as base64 and write to the SAF file
	const base64 = await FileSystemLegacy.readAsStringAsync(localPath, {
		encoding: FileSystemLegacy.EncodingType.Base64
	})

	await FileSystemLegacy.writeAsStringAsync(newFileUri, base64, {
		encoding: FileSystemLegacy.EncodingType.Base64
	})

	return newFileUri
}

/**
 * Create a subdirectory inside a SAF directory.
 * expo-file-system/legacy doesn't directly support creating subdirectories in SAF trees,
 * so we use makeDirectoryAsync with the SAF URI.
 */
export async function createDirectoryInSAF(parentUri: string, dirName: string): Promise<string> {
	// SAF.makeDirectoryAsync is available in expo-file-system legacy
	const newDirUri = await (SAF as any).makeDirectoryAsync(parentUri, dirName)

	return newDirUri as string
}

/**
 * Delete a file or directory from a SAF tree.
 */
export async function deleteFromSAF(uri: string): Promise<void> {
	await FileSystemLegacy.deleteAsync(uri, { idempotent: true })
}

export default {
	pickDirectory,
	listFilesRecursive,
	copyFromSAF,
	copyToSAF,
	createDirectoryInSAF,
	deleteFromSAF
}
