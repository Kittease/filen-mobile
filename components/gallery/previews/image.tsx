import TurboImage, { type Failure } from "react-native-turbo-image"
import { memo, useMemo, useState, useCallback, useEffect, useRef, Fragment } from "react"
import type { GalleryItem } from "@/stores/gallery.store"
import { View, ActivityIndicator, Image as RNImage, Platform, type NativeSyntheticEvent } from "react-native"
import { useColorScheme } from "@/lib/useColorScheme"
import Animated, { FadeOut } from "react-native-reanimated"
import useHTTPServer from "@/hooks/useHTTPServer"
import { Icon } from "@roninoss/icons"
import { Text } from "@/components/nativewindui/Text"
import { cn } from "@/lib/cn"
import { RAW_IMAGE_EXTENSIONS } from "@/lib/constants"
import pathModule from "path"
import download from "@/lib/download"
import paths from "@/lib/paths"
import { randomUUID } from "expo-crypto"
import * as FileSystem from "expo-file-system"
import { normalizeFilePathForExpo, normalizeFilePath } from "@/lib/utils"
import { rawPreviewCache } from "@/lib/rawPreviewCache"

let extractRawPreview: ((inputPath: string, outputPath: string) => Promise<void>) | null = null

if (Platform.OS === "android") {
	try {
		const mod = require("@/modules/raw-image-converter")

		extractRawPreview = mod.extractRawPreview
	} catch {}
}

function isRawFile(name: string): boolean {
	return Platform.OS === "android" && RAW_IMAGE_EXTENSIONS.includes(pathModule.posix.extname(name.trim().toLowerCase()))
}

const RawImagePreview = memo(
	({
		item,
		layout
	}: {
		item: GalleryItem & { itemType: "cloudItem" }
		layout: { width: number; height: number }
	}) => {
		const [jpegPath, setJpegPath] = useState<string | null>(null)
		const [loading, setLoading] = useState<boolean>(true)
		const [error, setError] = useState<string | null>(null)
		const { colors, isDarkColorScheme } = useColorScheme()
		const cleanupPaths = useRef<string[]>([])
		const usingCacheRef = useRef<boolean>(false)

		const style = useMemo(() => {
			return {
				width: layout.width,
				height: layout.height,
				flex: 1 as const
			}
		}, [layout.width, layout.height])

		useEffect(() => {
			let cancelled = false
			const fileItem = item.data.item

			if (fileItem.type !== "file" || !extractRawPreview) {
				setLoading(false)
				setError("RAW preview not supported")
				return
			}

			const run = async () => {
				try {
					// Check the prefetch cache first
					const cachedPath = rawPreviewCache.get(fileItem.uuid)

					if (cachedPath) {
						usingCacheRef.current = true
						setJpegPath(cachedPath)
						setLoading(false)

						return
					}

					usingCacheRef.current = false

					const id = randomUUID()
					const extname = pathModule.posix.extname(fileItem.name)
					const tempDir = paths.temporaryDownloads()
					const rawPath = pathModule.posix.join(tempDir, `${id}${extname}`)
					const jpegOutputPath = pathModule.posix.join(tempDir, `${id}_preview.jpg`)

					cleanupPaths.current.push(rawPath, jpegOutputPath)

					await download.file.foreground({
						id,
						uuid: fileItem.uuid,
						bucket: fileItem.bucket,
						region: fileItem.region,
						chunks: fileItem.chunks,
						version: fileItem.version,
						key: fileItem.key,
						destination: normalizeFilePathForExpo(rawPath),
						size: fileItem.size,
						name: fileItem.name,
						dontEmitProgress: true
					})

					if (cancelled) return

					await extractRawPreview(normalizeFilePath(rawPath), normalizeFilePath(jpegOutputPath))

					if (cancelled) return

					// Clean up the large RAW file immediately, keep only the JPEG
					const rawFile = new FileSystem.File(normalizeFilePathForExpo(rawPath))

					if (rawFile.exists) {
						rawFile.delete()
					}

					setJpegPath(jpegOutputPath)
					setLoading(false)
				} catch (e) {
					if (!cancelled) {
						setLoading(false)
						setError(e instanceof Error ? e.message : "Failed to extract RAW preview")
					}
				}
			}

			run()

			return () => {
				cancelled = true

				// Don't delete cached preview files — they're shared via rawPreviewCache
				if (!usingCacheRef.current) {
					for (const p of cleanupPaths.current) {
						try {
							const f = new FileSystem.File(normalizeFilePathForExpo(p))

							if (f.exists) {
								f.delete()
							}
						} catch {}
					}
				}

				cleanupPaths.current = []
			}
		}, [item.data.item])

		return (
			<View
				className="flex-1"
				style={style}
			>
				{loading && !error && (
					<Animated.View
						exiting={FadeOut}
						className={cn(
							"flex-1 absolute top-0 left-0 right-0 bottom-0 z-50 items-center justify-center",
							isDarkColorScheme ? "bg-black" : "bg-white"
						)}
						style={style}
					>
						<ActivityIndicator
							color={colors.foreground}
							size="small"
						/>
					</Animated.View>
				)}
				{error && (
					<Animated.View
						exiting={FadeOut}
						className={cn(
							"flex-1 absolute top-0 left-0 right-0 bottom-0 z-50 items-center justify-center",
							isDarkColorScheme ? "bg-black" : "bg-white"
						)}
						style={style}
					>
						<Icon
							name="image-outline"
							size={64}
							color={colors.destructive}
						/>
						<Text className="text-muted-foreground text-sm text-center px-8 pt-2">{error}</Text>
					</Animated.View>
				)}
				{jpegPath && !error && (
					<RNImage
						source={{ uri: `file://${jpegPath}` }}
						resizeMode="contain"
						style={style}
					/>
				)}
			</View>
		)
	}
)

RawImagePreview.displayName = "RawImagePreview"

export const Image = memo(
	({
		item,
		layout
	}: {
		item: GalleryItem
		layout: {
			width: number
			height: number
		}
	}) => {
		const isRaw = useMemo(() => {
			return item.itemType === "cloudItem" && item.data.item.type === "file" && isRawFile(item.data.item.name)
		}, [item])

		if (isRaw && item.itemType === "cloudItem") {
			return (
				<RawImagePreview
					item={item as GalleryItem & { itemType: "cloudItem" }}
					layout={layout}
				/>
			)
		}

		return (
			<StandardImage
				item={item}
				layout={layout}
			/>
		)
	}
)

Image.displayName = "Image"

const StandardImage = memo(
	({
		item,
		layout
	}: {
		item: GalleryItem
		layout: {
			width: number
			height: number
		}
	}) => {
		const [loading, setLoading] = useState<boolean>(true)
		const [error, setError] = useState<string | null>(null)
		const { colors, isDarkColorScheme } = useColorScheme()
		const httpServer = useHTTPServer()

		const style = useMemo(() => {
			return {
				width: layout.width,
				height: layout.height,
				flex: 1 as const
			}
		}, [layout.width, layout.height])

		const source = useMemo(() => {
			if (item.itemType === "remoteItem") {
				return {
					uri: item.data.uri
				}
			}

			if (item.itemType === "cloudItem" && item.data.item.type === "file") {
				return {
					uri: `http://127.0.0.1:${httpServer.port}/stream?auth=${httpServer.authToken}&file=${encodeURIComponent(
						btoa(
							JSON.stringify({
								mime: item.data.item.mime,
								size: item.data.item.size,
								uuid: item.data.item.uuid,
								bucket: item.data.item.bucket,
								key: item.data.item.key,
								version: item.data.item.version,
								chunks: item.data.item.chunks,
								region: item.data.item.region
							})
						)
					)}`
				}
			}

			return null
		}, [item, httpServer.port, httpServer.authToken])

		const onStart = useCallback(() => {
			setLoading(true)
		}, [])

		const onCompletion = useCallback(() => {
			setLoading(false)
		}, [])

		const onFailure = useCallback((e: NativeSyntheticEvent<Failure>) => {
			setLoading(false)
			setError(e.nativeEvent.error)
		}, [])

		return (
			<View
				className="flex-1"
				style={style}
			>
				{!source ? (
					<Animated.View
						exiting={FadeOut}
						className={cn(
							"flex-1 absolute top-0 left-0 right-0 bottom-0 z-50 items-center justify-center",
							isDarkColorScheme ? "bg-black" : "bg-white"
						)}
						style={style}
					>
						<ActivityIndicator
							color={colors.foreground}
							size="small"
						/>
					</Animated.View>
				) : (
					<Fragment>
						{loading && !error && (
							<Animated.View
								exiting={FadeOut}
								className={cn(
									"flex-1 absolute top-0 left-0 right-0 bottom-0 z-50 items-center justify-center",
									isDarkColorScheme ? "bg-black" : "bg-white"
								)}
								style={style}
							>
								<ActivityIndicator
									color={colors.foreground}
									size="small"
								/>
							</Animated.View>
						)}
						{error && (
							<Animated.View
								exiting={FadeOut}
								className={cn(
									"flex-1 absolute top-0 left-0 right-0 bottom-0 z-50 items-center justify-center",
									isDarkColorScheme ? "bg-black" : "bg-white"
								)}
								style={style}
							>
								<Icon
									name="image-outline"
									size={64}
									color={colors.destructive}
								/>
								<Text className="text-muted-foreground text-sm text-center px-8 pt-2">{error}</Text>
							</Animated.View>
						)}
						{!error && (
							<TurboImage
								source={source}
								resizeMode="contain"
								cachePolicy="dataCache"
								style={style}
								onStart={onStart}
								onCompletion={onCompletion}
								onFailure={onFailure}
							/>
						)}
					</Fragment>
				)}
			</View>
		)
	}
)

StandardImage.displayName = "StandardImage"

export default Image
