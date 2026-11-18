// @vitest-environment jsdom
/**
 * End-to-end migration on a real (in-memory) IndexedDB: seed the v5 database
 * the app shipped before layers, then let the storage code upgrade it to v6
 * and migrate. Nothing may be lost, and loading twice must not duplicate.
 * The app's modules are imported only after seeding, because the storage
 * module opens the database when it loads.
 */
import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Layer } from '../src/lib/layers'
import type { UserFeature } from '../src/lib/features'

const NOW = Date.parse('2026-07-15T18:00:00Z')
const req = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

const OLD_FEATURES = [
  { id: 'f-pin', kind: 'pin', name: 'Edge_JUL15_2P14', notes: 'old pin', color: '#e11d1d',
    coordinates: [-123.36, 48.43], createdAt: NOW, updatedAt: NOW },
  { id: 'f-guard', kind: 'line', name: 'DGd_JUL15', notes: '', color: '#111111', layer: 'Guards',
    coordinates: [[-123.36, 48.43], [-123.35, 48.44]], attributes: [{ k: 'Operator', v: 'Cat 1' }],
    createdAt: NOW + 1, updatedAt: NOW + 1 },
  { id: 'f-dt', kind: 'pin', name: 'DT 4', notes: '', color: '#b45309', symbol: 'danger-tree', layer: 'Danger trees',
    coordinates: [-123.34, 48.44], geofence: { enabled: true, radiusM: 50 }, createdAt: NOW + 2, updatedAt: NOW + 2 },
  { id: 'f-trk', kind: 'line', name: 'Track 1', notes: '1.2 km', color: '#38bdf8', layer: 'Tracks',
    coordinates: [[-123.3, 48.4], [-123.31, 48.41]], times: [NOW, NOW + 60000], createdAt: NOW + 3, updatedAt: NOW + 3 },
]

async function seedV5() {
  const open = indexedDB.open('carmanah-maps', 5)
  open.onupgradeneeded = () => {
    const db = open.result
    db.createObjectStore('overlays', { keyPath: 'id' })
    db.createObjectStore('kv')
    db.createObjectStore('features', { keyPath: 'id' })
    db.createObjectStore('photos', { keyPath: 'id' }).createIndex('byFeature', 'featureId')
    db.createObjectStore('rasters', { keyPath: 'id' })
  }
  const db = await req(open)
  const tx = db.transaction(['overlays', 'features', 'photos'], 'readwrite')
  for (const f of OLD_FEATURES) tx.objectStore('features').put(f)
  // Photo bytes aren't touched by the migration; only the link matters here.
  tx.objectStore('photos').put({ id: 'p1', featureId: 'f-dt', blob: new Uint8Array([1, 2, 3]), createdAt: NOW })
  tx.objectStore('overlays').put({
    id: 'o1', name: 'Fire perimeter', addedAt: NOW - 5000, sourceUrl: 'https://example.invalid/perim.kmz',
    geojson: { type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { name: 'Perimeter', stroke: '#ff0000', 'stroke-width': 2, fill: '#ff0000',
        'fill-opacity': 0.15, styleUrl: '#p', FIRE_NUMBER: 'V12345' },
        geometry: { type: 'Polygon', coordinates: [[[-123.4, 48.4], [-123.3, 48.4], [-123.3, 48.5], [-123.4, 48.4]]] } },
      { type: 'Feature', properties: { name: 'ICP', 'marker-color': '#00ff00' }, geometry: { type: 'Point', coordinates: [-123.35, 48.45] } },
    ] },
  })
  await new Promise((resolve) => (tx.oncomplete = resolve))
  db.close()
}

async function rawDump() {
  const db = await req(indexedDB.open('carmanah-maps'))
  const all = <T,>(store: string) => req(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>
  const dump = {
    version: db.version,
    stores: [...db.objectStoreNames],
    features: await all<UserFeature>('features'),
    layers: await all<Layer>('layers'),
    overlays: await all<unknown>('overlays'),
    photos: await all<{ featureId: string }>('photos'),
    flag: await req(db.transaction('kv').objectStore('kv').get('migrated:layers-v1')),
  }
  db.close()
  return dump
}

describe('migrating a v5 database', () => {
  let first: Awaited<ReturnType<typeof import('../src/lib/mydata').loadMyData>>
  let loadMyData: typeof import('../src/lib/mydata').loadMyData
  beforeAll(async () => {
    await seedV5()
    ;({ loadMyData } = await import('../src/lib/mydata'))
    first = await loadMyData()
  })
  const layerNamed = (name: string) => first.layers.find((l) => l.name === name)

  it('creates layers from the old names and the overlay', () => {
    expect(first.layers.map((l) => l.name).sort()).toEqual(['Danger trees', 'Fire perimeter', 'Guards', 'Placemarks', 'Tracks'])
  })

  it('keeps every old feature field for field, with a layerId instead of a layer name', () => {
    for (const old of OLD_FEATURES) {
      const now = first.features.find((f) => f.id === old.id)!
      const { layer, ...rest } = old as typeof old & { layer?: string }
      expect(now).toEqual({ ...rest, layerId: layerNamed(layer ?? 'Placemarks')!.id })
    }
  })

  it('turns the overlay into editable features with their styles and attributes', () => {
    const perim = first.features.filter((f) => f.layerId === layerNamed('Fire perimeter')!.id)
    expect(perim.map((f) => [f.kind, f.name, f.color, f.fillOpacity ?? null, f.attributes ?? null])).toEqual([
      ['area', 'Perimeter', '#ff0000', 0.15, [{ k: 'FIRE_NUMBER', v: 'V12345' }]],
      ['pin', 'ICP', '#00ff00', null, null],
    ])
    expect(layerNamed('Fire perimeter')!.source?.url).toBe('https://example.invalid/perim.kmz')
  })

  it('stores it all as v6, keeps the overlay as a backup and the photo linked', async () => {
    const raw = await rawDump()
    expect(raw.version).toBe(6)
    expect(raw.stores).toEqual(expect.arrayContaining(['layers', 'icons']))
    expect(raw.features).toHaveLength(OLD_FEATURES.length + 2)
    expect(raw.features.every((f) => f.layerId && !('layer' in f))).toBe(true)
    expect(raw.layers).toHaveLength(5)
    expect(raw.overlays).toHaveLength(1)
    expect(raw.photos.map((p) => p.featureId)).toEqual(['f-dt'])
    expect(raw.flag).toBe(true)
  })

  it('does nothing the second time', async () => {
    const second = await loadMyData()
    expect(second.layers).toHaveLength(first.layers.length)
    expect(second.features).toHaveLength(first.features.length)
  })
})
