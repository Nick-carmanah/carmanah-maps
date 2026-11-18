import { openDB, type DBSchema } from 'idb'
import type { FeatureCollection, Position } from 'geojson'
import type { UserFeature } from './features'
import type { Layer } from './layers'

export interface RasterOverlay {
  id: string
  name: string
  addedAt: number
  /** [topLeft, topRight, bottomRight, bottomLeft] in [lon, lat]. */
  corners: [Position, Position, Position, Position]
  image: Blob
}

/** Read-only KML/GPX/SHP import from before layers existed. Migrated once into
 * layers + features (mydata.ts); kept untouched as a backup, never written. */
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
  // My Data layers (layers.ts): tree, saved visibility, default style, schema.
  layers: {
    key: string
    value: Layer
  }
  // Custom placemark icons restored from imported KMZ files.
  icons: {
    key: string
    value: IconAsset
  }
}

/** A placemark icon image from an imported KMZ (features use 'icon-<id>'). */
export interface IconAsset {
  id: string
  /** File name it had in the archive, e.g. "files/hydrant.png". */
  name: string
  blob: Blob
}

export interface FeaturePhoto {
  id: string
  featureId: string
  blob: Blob
  createdAt: number
}

const dbPromise = openDB<CarmanahDB>('carmanah-maps', 6, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1) db.createObjectStore('overlays', { keyPath: 'id' })
    if (oldVersion < 2) db.createObjectStore('kv')
    if (oldVersion < 3) db.createObjectStore('features', { keyPath: 'id' })
    if (oldVersion < 4) {
      const photos = db.createObjectStore('photos', { keyPath: 'id' })
      photos.createIndex('byFeature', 'featureId')
    }
    if (oldVersion < 5) db.createObjectStore('rasters', { keyPath: 'id' })
    // v6 (layers). Checked by name, not version, so another branch's upgrade
    // can land in either order: whoever merges second just bumps the number.
    if (!db.objectStoreNames.contains('layers')) db.createObjectStore('layers', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('icons')) db.createObjectStore('icons', { keyPath: 'id' })
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

export async function listLayers(): Promise<Layer[]> {
  return (await dbPromise).getAll('layers')
}

export async function saveLayer(layer: Layer): Promise<void> {
  await (await dbPromise).put('layers', layer)
}

export async function getIcon(id: string): Promise<IconAsset | undefined> {
  return (await dbPromise).get('icons', id)
}

/** Several writes across stores in ONE transaction: all land or none do.
 * Used by imports, the layers migration and layer deletion. */
export async function writeBatch(batch: {
  layers?: Layer[]
  features?: UserFeature[]
  photos?: FeaturePhoto[]
  icons?: IconAsset[]
  deleteLayerIds?: string[]
  /** Also deletes these features' photos. */
  deleteFeatureIds?: string[]
  kv?: Record<string, unknown>
}): Promise<void> {
  const db = await dbPromise
  const tx = db.transaction(['layers', 'features', 'photos', 'icons', 'kv'], 'readwrite')
  const ops: Promise<unknown>[] = []
  for (const l of batch.layers ?? []) ops.push(tx.objectStore('layers').put(l))
  for (const f of batch.features ?? []) ops.push(tx.objectStore('features').put(f))
  for (const p of batch.photos ?? []) ops.push(tx.objectStore('photos').put(p))
  for (const i of batch.icons ?? []) ops.push(tx.objectStore('icons').put(i))
  for (const id of batch.deleteLayerIds ?? []) ops.push(tx.objectStore('layers').delete(id))
  const photoIndex = tx.objectStore('photos').index('byFeature')
  for (const id of batch.deleteFeatureIds ?? []) {
    ops.push(tx.objectStore('features').delete(id))
    ops.push(
      photoIndex
        .getAllKeys(id)
        .then((keys) => Promise.all(keys.map((k) => tx.objectStore('photos').delete(k)))),
    )
  }
  for (const [key, value] of Object.entries(batch.kv ?? {})) {
    ops.push(tx.objectStore('kv').put(value, key))
  }
  await Promise.all([...ops, tx.done])
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


/** Ask the browser not to evict our offline data under storage pressure. */
export function requestPersistentStorage(): void {
  navigator.storage?.persist?.().catch(() => {})
}
