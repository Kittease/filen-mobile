import mmkvInstance from "@/lib/mmkv"
import { useMMKVObject } from "react-native-mmkv"
import { useMemo, useCallback } from "react"

export const FOLDER_SYNC_MMKV_KEY: string = "folderSyncState"

export type FolderSyncPair = {
	id: string
	localUri: string // SAF tree URI
	localName: string // Display name of the local folder
	remoteUUID: string // Filen cloud folder UUID
	remotePath: string // Display path of the remote folder
}

export type FolderSync = {
	enabled: boolean
	pairs: FolderSyncPair[]
	cellular: boolean
	lowBattery: boolean
	background: boolean
	deleteSync: boolean // Whether to propagate deletions
	// Version is used to abort running sync when settings change
	version: number
}

export const EMPTY_STATE: FolderSync = {
	enabled: false,
	pairs: [],
	cellular: false,
	lowBattery: false,
	background: false,
	deleteSync: false,
	version: 1
}

export function getFolderSyncState(): FolderSync {
	const data = mmkvInstance.getString(FOLDER_SYNC_MMKV_KEY)

	if (!data) {
		return EMPTY_STATE
	}

	return JSON.parse(data) as FolderSync
}

export function setFolderSyncState(fn: FolderSync | ((prev: FolderSync) => FolderSync)) {
	if (typeof fn === "function") {
		mmkvInstance.set(FOLDER_SYNC_MMKV_KEY, JSON.stringify(fn(getFolderSyncState())))

		return
	}

	mmkvInstance.set(FOLDER_SYNC_MMKV_KEY, JSON.stringify(fn))
}

export default function useFolderSync(): [FolderSync, (value: FolderSync | ((prevValue: FolderSync) => FolderSync)) => void] {
	const [folderSync, setFolderSync] = useMMKVObject<FolderSync>(FOLDER_SYNC_MMKV_KEY, mmkvInstance)

	const state = useMemo((): FolderSync => {
		if (!folderSync) {
			return EMPTY_STATE
		}

		return folderSync
	}, [folderSync])

	const setState = useCallback(
		(fn: FolderSync | ((prev: FolderSync) => FolderSync)) => {
			if (typeof fn === "function") {
				setFolderSync(prev => fn(prev ?? EMPTY_STATE))

				return
			}

			setFolderSync(fn)
		},
		[setFolderSync]
	)

	return [state, setState]
}
