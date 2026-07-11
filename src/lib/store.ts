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
}

const dbPromise = openDB<CarmanahDB>('carmanah-maps', 1, {
  upgrade(db) {
    db.createObjectStore('overlays', { keyPath: 'id' })
  },
})

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
