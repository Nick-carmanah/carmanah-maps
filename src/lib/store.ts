import type { FeatureCollection, Position } from 'geojson'
import type { UserFeature } from './features'
import type { Layer } from './layers'
import { GUEST_OWNER, pageOwnerId } from './storage/owner'
import { openOwnerDb } from './storage/owner-db'
import { getSharedCache, setSharedCache, SHARED_CACHE_KEYS } from './storage/shared-db'
import { LegacyMigrationError, migrateLegacyData } from './storage/legacy-migration'

/**
 * My Data on the phone: layers, features, photos, icons and personal
 * key-value data, plus the Maps library's pre-library images. All of it is
 * personal, so it lives in the page owner's own database,
 * `carmanah-maps.<ownerId>` (storage/owner-db.ts; plan §0, shared phones).
 * The owner is fixed for the page load (storage/owner.ts), so these
 * functions never mix two people's data.
 *
 * Before owners, all of this was in one shared `carmanah-maps` database. The
 * guest's first load copies it across (storage/legacy-migration.ts) before
 * any of these functions answers. The shared database now keeps only caches
 * that are nobody's (getCached/setCached with a SHARED_CACHE_KEYS key, e.g.
 * live fires).
 */

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

let ready: Promise<void> | undefined

/** The page owner's database, once any old data has been moved into it. */
async function db() {
  const ownerId = pageOwnerId()
  ready ??=
    ownerId === GUEST_OWNER
      ? migrateLegacyData().then(
          () => {},
          (err: LegacyMigrationError) => {
            // Until the first copy lands, the guest database is incomplete:
            // answer nothing rather than an empty My Data (nothing is lost;
            // the old database is untouched and the next load tries again).
            if (err.firstCopy) throw new Error(`${err.message}. Your data is safe; reload to try again.`)
            console.error(err)
          },
        )
      : Promise.resolve()
  await ready
  return openOwnerDb(ownerId)
}

export async function listRasters(): Promise<RasterOverlay[]> {
  const all = await (await db()).getAll('rasters')
  return all.sort((a, b) => b.addedAt - a.addedAt)
}

export async function saveRaster(raster: RasterOverlay): Promise<void> {
  await (await db()).put('rasters', raster)
}

export async function deleteRaster(id: string): Promise<void> {
  await (await db()).delete('rasters', id)
}

export async function listPhotos(featureId: string): Promise<FeaturePhoto[]> {
  const all = await (await db()).getAllFromIndex('photos', 'byFeature', featureId)
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function savePhoto(photo: FeaturePhoto): Promise<void> {
  await (await db()).put('photos', photo)
}

export async function deletePhoto(id: string): Promise<void> {
  await (await db()).delete('photos', id)
}

export async function deletePhotosForFeature(featureId: string): Promise<void> {
  const photos = await listPhotos(featureId)
  const store = await db()
  await Promise.all(photos.map((p) => store.delete('photos', p.id)))
}

export async function listFeatures(): Promise<UserFeature[]> {
  const all = await (await db()).getAll('features')
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveFeature(feature: UserFeature): Promise<void> {
  await (await db()).put('features', feature)
}

export async function deleteFeature(id: string): Promise<void> {
  await (await db()).delete('features', id)
}

export async function listLayers(): Promise<Layer[]> {
  return (await db()).getAll('layers')
}

export async function saveLayer(layer: Layer): Promise<void> {
  await (await db()).put('layers', layer)
}

export async function getIcon(id: string): Promise<IconAsset | undefined> {
  return (await db()).get('icons', id)
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
  /** Personal key-value data (never a shared cache key). */
  kv?: Record<string, unknown>
}): Promise<void> {
  const tx = (await db()).transaction(['layers', 'features', 'photos', 'icons', 'kv'], 'readwrite')
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

/** Personal key-value data, or a shared cache for a SHARED_CACHE_KEYS key. */
export async function getCached<T>(key: string): Promise<T | undefined> {
  if (SHARED_CACHE_KEYS.has(key)) return getSharedCache<T>(key)
  return (await (await db()).get('kv', key)) as T | undefined
}

export async function setCached(key: string, value: unknown): Promise<void> {
  if (SHARED_CACHE_KEYS.has(key)) return setSharedCache(key, value)
  await (await db()).put('kv', value, key)
}

export async function listOverlays(): Promise<Overlay[]> {
  const all = await (await db()).getAll('overlays')
  return all.sort((a, b) => b.addedAt - a.addedAt)
}

/** Ask the browser not to evict our offline data under storage pressure. */
export function requestPersistentStorage(): void {
  navigator.storage?.persist?.().catch(() => {})
}
