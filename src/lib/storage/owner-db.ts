import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { LibraryMap } from '../library/types'

/**
 * The per-person IndexedDB database, `carmanah-maps.<ownerId>` (rebuild plan
 * §0, shared phones). Everything personal that the map page keeps goes in
 * here or in the person's file folder (`maps/<ownerId>/`), so the crew app
 * can remove a person from a phone by dropping this database and that folder.
 *
 * Add new stores by bumping DB_VERSION and adding an `oldVersion <` step.
 * (The older, shared `carmanah-maps` database in ../store.ts predates owners.)
 */

export interface StoredFile {
  blob: Blob
  size: number
}

interface OwnerDB extends DBSchema {
  /** Imported maps (the Maps library). */
  maps: { key: string; value: LibraryMap }
  /** File bytes, when the browser has no usable OPFS (see ./files.ts). Keyed by path. */
  files: { key: string; value: StoredFile }
  /** Small settings, e.g. which file backend this person's files are in. */
  meta: { key: string; value: unknown }
}

const DB_VERSION = 1

export const ownerDbName = (ownerId: string) => `carmanah-maps.${ownerId}`

const opened = new Map<string, Promise<IDBPDatabase<OwnerDB>>>()

export function openOwnerDb(ownerId: string): Promise<IDBPDatabase<OwnerDB>> {
  let db = opened.get(ownerId)
  if (!db) {
    db = openDB<OwnerDB>(ownerDbName(ownerId), DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('maps', { keyPath: 'id' })
          db.createObjectStore('files')
          db.createObjectStore('meta')
        }
      },
    })
    opened.set(ownerId, db)
  }
  return db
}
