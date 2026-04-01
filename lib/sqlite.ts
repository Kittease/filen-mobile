import paths from "./paths"
import { Directory } from "expo-file-system"
import pathModule from "path"
import { open, type NitroSQLiteConnection, NITRO_SQLITE_NULL } from "react-native-nitro-sqlite"
import type { SyncPairConfig, SyncMode } from "@/stores/folderSync.store"

export type SyncStateRow = {
	syncPairId: string
	relativePath: string
	size: number
	lastModified: number
	side: "local" | "remote"
	fileUUID: string | null
}

export const SQLITE_VERSION: number = 8

export const INIT_QUERIES: {
	query: string
	pragma: boolean
}[] = [
	{
		query: "PRAGMA journal_mode = WAL",
		pragma: true
	},
	{
		query: "PRAGMA synchronous = NORMAL",
		pragma: true
	},
	{
		query: "PRAGMA temp_store = FILE", // Use disk instead of memory for temp storage
		pragma: true
	},
	{
		query: "PRAGMA mmap_size = 33554432", // Set memory mapping size to 32MB
		pragma: true
	},
	{
		query: "PRAGMA page_size = 4096", // Must be set before any tables are created
		pragma: true
	},
	{
		query: "PRAGMA cache_size = -8000", // 8MB cache - much smaller for low memory
		pragma: true
	},
	{
		query: "PRAGMA foreign_keys = ON",
		pragma: true
	},
	{
		query: "PRAGMA busy_timeout = 15000", // 5s timeout
		pragma: true
	},
	{
		query: "PRAGMA auto_vacuum = INCREMENTAL",
		pragma: true
	},
	{
		query: "PRAGMA wal_autocheckpoint = 100", // More frequent checkpoints to keep WAL small
		pragma: true
	},
	{
		query: "PRAGMA journal_size_limit = 33554432", // 32MB WAL size limit (small)
		pragma: true
	},
	{
		query: "PRAGMA max_page_count = 107374182300", // Prevent database from growing too large
		pragma: true
	},
	{
		query: "PRAGMA encoding = 'UTF-8'",
		pragma: true
	},
	{
		query: "PRAGMA secure_delete = OFF",
		pragma: true
	},
	{
		query: "PRAGMA cell_size_check = OFF",
		pragma: true
	},
	{
		query: "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID",
		pragma: false
	},
	{
		query: "CREATE INDEX IF NOT EXISTS kv_key ON kv (key)",
		pragma: false
	},
	{
		query: "CREATE UNIQUE INDEX IF NOT EXISTS kv_key_unique ON kv (key)",
		pragma: false
	},
	{
		query: "CREATE TABLE IF NOT EXISTS thumbnails (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, uuid TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL)",
		pragma: false
	},
	{
		query: "CREATE INDEX IF NOT EXISTS thumbnails_uuid ON thumbnails (uuid)",
		pragma: false
	},
	{
		query: "CREATE INDEX IF NOT EXISTS thumbnails_path ON thumbnails (path)",
		pragma: false
	},
	{
		query: "CREATE UNIQUE INDEX IF NOT EXISTS thumbnails_uuid_unique ON thumbnails (uuid)",
		pragma: false
	},
	{
		query: "CREATE TABLE IF NOT EXISTS offline_files (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, uuid TEXT NOT NULL, item TEXT NOT NULL)",
		pragma: false
	},
	{
		query: "CREATE INDEX IF NOT EXISTS offline_files_uuid ON offline_files (uuid)",
		pragma: false
	},
	{
		query: "CREATE UNIQUE INDEX IF NOT EXISTS offline_files_uuid_unique ON offline_files (uuid)",
		pragma: false
	},
	{
		query: "CREATE TABLE IF NOT EXISTS sync_pairs (id TEXT PRIMARY KEY NOT NULL, remoteUUID TEXT NOT NULL, remotePath TEXT NOT NULL, remoteName TEXT NOT NULL, localUri TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'twoWay', paused INTEGER NOT NULL DEFAULT 0, excludeDotFiles INTEGER NOT NULL DEFAULT 1, createdAt INTEGER NOT NULL) WITHOUT ROWID",
		pragma: false
	},
	{
		query: "CREATE INDEX IF NOT EXISTS sync_pairs_remoteUUID ON sync_pairs (remoteUUID)",
		pragma: false
	},
	{
		query: "CREATE UNIQUE INDEX IF NOT EXISTS sync_pairs_id_unique ON sync_pairs (id)",
		pragma: false
	},
	{
		query: "CREATE TABLE IF NOT EXISTS sync_state (syncPairId TEXT NOT NULL, relativePath TEXT NOT NULL, size INTEGER NOT NULL, lastModified INTEGER NOT NULL, side TEXT NOT NULL, fileUUID TEXT, PRIMARY KEY (syncPairId, relativePath, side)) WITHOUT ROWID",
		pragma: false
	},
	{
		query: "CREATE INDEX IF NOT EXISTS sync_state_syncPairId ON sync_state (syncPairId)",
		pragma: false
	},
	{
		query: "PRAGMA optimize", // Run at the end after schema is created
		pragma: true
	}
]

export class SQLite {
	public db: NitroSQLiteConnection

	public constructor(dbName: string) {
		this.db = open({
			name: dbName,
			location: pathModule.posix.basename(paths.db())
		})

		for (const query of INIT_QUERIES.filter(q => q.pragma)) {
			this.db.execute(query.query)
		}

		this.db.executeBatch(
			INIT_QUERIES.filter(q => !q.pragma).map(q => ({
				query: q.query
			}))
		)
	}

	public async clearAsync(): Promise<void> {
		await this.db.executeAsync("DELETE FROM kv")
		await this.db.executeAsync("DELETE FROM thumbnails")
		await this.db.executeAsync("DELETE FROM offline_files")
	}

	public offlineFiles = {
		contains: async (uuid: string): Promise<boolean> => {
			const { rows } = await this.db.executeAsync("SELECT uuid FROM offline_files WHERE uuid = ?", [uuid])

			if (!rows) {
				return false
			}

			return rows.length > 0
		},
		get: async (uuid: string): Promise<DriveCloudItem | null> => {
			const { rows } = this.db.execute<{ item: string }>("SELECT item FROM offline_files WHERE uuid = ?", [uuid])

			if (!rows || rows.length === 0) {
				return null
			}

			const row = rows.item(0)

			if (!row) {
				return null
			}

			return JSON.parse(row.item) as DriveCloudItem
		},
		add: async (item: DriveCloudItem): Promise<number | null> => {
			const { insertId } = await this.db.executeAsync("INSERT OR REPLACE INTO offline_files (uuid, item) VALUES (?, ?)", [
				item.uuid,
				JSON.stringify(item)
			])

			return insertId ?? null
		},
		remove: async (item: DriveCloudItem): Promise<void> => {
			await this.db.executeAsync("DELETE FROM offline_files WHERE uuid = ?", [item.uuid])
		},
		list: async (): Promise<DriveCloudItem[]> => {
			const { rows } = await this.db.executeAsync<{ item: string }>("SELECT item FROM offline_files")

			if (!rows) {
				return []
			}

			return rows._array.map(row => JSON.parse(row.item) as DriveCloudItem)
		},
		clear: async (): Promise<void> => {
			await this.db.executeAsync("DELETE FROM offline_files")
		},
		verify: async (): Promise<void> => {
			const { rows } = await this.db.executeAsync<{ uuid: string }>("SELECT uuid FROM offline_files")

			if (!rows || rows.length === 0) {
				return
			}

			const list = rows._array.map(row => row.uuid)

			if (list.length === 0) {
				return
			}

			const offlineFilesDir = new Directory(paths.offlineFiles())

			if (!offlineFilesDir.exists) {
				offlineFilesDir.create()

				await this.db.executeAsync("DELETE FROM offline_files")

				return
			}

			const existingOfflineFiles = offlineFilesDir.listAsRecords().map(entry => pathModule.posix.basename(entry.uri).split(".")[0])

			if (existingOfflineFiles.length === 0) {
				await this.db.executeAsync("DELETE FROM offline_files")

				return
			}

			await Promise.all(
				list.map(async uuid => {
					if (existingOfflineFiles.includes(uuid)) {
						return
					}

					await this.db.executeAsync("DELETE FROM offline_files WHERE uuid = ?", [uuid])
				})
			)
		}
	}

	public syncPairs = {
		add: async (pair: SyncPairConfig): Promise<void> => {
			await this.db.executeAsync(
				"INSERT OR REPLACE INTO sync_pairs (id, remoteUUID, remotePath, remoteName, localUri, mode, paused, excludeDotFiles, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				[pair.id, pair.remoteUUID, pair.remotePath, pair.remoteName, pair.localUri, pair.mode, pair.paused ? 1 : 0, pair.excludeDotFiles ? 1 : 0, pair.createdAt]
			)
		},
		remove: async (id: string): Promise<void> => {
			await this.db.executeAsync("DELETE FROM sync_pairs WHERE id = ?", [id])
			await this.db.executeAsync("DELETE FROM sync_state WHERE syncPairId = ?", [id])
		},
		get: async (id: string): Promise<SyncPairConfig | null> => {
			const { rows } = await this.db.executeAsync<{
				id: string
				remoteUUID: string
				remotePath: string
				remoteName: string
				localUri: string
				mode: string
				paused: number
				excludeDotFiles: number
				createdAt: number
			}>("SELECT * FROM sync_pairs WHERE id = ?", [id])

			if (!rows || rows.length === 0) {
				return null
			}

			const row = rows.item(0)

			if (!row) {
				return null
			}

			return {
				id: row.id,
				remoteUUID: row.remoteUUID,
				remotePath: row.remotePath,
				remoteName: row.remoteName,
				localUri: row.localUri,
				mode: row.mode as SyncMode,
				paused: row.paused === 1,
				excludeDotFiles: row.excludeDotFiles === 1,
				createdAt: row.createdAt
			}
		},
		list: async (): Promise<SyncPairConfig[]> => {
			const { rows } = await this.db.executeAsync<{
				id: string
				remoteUUID: string
				remotePath: string
				remoteName: string
				localUri: string
				mode: string
				paused: number
				excludeDotFiles: number
				createdAt: number
			}>("SELECT * FROM sync_pairs ORDER BY createdAt DESC")

			if (!rows) {
				return []
			}

			return rows._array.map(row => ({
				id: row.id,
				remoteUUID: row.remoteUUID,
				remotePath: row.remotePath,
				remoteName: row.remoteName,
				localUri: row.localUri,
				mode: row.mode as SyncMode,
				paused: row.paused === 1,
				excludeDotFiles: row.excludeDotFiles === 1,
				createdAt: row.createdAt
			}))
		},
		getByRemoteUUID: async (remoteUUID: string): Promise<SyncPairConfig | null> => {
			const { rows } = await this.db.executeAsync<{
				id: string
				remoteUUID: string
				remotePath: string
				remoteName: string
				localUri: string
				mode: string
				paused: number
				excludeDotFiles: number
				createdAt: number
			}>("SELECT * FROM sync_pairs WHERE remoteUUID = ? LIMIT 1", [remoteUUID])

			if (!rows || rows.length === 0) {
				return null
			}

			const row = rows.item(0)

			if (!row) {
				return null
			}

			return {
				id: row.id,
				remoteUUID: row.remoteUUID,
				remotePath: row.remotePath,
				remoteName: row.remoteName,
				localUri: row.localUri,
				mode: row.mode as SyncMode,
				paused: row.paused === 1,
				excludeDotFiles: row.excludeDotFiles === 1,
				createdAt: row.createdAt
			}
		}
	}

	public syncState = {
		save: async (entries: SyncStateRow[]): Promise<void> => {
			if (entries.length === 0) {
				return
			}

			const batchSize = 50

			for (let i = 0; i < entries.length; i += batchSize) {
				const batch = entries.slice(i, i + batchSize)

				await this.db.executeBatchAsync(
					batch.map(entry => ({
						query: "INSERT OR REPLACE INTO sync_state (syncPairId, relativePath, size, lastModified, side, fileUUID) VALUES (?, ?, ?, ?, ?, ?)",
						params: [entry.syncPairId, entry.relativePath, entry.size, entry.lastModified, entry.side, entry.fileUUID ?? NITRO_SQLITE_NULL]
					}))
				)
			}
		},
		load: async (syncPairId: string): Promise<{ local: Map<string, SyncStateRow>; remote: Map<string, SyncStateRow> }> => {
			const { rows } = await this.db.executeAsync<SyncStateRow>(
				"SELECT * FROM sync_state WHERE syncPairId = ?",
				[syncPairId]
			)

			const local = new Map<string, SyncStateRow>()
			const remote = new Map<string, SyncStateRow>()

			if (!rows) {
				return { local, remote }
			}

			for (const row of rows._array) {
				if (row.side === "local") {
					local.set(row.relativePath, row)
				} else {
					remote.set(row.relativePath, row)
				}
			}

			return { local, remote }
		},
		clear: async (syncPairId: string): Promise<void> => {
			await this.db.executeAsync("DELETE FROM sync_state WHERE syncPairId = ?", [syncPairId])
		},
		removeEntries: async (syncPairId: string, relativePaths: string[], side: "local" | "remote"): Promise<void> => {
			if (relativePaths.length === 0) {
				return
			}

			const batchSize = 50

			for (let i = 0; i < relativePaths.length; i += batchSize) {
				const batch = relativePaths.slice(i, i + batchSize)

				await this.db.executeBatchAsync(
					batch.map(p => ({
						query: "DELETE FROM sync_state WHERE syncPairId = ? AND relativePath = ? AND side = ?",
						params: [syncPairId, p, side]
					}))
				)
			}
		}
	}

	public kvAsync = {
		get: async <T>(key: string): Promise<T | null> => {
			const { rows } = await this.db.executeAsync<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key])

			if (!rows || rows.length === 0) {
				return null
			}

			const row = rows.item(0)

			if (!row) {
				return null
			}

			return JSON.parse(row.value) as T
		},
		set: async <T>(key: string, value: T): Promise<number | null> => {
			if (!value) {
				return null
			}

			const { insertId } = await this.db.executeAsync("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [
				key,
				JSON.stringify(value)
			])

			return insertId ?? null
		},
		keys: async (): Promise<string[]> => {
			const { rows } = await this.db.executeAsync<{ key: string }>("SELECT key FROM kv")

			if (!rows || rows.length === 0) {
				return []
			}

			return rows._array.map(row => row.key)
		},
		clear: async (): Promise<void> => {
			await this.db.executeAsync("DELETE FROM kv")
		},
		contains: async (key: string): Promise<boolean> => {
			const { rows } = await this.db.executeAsync<{ key: string }>("SELECT key FROM kv WHERE key = ?", [key])

			if (!rows || rows.length === 0) {
				return false
			}

			return rows.length > 0
		},
		remove: async (key: string): Promise<void> => {
			await this.db.executeAsync("DELETE FROM kv WHERE key = ?", [key])
		}
	}
}

export const sqlite = new SQLite(`filen_sqlite_v${SQLITE_VERSION}.sqlite`)

export default sqlite
