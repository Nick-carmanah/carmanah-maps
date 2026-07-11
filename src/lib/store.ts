import { openDB, type DBSchema } from 'idb'
import type { FeatureCollection } from 'geojson'

export interface Overlay {
  id: string
  name: string
  addedAt: number
  sourceUrl?: string
  geojson: FeatureCollection
}

interface CarmanahDB extends DBSchema {
  overlays: {
    key: string
    value: Overlay
  }
  // Generic key-value cache (live fire data, future map-pack manifests…).
  kv: {
    key: string
    value: unknown
  }
}

const dbPromise = openDB<CarmanahDB>('carmanah-maps', 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) db.createObjectStore('overlays', { keyPath: 'id' })
    if (oldVersion < 2) db.createObjectStore('kv')
  },
})

export async function getCached<T>(key: string): Promise<T | undefined> {
  return (await (await dbPromise).get('kv', key)) as T | undefined
}

export async function setCached(key: string, value: unknown): Promise<void> {
  await (await dbPromise).put('kv', value, key)
}

export async function listOverlays(): Promise<Overlay[]> {
  const all = await (await dbPromise).getAll('overlays')
  return all.sort((a, b) => b.addedAt - a.addedAt)
}

export async function saveOverlay(overlay: Overlay): Promise<void> {
  await (await dbPromise).put('overlays', overlay)
}

export async function deleteOverlay(id: string): Promise<void> {
  await (await dbPromise).delete('overlays', id)
}

/** Ask the browser not to evict our offline data under storage pressure. */
export function requestPersistentStorage(): void {
  navigator.storage?.persist?.().catch(() => {})
}
