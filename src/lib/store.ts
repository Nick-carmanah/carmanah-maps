import { openDB, type DBSchema } from 'idb'
import type { FeatureCollection, Position } from 'geojson'
import type { UserFeature } from './features'

export interface RasterOverlay {
  id: string
  name: string
  addedAt: number
  /** [topLeft, topRight, bottomRight, bottomLeft] in [lon, lat]. */
  corners: [Position, Position, Position, Position]
  image: Blob
}

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
  // User-created pins, lines, and areas.
  features: {
    key: string
    value: UserFeature
  }
  // Photos attached to user features.
  photos: {
    key: string
    value: FeaturePhoto
    indexes: { byFeature: string }
  }
  // Georeferenced raster imports (e.g. from GeoPDF).
  rasters: {
    key: string
    value: RasterOverlay
  }
}

export interface FeaturePhoto {
  id: string
  featureId: string
  blob: Blob
  createdAt: number
}

const dbPromise = openDB<CarmanahDB>('carmanah-maps', 5, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) db.createObjectStore('overlays', { keyPath: 'id' })
    if (oldVersion < 2) db.createObjectStore('kv')
    if (oldVersion < 3) db.createObjectStore('features', { keyPath: 'id' })
    if (oldVersion < 4) {
      const photos = db.createObjectStore('photos', { keyPath: 'id' })
      photos.createIndex('byFeature', 'featureId')
    }
    if (oldVersion < 5) db.createObjectStore('rasters', { keyPath: 'id' })
  },
})

export async function listRasters(): Promise<RasterOverlay[]> {
  const all = await (await dbPromise).getAll('rasters')
  return all.sort((a, b) => b.addedAt - a.addedAt)
}

export async function saveRaster(raster: RasterOverlay): Promise<void> {
  await (await dbPromise).put('rasters', raster)
}

export async function deleteRaster(id: string): Promise<void> {
  await (await dbPromise).delete('rasters', id)
}

export async function listPhotos(featureId: string): Promise<FeaturePhoto[]> {
  const all = await (await dbPromise).getAllFromIndex('photos', 'byFeature', featureId)
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function savePhoto(photo: FeaturePhoto): Promise<void> {
  await (await dbPromise).put('photos', photo)
}

export async function deletePhoto(id: string): Promise<void> {
  await (await dbPromise).delete('photos', id)
}

export async function deletePhotosForFeature(featureId: string): Promise<void> {
  const photos = await listPhotos(featureId)
  const db = await dbPromise
  await Promise.all(photos.map((p) => db.delete('photos', p.id)))
}

export async function listFeatures(): Promise<UserFeature[]> {
  const all = await (await dbPromise).getAll('features')
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveFeature(feature: UserFeature): Promise<void> {
  await (await dbPromise).put('features', feature)
}

export async function deleteFeature(id: string): Promise<void> {
  await (await dbPromise).delete('features', id)
}

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
