// Web intentionally stays online-only. Metro resolves this file instead of
// sqlite.ts for web builds, so expo-sqlite and its WASM worker never enter the
// desktop bundle. The shared cache and sync helpers already treat a null
// database as a safe no-op and fetch live data instead.
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

export function isSqliteAvailable(): boolean {
  return false;
}

export function getDb(): null {
  return null;
}
