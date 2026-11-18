import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LibraryMap } from '../library/types'
import type { UserFeature } from '../features'
import type { Layer } from '../layers'
import type { FeaturePhoto, IconAsset, Overlay, RasterOverlay } from '../store'

/**
 * The per-person IndexedDB database, `carmanah-maps.<ownerId>` (rebuild plan
 * §0, shared phones). Everything personal that the map page keeps goes in
 * here, in the person's file folder (`maps/<ownerId>/`), or in their few
 * settings keys (`carmanah-maps.<ownerId>.*` in localStorage, ./prefs.ts), so
 * the crew app can remove a person from a phone by dropping all three
 * (deleteOwnerData in ./delete-owner.ts).
 *
 * Add new stores by bumping DB_VERSION and creating them by name, as below,
 * so branches that each add a store can merge in either order.
 */

export interface StoredFile {
  blob: Blob
  size: number
}

export interface OwnerDB extends DBSchema {
  /** Imported maps (the Maps library). */
  maps: { key: string; value: LibraryMap }
  /** File bytes, when the browser has no usable OPFS (see ./files.ts). Keyed by path. */
  files: { key: string; value: StoredFile }
  /** Small settings, e.g. which file backend this person's files are in. */
  meta: { key: string; value: unknown }
  // ---- v2: My Data, moved here from the shared `carmanah-maps` (store.ts) ----
  /** Layer tree, saved visibility, default style, schema (layers.ts). */
  layers: { key: string; value: Layer }
  /** Pins, lines, areas and tracks. */
  features: { key: string; value: UserFeature }
  /** Photos attached to features. */
  photos: { key: string; value: FeaturePhoto; indexes: { byFeature: string } }
  /** Custom placemark icons restored from imported KMZ files. */
  icons: { key: string; value: IconAsset }
  /** Personal key-value data, e.g. migration flags. (Shared caches: ./shared-db.ts.) */
  kv: { key: string; value: unknown }
  /** Read-only KML/GPX/SHP imports from before layers (a backup; see mydata.ts). */
  overlays: { key: string; value: Overlay }
  /** GeoPDF images saved before the Maps library (its 'legacy' maps). */
  rasters: { key: string; value: RasterOverlay }
}

/** The stores that hold My Data (everything but the Maps library's own). */
export const MY_DATA_STORES = ['layers', 'features', 'photos', 'icons', 'kv', 'overlays', 'rasters'] as const
export type MyDataStore = (typeof MY_DATA_STORES)[number]

const DB_VERSION = 2

export const ownerDbName = (ownerId: string) => `carmanah-maps.${ownerId}`

const opened = new Map<string, Promise<IDBPDatabase<OwnerDB>>>()

/** How long an older open page may hold up an upgrade before we say so. */
const BLOCKED_MS = 4000

export function openOwnerDb(ownerId: string): Promise<IDBPDatabase<OwnerDB>> {
  let db = opened.get(ownerId)
  if (!db) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectBlocked: (err: Error) => void = () => {}
    const blocked = new Promise<never>((_, reject) => (rejectBlocked = reject))
    const opening = openDB<OwnerDB>(ownerDbName(ownerId), DB_VERSION, {
      upgrade(db) {
        const create = (name: Parameters<typeof db.createObjectStore>[0], keyPath?: string) =>
          db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, keyPath ? { keyPath } : undefined)
        // v1 (Maps library)
        create('maps', 'id')
        create('files')
        create('meta')
        // v2 (My Data)
        create('layers', 'id')
        create('features', 'id')
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id' }).createIndex('byFeature', 'featureId')
        }
        create('icons', 'id')
        create('kv')
        create('overlays', 'id')
        create('rasters', 'id')
      },
      blocked() {
        // An older version of the app is open in another tab and holds the
        // database at its old version. It must close before this one can
        // upgrade; say so instead of waiting silently.
        timer ??= setTimeout(
          () => rejectBlocked(new Error('Carmanah Maps is open in another tab. Close it, then reload this one.')),
          BLOCKED_MS,
        )
      },
      blocking() {
        // Another page wants to upgrade or delete this database: a newer
        // version of the app, or the crew app removing this person. Let it,
        // and reload so this page neither blocks it nor writes on afterwards.
        void opening.then((d) => d.close(), () => {})
        opened.delete(ownerId)
        if (typeof location !== 'undefined' && typeof location.reload === 'function') {
          try {
            location.reload()
          } catch {
            // not in a browser page
          }
        }
      },
    })
    opening.finally(() => clearTimeout(timer)).catch(() => {})
    const current = Promise.race([opening, blocked])
    db = current
    opened.set(ownerId, current)
    current.catch(() => {
      if (opened.get(ownerId) === current) opened.delete(ownerId)
    })
  }
  return db
}

/**
 * Drop one person's database. Our own connection is closed first; another
 * open page holding it is asked to let go (`blocking` above). Rejects if
 * something keeps it open for 10 s (the delete then still happens once that
 * page closes).
 */
export async function dropOwnerDb(ownerId: string): Promise<void> {
  const db = opened.get(ownerId)
  opened.delete(ownerId)
  if (db) await db.then((d) => d.close(), () => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectBlocked: (err: Error) => void = () => {}
  const blocked = new Promise<never>((_, reject) => (rejectBlocked = reject))
  try {
    await Promise.race([
      deleteDB(ownerDbName(ownerId), {
        blocked() {
          timer ??= setTimeout(
            () => rejectBlocked(new Error('another open page is still using this data; close it to finish')),
            10_000,
          )
        },
      }),
      blocked,
    ])
  } finally {
    clearTimeout(timer)
  }
}
