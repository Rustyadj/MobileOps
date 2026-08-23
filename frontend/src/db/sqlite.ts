// Local SQLite cache + mutation-queue database.
//
// Native only. On web there's no expo-sqlite story that's worth the OPFS/wasm
// complexity for this app (the web build is the office/desktop surface,
// which already has connectivity) — every function here is a safe no-op on
// web, and callers (useCachedResource, the sync engine) treat "no local DB"
// the same as "cache empty, always fetch live", which is exactly today's
// online-only behavior. This mirrors the existing native/web split in
// src/utils/storage/.
import { Platform } from "react-native";
import type { SQLiteDatabase } from "expo-sqlite";

const DB_NAME = "mobileops_cache.db";
const SCHEMA_VERSION = 1;

// Every table a phase-1 screen caches. Each gets an identical shape:
// (id, payload, updated_at) — see cacheTables.ts for why per-row storage
// (not one JSON blob per resource) was chosen.
export const CACHE_RESOURCES = [
  "equipment",
  "maintenance",
  "rentals",
  "bookings",
  "dispatches",
  "shop_tasks",
  "transfers",
  "inventory_counts",
] as const;
export type CacheResource = (typeof CACHE_RESOURCES)[number];

let db: SQLiteDatabase | null = null;
let migrated = false;

export function isSqliteAvailable(): boolean {
  return Platform.OS !== "web";
}

function cacheTableName(resource: CacheResource): string {
  return `cache_${resource}`;
}

function migrate(database: SQLiteDatabase) {
  const { user_version: version } = database.getFirstSync<{ user_version: number }>(
    "PRAGMA user_version",
  ) ?? { user_version: 0 };
  if (version >= SCHEMA_VERSION) return;

  database.execSync("BEGIN TRANSACTION;");
  try {
    if (version < 1) {
      for (const resource of CACHE_RESOURCES) {
        database.execSync(
          `CREATE TABLE IF NOT EXISTS ${cacheTableName(resource)} (
             id TEXT PRIMARY KEY NOT NULL,
             payload TEXT NOT NULL,
             updated_at INTEGER NOT NULL
           );`,
        );
      }
      database.execSync(
        `CREATE TABLE IF NOT EXISTS mutation_queue (
           id TEXT PRIMARY KEY NOT NULL,
           method TEXT NOT NULL,
           path TEXT NOT NULL,
           body TEXT NOT NULL,
           entity_type TEXT NOT NULL,
           entity_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           local_temp_id TEXT,
           depends_on_queue_id TEXT,
           status TEXT NOT NULL DEFAULT 'pending',
           attempt_count INTEGER NOT NULL DEFAULT 0,
           next_attempt_at INTEGER NOT NULL DEFAULT 0,
           last_error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );`,
      );
      database.execSync(
        "CREATE INDEX IF NOT EXISTS idx_mutation_queue_status_created ON mutation_queue (status, created_at);",
      );
    }
    database.execSync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    database.execSync("COMMIT;");
  } catch (e) {
    database.execSync("ROLLBACK;");
    throw e;
  }
}

// Lazily opens (and migrates) the database. Returns null on web, where
// there's no local DB — every caller must handle that.
export function getDb(): SQLiteDatabase | null {
  if (!isSqliteAvailable()) return null;
  if (db && migrated) return db;
  // Deferred require so web bundles never pull in the native module.
  const SQLite = require("expo-sqlite") as typeof import("expo-sqlite");
  if (!db) db = SQLite.openDatabaseSync(DB_NAME);
  if (!migrated) {
    migrate(db);
    migrated = true;
  }
  return db;
}
