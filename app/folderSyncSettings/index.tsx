import { memo, useCallback, useMemo } from "react"
import { Settings as SettingsComponent, IconView } from "@/components/settings"
import { Toggle } from "@/components/nativewindui/Toggle"
import useFolderSync, { setFolderSyncState } from "@/hooks/useFolderSync"
import { useRouter } from "expo-router"
import driveService from "@/services/drive.service"
import nodeWorker from "@/lib/nodeWorker"
import alerts from "@/lib/alerts"
import { validate as validateUUID } from "uuid"
import RequireInternet from "@/components/requireInternet"
import { foregroundFolderSync } from "@/lib/folderSync"
import { useFolderSyncStore } from "@/stores/folderSync.store"
import { Platform, View } from "react-native"
import { pickDirectory } from "@/lib/saf"
import { randomUUID } from "expo-crypto"

export const FolderSyncSettings = memo(() => {
	const [folderSync] = useFolderSync()
	const running = useFolderSyncStore(s => s.running)
	const progress = useFolderSyncStore(s => s.progress)
	const lastError = useFolderSyncStore(s => s.lastError)

	const currentPair = useMemo(() => folderSync.pairs[0] ?? null, [folderSync.pairs])

	const toggleEnabled = useCallback(
		async (enable: boolean) => {
			if (enable && (!currentPair || !validateUUID(currentPair.remoteUUID))) {
				enable = false
				alerts.error("Please configure both local and cloud folders first.")
			}

			setFolderSyncState(prev => ({
				...prev,
				enabled: enable,
				version: (prev.version ?? 0) + 1
			}))

			if (enable) {
				setTimeout(() => {
					foregroundFolderSync.run().catch(console.error)
				}, 1000)
			}
		},
		[currentPair]
	)

	const toggleCellular = useCallback(() => {
		setFolderSyncState(prev => ({
			...prev,
			cellular: !prev.cellular,
			version: (prev.version ?? 0) + 1
		}))
	}, [])

	const toggleBackground = useCallback(() => {
		setFolderSyncState(prev => ({
			...prev,
			background: !prev.background
		}))
	}, [])

	const toggleLowBattery = useCallback(() => {
		setFolderSyncState(prev => ({
			...prev,
			lowBattery: !prev.lowBattery,
			version: (prev.version ?? 0) + 1
		}))
	}, [])

	const toggleDeleteSync = useCallback(() => {
		setFolderSyncState(prev => ({
			...prev,
			deleteSync: !prev.deleteSync,
			version: (prev.version ?? 0) + 1
		}))
	}, [])

	const selectLocalDirectory = useCallback(async () => {
		if (Platform.OS !== "android") {
			alerts.error("Folder sync is only supported on Android.")
			return
		}

		const uri = await pickDirectory()

		if (!uri) {
			return
		}

		const folderName = decodeURIComponent(uri).split("/").pop() ?? "Selected folder"

		setFolderSyncState(prev => {
			const existingPair = prev.pairs[0]

			const pair = {
				id: existingPair?.id ?? randomUUID(),
				localUri: uri,
				localName: folderName,
				remoteUUID: existingPair?.remoteUUID ?? "",
				remotePath: existingPair?.remotePath ?? ""
			}

			return {
				...prev,
				pairs: [pair],
				version: (prev.version ?? 0) + 1
			}
		})
	}, [])

	const selectRemoteDirectory = useCallback(async () => {
		const selectDriveItemsResponse = await driveService.selectDriveItems({
			type: "directory",
			max: 1,
			dismissHref: "/folderSyncSettings"
		})

		if (selectDriveItemsResponse.cancelled || selectDriveItemsResponse.items.length !== 1) {
			return
		}

		const directory = selectDriveItemsResponse.items.at(0)

		if (!directory) {
			return
		}

		try {
			const path = await nodeWorker.proxy("directoryUUIDToPath", {
				uuid: directory.uuid
			})

			setFolderSyncState(prev => {
				const existingPair = prev.pairs[0]

				const pair = {
					id: existingPair?.id ?? randomUUID(),
					localUri: existingPair?.localUri ?? "",
					localName: existingPair?.localName ?? "",
					remoteUUID: directory.uuid,
					remotePath: path
				}

				return {
					...prev,
					pairs: [pair],
					version: (prev.version ?? 0) + 1
				}
			})

			if (folderSync.enabled) {
				setTimeout(() => {
					foregroundFolderSync.run().catch(console.error)
				}, 1000)
			}
		} catch (e) {
			console.error(e)

			if (e instanceof Error) {
				alerts.error(e.message)
			}
		}
	}, [folderSync.enabled])

	const triggerSync = useCallback(() => {
		if (running) {
			alerts.error("Sync is already running.")
			return
		}

		foregroundFolderSync.run().catch(e => {
			console.error(e)

			if (e instanceof Error) {
				alerts.error(e.message)
			}
		})
	}, [running])

	const items = useMemo(() => {
		if (Platform.OS !== "android") {
			return [
				{
					id: "unsupported",
					title: "Not supported",
					subTitle: "Folder sync is only available on Android due to iOS sandbox restrictions."
				}
			]
		}

		return [
			{
				id: "0",
				title: "Enable folder sync",
				rightView: (
					<View>
						<Toggle
							value={folderSync.enabled && !!currentPair && validateUUID(currentPair.remoteUUID) && currentPair.localUri.length > 0}
							onValueChange={toggleEnabled}
						/>
					</View>
				)
			},
			"gap-0",
			{
				id: "1",
				title: "Local folder",
				subTitle: currentPair?.localUri
					? currentPair.localName
					: "Not set",
				leftView: (
					<IconView
						name="folder-outline"
						className="bg-blue-500"
					/>
				),
				onPress: selectLocalDirectory
			},
			{
				id: "2",
				title: "Cloud folder",
				subTitle:
					currentPair && validateUUID(currentPair.remoteUUID)
						? currentPair.remotePath
						: "Not set",
				leftView: (
					<IconView
						name="cloud-outline"
						className="bg-red-500"
					/>
				),
				onPress: selectRemoteDirectory
			},
			"gap-1",
			{
				id: "3",
				title: "Sync over cellular",
				subTitle: "Allow syncing when not connected to Wi-Fi",
				leftView: (
					<IconView
						name="signal-cellular-3"
						className="bg-blue-500"
					/>
				),
				rightView: (
					<Toggle
						value={folderSync.cellular}
						onValueChange={toggleCellular}
					/>
				)
			},
			{
				id: "4",
				title: "Background sync",
				subTitle: "Sync periodically in the background",
				leftView: (
					<IconView
						name="backpack"
						className="bg-gray-500"
					/>
				),
				rightView: (
					<Toggle
						value={folderSync.background}
						onValueChange={toggleBackground}
					/>
				)
			},
			{
				id: "5",
				title: "Sync on low battery",
				subTitle: "Continue syncing when battery is low",
				leftView: (
					<IconView
						name="power-plug-outline"
						className="bg-green-500"
					/>
				),
				rightView: (
					<Toggle
						value={folderSync.lowBattery}
						onValueChange={toggleLowBattery}
					/>
				)
			},
			{
				id: "6",
				title: "Propagate deletions",
				subTitle: "When a file is deleted locally, also delete it from the cloud. When disabled, missing local files are downloaded instead.",
				leftView: (
					<IconView
						name="delete-outline"
						className="bg-orange-500"
					/>
				),
				rightView: (
					<Toggle
						value={folderSync.deleteSync}
						onValueChange={toggleDeleteSync}
					/>
				)
			},
			"gap-2",
			{
				id: "7",
				title: running ? `Syncing... (${progress.done}/${progress.count})` : "Sync now",
				subTitle: lastError ? `Last error: ${lastError}` : running ? "Sync is in progress" : "Manually trigger a sync",
				leftView: (
					<IconView
						name="sync"
						className={running ? "bg-yellow-500" : "bg-teal-500"}
					/>
				),
				onPress: triggerSync
			}
		]
	}, [
		folderSync,
		currentPair,
		toggleEnabled,
		toggleCellular,
		toggleBackground,
		toggleLowBattery,
		toggleDeleteSync,
		selectLocalDirectory,
		selectRemoteDirectory,
		running,
		progress,
		lastError,
		triggerSync
	])

	return (
		<RequireInternet>
			<SettingsComponent
				iosBackButtonTitle="Settings"
				title="Folder Sync"
				showSearchBar={false}
				items={items}
			/>
		</RequireInternet>
	)
})

FolderSyncSettings.displayName = "FolderSyncSettings"

export default FolderSyncSettings
