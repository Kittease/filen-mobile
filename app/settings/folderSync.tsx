import { memo, useMemo, useCallback, useEffect, useState } from "react"
import { Settings as SettingsComponent, IconView } from "@/components/settings"
import { translateMemoized } from "@/lib/i18n"
import sqlite from "@/lib/sqlite"
import folderSync from "@/lib/folderSync"
import { useFolderSyncStore, getDefaultRuntimeState, type SyncPairConfig } from "@/stores/folderSync.store"
import { useShallow } from "zustand/shallow"
import events from "@/lib/events"
import { alertPrompt } from "@/components/prompts/alertPrompt"
import alerts from "@/lib/alerts"
import type { SettingsItem } from "@/components/settings"

export const FolderSyncSettings = memo(() => {
	const [pairs, setPairs] = useState<SyncPairConfig[]>([])
	const [loading, setLoading] = useState(true)
	const syncPairsState = useFolderSyncStore(useShallow(state => state.syncPairs))

	const loadPairs = useCallback(async () => {
		try {
			const list = await sqlite.syncPairs.list()

			setPairs(list)
		} catch (e) {
			console.error("[FolderSyncSettings] Failed to load pairs:", e)
		} finally {
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		loadPairs()

		const sub = events.subscribe("folderSyncSheet", e => {
			if (e.type === "closed") {
				loadPairs()
			}
		})

		return () => {
			sub.remove()
		}
	}, [loadPairs])

	const syncAll = useCallback(async () => {
		folderSync.syncAll().catch(e => {
			console.error("[FolderSyncSettings] Sync all error:", e)
		})
	}, [])

	const removePair = useCallback(
		async (pair: SyncPairConfig) => {
			const result = await alertPrompt({
				title: translateMemoized("sheets.folderSync.removeConfirmTitle"),
				message: translateMemoized("sheets.folderSync.removeConfirm")
			})

			if (result.cancelled) {
				return
			}

			await folderSync.removeSyncPair(pair.id)

			alerts.normal(translateMemoized("sheets.folderSync.removed"))

			loadPairs()
		},
		[loadPairs]
	)

	const getStatusText = useCallback(
		(pair: SyncPairConfig): string => {
			const state = syncPairsState[pair.id] ?? getDefaultRuntimeState()

			if (state.status === "syncing") {
				return translateMemoized("settings.folderSync.syncing")
					.replace("{{done}}", String(state.progress.done))
					.replace("{{total}}", String(state.progress.total))
			}

			if (state.status === "error") {
				return translateMemoized("settings.folderSync.error").replace("{{message}}", state.error ?? "Unknown")
			}

			if (state.lastSynced) {
				return translateMemoized("settings.folderSync.lastSynced").replace(
					"{{time}}",
					new Date(state.lastSynced).toLocaleString()
				)
			}

			return translateMemoized("settings.folderSync.neverSynced")
		},
		[syncPairsState]
	)

	const items = useMemo((): SettingsItem[] => {
		if (pairs.length === 0) {
			return [
				{
					id: "empty",
					title: translateMemoized("settings.folderSync.empty"),
					leftView: (
						<IconView
							name="information-outline"
							className="bg-gray-400"
						/>
					)
				}
			]
		}

		const result: SettingsItem[] = [
			{
				id: "sync-all",
				testID: "settings.folderSync.syncAll",
				title: translateMemoized("settings.folderSync.syncAll"),
				onPress: syncAll,
				leftView: (
					<IconView
						name="sync"
						className="bg-blue-500"
					/>
				)
			},
			"gap-header"
		]

		for (const pair of pairs) {
			const localName = decodeURIComponent(pair.localUri).split("/").pop() ?? pair.localUri

			result.push({
				id: pair.id,
				testID: `settings.folderSync.pair.${pair.id}`,
				title: pair.remoteName,
				subTitle: `${localName} — ${getStatusText(pair)}`,
				onPress: () => {
					removePair(pair)
				},
				leftView: (
					<IconView
						name="folder-sync-outline"
						className="bg-green-500"
					/>
				)
			})
		}

		return result
	}, [pairs, syncAll, getStatusText, removePair])

	return (
		<SettingsComponent
			title={translateMemoized("settings.folderSync.title")}
			iosBackButtonTitle={translateMemoized("settings.folderSync.back")}
			showSearchBar={false}
			loading={loading}
			items={items}
		/>
	)
})

FolderSyncSettings.displayName = "FolderSyncSettings"

export default FolderSyncSettings
