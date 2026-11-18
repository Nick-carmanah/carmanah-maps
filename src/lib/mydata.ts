/**
 * My Data on disk: loading (with the one-time migration to layers),
 * committing imports, and the read API for other modules.
 * Storage itself stays in store.ts.
 */
import { DEFAULT_LAYERS, type UserFeature } from './features'
import { geojsonToImport } from './importers'
import {
  newLayer,
  photoRecords,
  visibleStyledFeatures,
  type ImportResult,
  type Layer,
  type StyledFeature,
} from './layers'
import {
  getCached,
  listFeatures,
  listLayers,
  listOverlays,
  writeBatch,
  type Overlay,
} from './store'

export const MIGRATION_KEY = 'migrated:layers-v1'

export interface MyData {
  layers: Layer[]
  features: UserFeature[]
}

/**
 * Plan the move from the old model (a layer *name* on each drawn feature,
 * imported files as separate read-only overlays) to layers. Pure: returns
 * what to write.
 *
 * - Each distinct old layer name becomes a top-level layer (first-seen
 *   order); features get its id and lose the old name.
 * - Each overlay becomes a layer of editable features, with its attributes
 *   and KML styles (the overlay record itself is left as a backup).
 */
export function planMigration(
  features: UserFeature[],
  overlays: Overlay[],
  existing: Layer[],
): { layers: Layer[]; features: UserFeature[]; overlayResults: ImportResult[] } {
  const layers: Layer[] = []
  const byName = new Map<string, Layer>()
  for (const l of existing) if (!l.parentId && !byName.has(l.name)) byName.set(l.name, l)
  let order = existing.filter((l) => !l.parentId).length
  const known = new Set(existing.map((l) => l.id))
  const migrated: UserFeature[] = []
  for (const f of features) {
    const hasLayer = !!f.layerId && known.has(f.layerId)
    if (hasLayer && f.layer === undefined) continue
    const name = f.layer?.trim() || DEFAULT_LAYERS[f.kind] || 'Placemarks'
    let layer = byName.get(name)
    if (!layer) {
      layer = newLayer(name, { order: order++, style: { color: f.color } })
      byName.set(name, layer)
      layers.push(layer)
    }
    const { layer: _old, ...rest } = f
    void _old
    migrated.push({ ...rest, layerId: hasLayer ? f.layerId : layer.id })
  }
  const overlayResults = [...overlays]
    .sort((a, b) => a.addedAt - b.addedAt)
    .map((o) => {
      const result = geojsonToImport(o.name, o.geojson, {
        kind: 'migrated',
        fileName: o.name,
        url: o.sourceUrl,
        importedAt: o.addedAt,
      })
      for (const l of result.layers) if (!l.parentId) l.order = order++
      for (const f of result.features) {
        if (f.createdAt === result.layers[0]?.createdAt) {
          f.createdAt = o.addedAt
          f.updatedAt = o.addedAt
        }
      }
      return result
    })
  return { layers, features: migrated, overlayResults }
}

/** Load layers and features, migrating old data on first run. */
export async function loadMyData(): Promise<MyData> {
  const [layers, features, done] = await Promise.all([
    listLayers(),
    listFeatures(),
    getCached<boolean>(MIGRATION_KEY),
  ])
  // Old-model features, plus any whose layer is missing (so nothing is ever
  // stranded where the layer list can't reach it).
  const layerIds = new Set(layers.map((l) => l.id))
  const orphans = features.filter((f) => !layerIds.has(f.layerId) || f.layer !== undefined)
  if (done && !orphans.length) return { layers, features }

  const overlays = done ? [] : await listOverlays()
  const plan = planMigration(orphans, overlays, layers)
  const newLayers = [...plan.layers, ...plan.overlayResults.flatMap((r) => r.layers)]
  const newFeatures = plan.overlayResults.flatMap((r) => r.features)
  // One transaction: the flag is only set if every record landed.
  await writeBatch({
    layers: newLayers,
    features: [...plan.features, ...newFeatures],
    kv: { [MIGRATION_KEY]: true },
  })
  const migratedIds = new Set(plan.features.map((f) => f.id))
  return {
    layers: [...layers, ...newLayers],
    features: [...features.filter((f) => !migratedIds.has(f.id)), ...plan.features, ...newFeatures],
  }
}

/** Save everything an import produced, atomically. */
export async function commitImport(result: ImportResult): Promise<void> {
  await writeBatch({
    layers: result.layers,
    features: result.features,
    photos: photoRecords(result),
    icons: result.icons,
  })
}

/** Delete layers (with their sublayers' ids already included), their
 * features and those features' photos. */
export async function deleteLayersAndFeatures(layerIds: string[], featureIds: string[]): Promise<void> {
  await writeBatch({ deleteLayerIds: layerIds, deleteFeatureIds: featureIds })
}

/** Read API: visible features with their styles, straight from storage
 * (for the send-area-as-GeoPDF writer). */
export async function loadVisibleStyledFeatures(): Promise<StyledFeature[]> {
  const { layers, features } = await loadMyData()
  return visibleStyledFeatures(layers, features)
}
