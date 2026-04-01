import { memo, useRef, useEffect, useCallback, useState } from "react"
import { BottomSheetView } from "@gorhom/bottom-sheet"
import events from "@/lib/events"
import { randomUUID } from "expo-crypto"
import { View, BackHandler, Switch } from "react-native"
import { Button } from "../nativewindui/Button"
import { Text } from "../nativewindui/Text"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Sheet, useSheetRef } from "@/components/nativewindui/Sheet"
import { translateMemoized } from "@/lib/i18n"
import * as FileSystemLegacy from "expo-file-system/legacy"
import sqlite from "@/lib/sqlite"
import folderSync from "@/lib/folderSync"
import { useFolderSyncStore, type SyncPairConfig } from "@/stores/folderSync.store"
import alerts from "@/lib/alerts"
import { useShallow } from "zustand/shallow"
import { alertPrompt } from "@/components/prompts/alertPrompt"

export const FolderSyncSheet = memo(() => {
	const ref = useSheetRef()
	const [item, setItem] = useState<DriveCloudItem | null>(null)
	const [localUri, setLocalUri] = useState<string | null>(null)
	const [excludeDotFiles, setExcludeDotFiles] = useState(true)
	const [existingPair, setExistingPair] = useState<SyncPairConfig | null>(null)
	const isOpen = useRef(false)
	const insets = useSafeAreaInsets()

	const runtimeState = useFolderSyncStore(
		useShallow(state => (existingPair ? state.syncPairs[existingPair.id] : undefined))
	)

	const close = useCallback(() => {
		ref?.current?.forceClose()

		isOpen.current = false

		setItem(null)
		setLocalUri(null)
		setExistingPair(null)
		setExcludeDotFiles(true)

		events.emit("folderSyncSheet", { type: "closed" })
	}, [ref])

	const selectLocalFolder = useCallback(async () => {
		const result = await FileSystemLegacy.StorageAccessFramework.requestDirectoryPermissionsAsync()

		if (result.granted) {
			setLocalUri(result.directoryUri)
		}
	}, [])

	const startSync = useCallback(async () => {
		if (!item || !localUri) {
			alerts.normal(translateMemoized("sheets.folderSync.noFolderSelected"))

			return
		}

		const id = randomUUID()

		const pair: SyncPairConfig = {
			id,
			remoteUUID: item.uuid,
			remotePath: item.path ?? `/${item.name}`,
			remoteName: item.name,
			localUri,
			mode: "twoWay",
			paused: false,
			excludeDotFiles,
			createdAt: Date.now()
		}

		await sqlite.syncPairs.add(pair)

		setExistingPair(pair)

		alerts.normal(translateMemoized("sheets.folderSync.configured"))

		// Start the sync in background
		folderSync.runSync(id).catch(e => {
			console.error("[FolderSyncSheet] Sync error:", e)
		})
	}, [item, localUri, excludeDotFiles])

	const syncNow = useCallback(async () => {
		if (!existingPair) {
			return
		}

		folderSync.runSync(existingPair.id).catch(e => {
			console.error("[FolderSyncSheet] Sync error:", e)
		})
	}, [existingPair])

	const removeSync = useCallback(async () => {
		if (!existingPair) {
			return
		}

		const result = await alertPrompt({
			title: translateMemoized("sheets.folderSync.removeConfirmTitle"),
			message: translateMemoized("sheets.folderSync.removeConfirm")
		})

		if (result.cancelled) {
			return
		}

		await folderSync.removeSyncPair(existingPair.id)

		alerts.normal(translateMemoized("sheets.folderSync.removed"))

		close()
	}, [existingPair, close])

	const onChange = useCallback(
		(index: number) => {
			if (index === -1) {
				close()
			}
		},
		[close]
	)

	useEffect(() => {
		const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
			if (isOpen.current) {
				close()

				return true
			}

			return false
		})

		return () => {
			backHandler.remove()
		}
	}, [close])

	useEffect(() => {
		const sub = events.subscribe("folderSyncSheet", e => {
			if (e.type === "request") {
				setItem(e.data.item)

				isOpen.current = true

				// Check if a sync pair already exists for this folder
				sqlite.syncPairs.getByRemoteUUID(e.data.item.uuid).then(pair => {
					if (pair) {
						setExistingPair(pair)
						setLocalUri(pair.localUri)
						setExcludeDotFiles(pair.excludeDotFiles)
					}

					ref?.current?.present()
				})
			}
		})

		return () => {
			sub.remove()
		}
	}, [ref])

	const localFolderLabel = localUri
		? decodeURIComponent(localUri).split("/").pop() ?? localUri
		: translateMemoized("sheets.folderSync.selectLocalFolder")

	const isSyncing = runtimeState?.status === "syncing"

	return (
		<Sheet
			ref={ref}
			onChange={onChange}
			enablePanDownToClose={true}
			bottomInset={insets.bottom}
		>
			<BottomSheetView className="flex-1 pb-8 px-4">
				<Text className="text-lg font-semibold text-center mb-4">
					{translateMemoized("sheets.folderSync.title")}
					{item ? ` — ${item.name}` : ""}
				</Text>

				{/* Local Folder Picker */}
				<View className="mb-4">
					<Text className="text-sm text-muted-foreground mb-1">
						{translateMemoized("sheets.folderSync.localFolder")}
					</Text>
					<Button
						variant="secondary"
						onPress={selectLocalFolder}
						disabled={!!existingPair}
					>
						<Text numberOfLines={1}>{localFolderLabel}</Text>
					</Button>
				</View>

				{/* Exclude dot files toggle */}
				<View className="flex-row items-center justify-between mb-4">
					<Text>{translateMemoized("sheets.folderSync.excludeDotFiles")}</Text>
					<Switch
						value={excludeDotFiles}
						onValueChange={setExcludeDotFiles}
						disabled={!!existingPair}
					/>
				</View>

				{/* Status indicator for existing pairs */}
				{existingPair && runtimeState && (
					<View className="mb-4 p-3 rounded-lg bg-secondary/30">
						<Text className="text-sm">
							{isSyncing
								? `${translateMemoized("sheets.folderSync.syncing")} ${runtimeState.progress.done}/${runtimeState.progress.total}`
								: runtimeState.status === "error"
									? `${translateMemoized("sheets.folderSync.error")}: ${runtimeState.error}`
									: runtimeState.lastSynced
										? `${translateMemoized("sheets.folderSync.lastSynced").replace("{{time}}", new Date(runtimeState.lastSynced).toLocaleString())}`
										: translateMemoized("sheets.folderSync.neverSynced")}
						</Text>
					</View>
				)}

				{/* Action buttons */}
				<View className="flex flex-row items-center justify-center gap-3">
					<Button
						variant="secondary"
						onPress={close}
					>
						<Text>{translateMemoized("sheets.folderSync.cancel")}</Text>
					</Button>

					{existingPair ? (
						<>
							<Button
								variant="primary"
								onPress={syncNow}
								disabled={isSyncing}
							>
								<Text>{translateMemoized("sheets.folderSync.syncNow")}</Text>
							</Button>
							<Button
								variant="destructive"
								onPress={removeSync}
								disabled={isSyncing}
							>
								<Text>{translateMemoized("sheets.folderSync.removeSync")}</Text>
							</Button>
						</>
					) : (
						<Button
							variant="primary"
							onPress={startSync}
							disabled={!localUri}
						>
							<Text>{translateMemoized("sheets.folderSync.startSync")}</Text>
						</Button>
					)}
				</View>
			</BottomSheetView>
		</Sheet>
	)
})

FolderSyncSheet.displayName = "FolderSyncSheet"

export default FolderSyncSheet
