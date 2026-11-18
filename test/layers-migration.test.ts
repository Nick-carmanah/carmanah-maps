// @vitest-environment jsdom
/**
 * Migration from the old data model (features with a free-text `layer` name,
 * plus read-only KML/GPX overlays) to editable layers (src/lib/mydata.ts).
 * It runs once, on the crew's own data, so nothing may be lost.
 */
// The storage module opens IndexedDB on import; tests use an in-memory one.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import type { FeatureCollection } from 'geojson'
import { planMigration } from '../src/lib/mydata'
import { DEFAULT_LAYERS, type UserFeature } from '../src/lib/features'
import type { Overlay } from '../src/lib/store'

const NOW = Date.parse('2026-07-15T18:00:00Z')

/** Old-model features exactly as v5 stored them (`layer` name, no `layerId`). */
function legacyFeatures(): UserFeature[] {
  return [
    { id: 'f-pin', kind: 'pin', name: 'Edge_JUL15_2P14', notes: 'old pin', color: '#e11d1d',
      coordinates: [-123.36, 48.43], createdAt: NOW, updatedAt: NOW },
    { id: 'f-guard', kind: 'line', name: 'DGd_JUL15', notes: '', color: '#111111', layer: 'Guards',
      coordinates: [[-123.36, 48.43], [-123.35, 48.44]], attributes: [{ k: 'Operator', v: 'Cat 1' }],
      createdAt: NOW + 1, updatedAt: NOW + 1 },
    { id: 'f-dt', kind: 'pin', name: 'DT 4', notes: 'class 3', color: '#b45309', symbol: 'danger-tree',
      layer: 'Danger trees', coordinates: [-123.34, 48.44], geofence: { enabled: true, radiusM: 50 },
      createdAt: NOW + 2, updatedAt: NOW + 2 },
    { id: 'f-trk', kind: 'line', name: 'Track 1', notes: '1.2 km', color: '#38bdf8', layer: 'Tracks',
      coordinates: [[-123.3, 48.4], [-123.31, 48.41]], times: [NOW, NOW + 60000],
      createdAt: NOW + 3, updatedAt: NOW + 3 },
    { id: 'f-area', kind: 'area', name: 'Unit A', notes: '', color: '#22c55e', layer: '  Guards  ',
      coordinates: [[-123.3, 48.4], [-123.2, 48.4], [-123.2, 48.5]], createdAt: NOW + 4, updatedAt: NOW + 4 },
  ] as unknown as UserFeature[]
}

const OVERLAY: Overlay = {
  id: 'o1',
  name: 'Fire perimeter',
  addedAt: NOW - 5000,
  sourceUrl: 'https://example.invalid/perim.kmz',
  geojson: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Perimeter', stroke: '#ff0000', 'stroke-width': 2, fill: '#ff0000',
          'fill-opacity': 0.2, FIRE_NUM: 'K1', AREA_HA: 512.3, styleUrl: '#s' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [[[-120, 50], [-119, 50], [-119, 51], [-120, 50]], [[-119.8, 50.2], [-119.6, 50.2], [-119.6, 50.4], [-119.8, 50.2]]],
            [[[-118, 50], [-117.5, 50], [-117.5, 50.5], [-118, 50]]],
          ],
        },
      },
      { type: 'Feature', properties: { name: 'Camp', 'marker-color': '#00ff00', description: '<b>Main</b> camp' },
        geometry: { type: 'Point', coordinates: [-120.5, 50.5, 0] } },
      { type: 'Feature', properties: { name: 'Bad' }, geometry: null as never },
    ],
  } as FeatureCollection,
}

describe('planMigration: old layer names', () => {
  const legacy = legacyFeatures()
  const plan = planMigration(legacy, [], [])
  const layerName = (id: string) => plan.layers.find((l) => l.id === id)?.name

  it('makes one top-level layer per old name, with the unnamed default for features that had none', () => {
    expect(plan.layers.map((l) => l.name)).toEqual([DEFAULT_LAYERS.pin, 'Guards', 'Danger trees', 'Tracks'])
    expect(plan.layers.every((l) => !l.parentId && l.visible)).toBe(true)
    // Names are trimmed, so "  Guards  " joins "Guards".
    expect(layerName(plan.features.find((f) => f.id === 'f-area')!.layerId)).toBe('Guards')
  })

  it('keeps every field of every feature, swapping only `layer` for `layerId`', () => {
    expect(plan.features).toHaveLength(legacy.length)
    for (const old of legacy) {
      const next = plan.features.find((f) => f.id === old.id)!
      const { layer: oldName, ...rest } = old
      expect(next).toEqual({ ...rest, layerId: next.layerId })
      expect('layer' in next).toBe(false)
      expect(layerName(next.layerId)).toBe(oldName?.trim() || DEFAULT_LAYERS[old.kind])
    }
  })

  it('reuses existing layers and leaves migrated features alone (runs once)', () => {
    const again = planMigration(plan.features, [], plan.layers)
    expect(again.layers).toEqual([])
    expect(again.features).toEqual([])
  })

  it('rescues features that point at a layer that no longer exists', () => {
    const orphan = { ...plan.features[0], id: 'orphan', layerId: 'gone' }
    const rescue = planMigration([orphan], [], plan.layers)
    expect(rescue.layers).toEqual([])
    expect(rescue.features).toHaveLength(1)
    expect(plan.layers.find((l) => l.id === rescue.features[0].layerId)?.name).toBe(DEFAULT_LAYERS.pin)
  })
})

describe('planMigration: overlays become editable layers', () => {
  const plan = planMigration([], [OVERLAY], [])
  const ov = plan.overlayResults[0]

  it('turns an overlay into a layer that remembers where it came from', () => {
    expect(ov.layers.map((l) => [l.name, l.source?.kind, l.source?.url])).toEqual([
      ['Fire perimeter', 'migrated', 'https://example.invalid/perim.kmz'],
    ])
  })

  it('types the attribute schema from the values', () => {
    expect(ov.layers[0].schema).toEqual([
      { name: 'FIRE_NUM', type: 'string' },
      { name: 'AREA_HA', type: 'real' },
    ])
  })

  it('keeps geometry, holes, styles, attributes and notes', () => {
    expect(ov.features.map((f) => [f.kind, f.name, f.holes?.length ?? 0, f.color, f.width ?? null, f.fillOpacity ?? null])).toEqual([
      ['area', 'Perimeter', 1, '#ff0000', 2, 0.2],
      ['area', 'Perimeter', 0, '#ff0000', 2, 0.2],
      ['pin', 'Camp', 0, '#00ff00', null, null],
    ])
    const [outer] = ov.features
    expect(outer.coordinates).toEqual([[-120, 50], [-119, 50], [-119, 51]])
    expect(outer.holes).toEqual([[[-119.8, 50.2], [-119.6, 50.2], [-119.6, 50.4]]])
    expect(outer.attributes).toEqual([{ k: 'FIRE_NUM', v: 'K1' }, { k: 'AREA_HA', v: '512.3' }])
    expect(ov.features[2].notes).toBe('Main camp')
    expect(ov.features[2].coordinates).toEqual([-120.5, 50.5])
    expect(ov.features.every((f) => f.layerId === ov.layers[0].id)).toBe(true)
  })

  it('dates the features from when the overlay was added', () => {
    expect(ov.features.every((f) => f.createdAt === OVERLAY.addedAt)).toBe(true)
  })

  it('reports what it could not keep', () => {
    expect(ov.warnings).toEqual(['1 item without usable coordinates skipped'])
  })

  it('orders overlay layers after the old-name layers', () => {
    const both = planMigration(legacyFeatures(), [OVERLAY], [])
    expect(both.overlayResults[0].layers[0].order).toBe(both.layers.length)
  })
})
