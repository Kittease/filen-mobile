import { create } from "zustand"

export type FolderSyncProgress = {
	done: number
	count: number
}

export type FolderSyncStore = {
	running: boolean
	progress: FolderSyncProgress
	lastError: string | null
	setRunning: (fn: boolean | ((prev: boolean) => boolean)) => void
	setProgress: (fn: FolderSyncProgress | ((prev: FolderSyncProgress) => FolderSyncProgress)) => void
	setLastError: (error: string | null) => void
}

export const useFolderSyncStore = create<FolderSyncStore>(set => ({
	running: false,
	progress: {
		done: 0,
		count: 0
	},
	lastError: null,
	setRunning(fn) {
		set(state => ({
			running: typeof fn === "function" ? fn(state.running) : fn
		}))
	},
	setProgress(fn) {
		set(state => ({
			progress: typeof fn === "function" ? fn(state.progress) : fn
		}))
	},
	setLastError(error) {
		set({ lastError: error })
	}
}))
