import { create } from "zustand"

export type SyncMode = "twoWay" | "localToCloud" | "cloudToLocal" | "localBackup" | "cloudBackup"

export type SyncPairConfig = {
	id: string
	remoteUUID: string
	remotePath: string
	remoteName: string
	localUri: string
	mode: SyncMode
	paused: boolean
	excludeDotFiles: boolean
	createdAt: number
}

export type SyncPairRuntimeState = {
	status: "idle" | "syncing" | "error"
	progress: { done: number; total: number }
	lastSynced: number | null
	error: string | null
}

export type FolderSyncStore = {
	syncPairs: Record<string, SyncPairRuntimeState>
	setSyncPairState: (id: string, update: Partial<SyncPairRuntimeState>) => void
	removeSyncPair: (id: string) => void
	reset: () => void
}

const defaultRuntimeState: SyncPairRuntimeState = {
	status: "idle",
	progress: { done: 0, total: 0 },
	lastSynced: null,
	error: null
}

export function getDefaultRuntimeState(): SyncPairRuntimeState {
	return { ...defaultRuntimeState }
}

export const useFolderSyncStore = create<FolderSyncStore>(set => ({
	syncPairs: {},
	setSyncPairState(id, update) {
		set(state => ({
			syncPairs: {
				...state.syncPairs,
				[id]: {
					...(state.syncPairs[id] ?? getDefaultRuntimeState()),
					...update
				}
			}
		}))
	},
	removeSyncPair(id) {
		set(state => {
			const { [id]: _, ...rest } = state.syncPairs

			return { syncPairs: rest }
		})
	},
	reset() {
		set({ syncPairs: {} })
	}
}))
