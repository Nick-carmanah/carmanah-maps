import { openDB, type IDBPDatabase } from 'idb'

/**
 * The phone's shared IndexedDB database, `carmanah-maps`: the one the app
 * used for everything before owners existed.
 *
 * Now it holds only what belongs to nobody: caches like the live-fire data
 * (`kv`). Its other stores (features, layers, photos, icons, overlays,
 * rasters) are the pre-owner My Data, copied once into the guest's own
 * database (./legacy-migration.ts) and kept untouched as a backup until a
 * later release removes them. Nothing writes to them any more.
 *
 * Opened without a version so an existing database is never upgraded (an
 * older tab of the app may still hold it open), and a new phone only gets
 * the `kv` store.
 */
export const SHARED_DB = 'carmanah-maps'

/**
 * getCached/setCached keys (store.ts) that are shared caches, not anyone's
 * data. Every other key is personal and goes in the owner's database.
 * 'livefires' is App.tsx's LIVE_CACHE_KEY (BC Wildfire Service data).
 */
export const SHARED_CACHE_KEYS: ReadonlySet<string> = new Set(['livefires'])

/** Untyped: the legacy stores may or may not exist, depending on the phone's history. */
export type SharedDB = IDBPDatabase<unknown>

let shared: Promise<SharedDB> | undefined

function open(version?: number): Promise<SharedDB> {
  return openDB(SHARED_DB, version, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
    },
    blocking() {
      // A newer version wants to change it: let go, reopen on next use.
      void shared?.then((d) => d.close())
      shared = undefined
    },
  })
}

export function openSharedDb(): Promise<SharedDB> {
  if (!shared) {
    const opening = (async () => {
      const db = await open()
      if (db.objectStoreNames.contains('kv')) return db
      // A database from the very first release (v1, before `kv`): add it.
      const version = db.version + 1
      db.close()
      return open(version)
    })()
    shared = opening
    opening.catch(() => {
      if (shared === opening) shared = undefined
    })
  }
  return shared
}

export async function getSharedCache<T>(key: string): Promise<T | undefined> {
  return (await (await openSharedDb()).get('kv', key)) as T | undefined
}

export async function setSharedCache(key: string, value: unknown): Promise<void> {
  await (await openSharedDb()).put('kv', value, key)
}
