// @vitest-environment jsdom
/**
 * Export → import round trips (src/lib/export.ts back through the importers).
 * A model with nested layers, typed schemas, every geometry kind, holes,
 * built-in and imported symbols, geofences, track times and photos must come
 * back identical from KMZ; KML, GPX and CSV keep what each format can hold.
 * Also checks that a third-party reader (@tmcw/togeojson) reads our KML.
 */
// The storage module opens IndexedDB on import; tests use an in-memory one.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { kml as tgKml, kmlWithFolders, type Folder, type Root } from '@tmcw/togeojson'
import { parseKmlBytes, parseKmz } from '../src/lib/kml'
import { parseCsvText, parseGpxBytes } from '../src/lib/importers'
import {
  featuresToCsv,
  featuresToGpx,
  featuresToKml,
  featuresToKmz,
  type ExportInput,
  type ExportOptions,
} from '../src/lib/export'
import { layerPath, newLayer, resolveStyle, visibleStyledFeatures, type Layer } from '../src/lib/layers'
import type { UserFeature } from '../src/lib/features'
import { AVENZA_KML, bytesOf, fakeImage } from './fixtures/layers'

const T0 = Date.parse('2026-08-01T09:00:00Z')

/** Our own data, plus an Avenza-style import (imported icon, remote pin hrefs, photos). */
async function buildModel(): Promise<ExportInput> {
  const avenza = parseKmz(
    zipSync({
      'doc.kml': strToU8(AVENZA_KML),
      'images/Placemark 1.jpg': await bytesOf(fakeImage('jpeg', 'p1')),
      'images/Placemark 2.jpg': await bytesOf(fakeImage('jpeg', 'p2')),
      'images/Placemark 2 (1).jpg': await bytesOf(fakeImage('jpeg', 'p3')),
      'files/hydrant icon.png': await bytesOf(fakeImage('png', 'icon')),
    }),
    { fileName: 'Hydrant inspection.kmz', format: 'kmz' },
  )
  const root = newLayer('Day 3', {
    order: 0,
    style: { color: '#3b82f6', width: 4, symbol: 'hazard' },
    schema: [
      { name: 'Crew', type: 'string', picklist: ['Alpha', 'Bravo'] },
      { name: 'Done', type: 'boolean' },
      { name: 'Count', type: 'integer' },
      { name: 'Area ha', type: 'real' },
    ],
  })
  const child = newLayer('Danger trees', {
    parentId: root.id,
    order: 0,
    visible: false,
    style: { color: '#b45309' },
    schema: [{ name: 'Class', type: 'string', picklist: ['1', '2', '3', '4'] }],
  })
  const tracks = newLayer('Tracks', { order: 1, style: { color: '#38bdf8' } })
  let i = 0
  const f = (p: Partial<UserFeature> & Pick<UserFeature, 'kind' | 'coordinates' | 'layerId' | 'name'>): UserFeature => {
    const at = T0 + i++ * 60000
    return { id: crypto.randomUUID(), notes: '', color: '#e11d1d', createdAt: at, updatedAt: at, ...p }
  }
  const features: UserFeature[] = [
    f({ kind: 'pin', name: 'White pin', layerId: root.id, color: '#ffffff', coordinates: [-121.1234567, 50.7654321],
      notes: 'Line 1\nA < B & "C" ]]> end',
      attributes: [{ k: 'Crew', v: 'Alpha' }, { k: 'Done', v: 'true' }, { k: 'Count', v: '3' }, { k: 'Area ha', v: '1.5' }, { k: 'Extra', v: 'x' }],
      geofence: { enabled: true, radiusM: 250 } }),
    f({ kind: 'pin', name: 'Helispot 1', layerId: root.id, color: '#1d4ed8', symbol: 'helispot', coordinates: [-121.2, 50.8] }),
    f({ kind: 'pin', name: 'Aerial hazard', layerId: root.id, color: '#facc15', symbol: 'nwcg-aerial-hazard', coordinates: [-121.21, 50.81, 845.2] }),
    f({ kind: 'line', name: 'Guard', layerId: child.id, color: '#111111', width: 6,
      coordinates: [[-121.3, 50.9], [-121.31, 50.91], [-121.32, 50.9]], attributes: [{ k: 'Class', v: '3' }] }),
    f({ kind: 'area', name: 'Unit A', layerId: child.id, color: '#22c55e', fill: '#22c55e', fillOpacity: 0.4,
      coordinates: [[-121.4, 51], [-121.3, 51], [-121.3, 51.1], [-121.4, 51.1]],
      holes: [[[-121.36, 51.04], [-121.34, 51.04], [-121.34, 51.06]]] }),
    f({ kind: 'area', name: 'Outline only', layerId: child.id, color: '#a855f7', fillOpacity: 0, width: 2,
      coordinates: [[-121.5, 51], [-121.45, 51], [-121.45, 51.05]] }),
    f({ kind: 'line', name: 'Track_AUG01', layerId: tracks.id, color: '#38bdf8',
      coordinates: [[-121.6, 51.2], [-121.61, 51.21], [-121.62, 51.22], [-121.63, 51.23]],
      times: [T0, T0 + 5000, T0 + 11000, T0 + 17123] }),
  ]
  const photos = new Map<string, Blob[]>([[features[0].id, [fakeImage('jpeg', 'own 1'), fakeImage('png', 'own 2')]]])
  for (const p of avenza.photos) photos.set(p.featureId, [...(photos.get(p.featureId) ?? []), p.blob])
  const icons = new Map(avenza.icons.map((icon) => [`icon-${icon.id}`, icon.blob]))
  return {
    layers: [root, child, tracks, ...avenza.layers.map((l) => (l.parentId ? l : { ...l, order: 2 }))],
    features: [...features, ...avenza.features],
    photos,
    // The app draws built-in symbols on a canvas; any PNG will do here.
    symbolPng: async (s) => (s ? (icons.get(s) ?? fakeImage('png', `symbol ${s}`)) : null),
  }
}

const allOf = (input: ExportInput, format: ExportOptions['format']): ExportOptions => ({
  format,
  layerIds: input.layers.map((l) => l.id),
  includePhotos: true,
  tracksAsLines: false,
  docName: 'Round trip',
})

const iconOrKey = (s: string | undefined) => (s?.startsWith('icon-') ? 'icon' : (s ?? null))
const byAttr = (f: UserFeature) => [...(f.attributes ?? [])].sort((a, b) => a.k.localeCompare(b.k))

/** Ids change on import, so compare by layer path and content. */
function normLayers(layers: Layer[]) {
  return layers
    .map((l) => ({
      path: layerPath(layers, l.id),
      visible: l.visible,
      schema: l.schema.map((s) => ({ name: s.name, type: s.type, picklist: s.picklist ?? null })),
      style: {
        color: l.style.color,
        width: l.style.width ?? 3,
        fill: l.style.fill ?? l.style.color,
        fillOpacity: l.style.fillOpacity ?? 0.25,
        symbol: iconOrKey(l.style.symbol),
      },
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
function normFeatures(layers: Layer[], features: UserFeature[]) {
  return features
    .map((f) => {
      const style = resolveStyle(f)
      return {
        layer: layerPath(layers, f.layerId),
        kind: f.kind,
        name: f.name,
        notes: f.notes,
        coordinates: f.coordinates,
        holes: f.holes ?? null,
        style: { ...style, symbol: iconOrKey(style.symbol) },
        iconHref: f.iconHref ?? null,
        times: f.times ?? null,
        attributes: byAttr(f),
        geofence: f.geofence ?? null,
        createdAt: f.createdAt,
      }
    })
    .sort((a, b) => `${a.layer}|${a.name}|${a.kind}`.localeCompare(`${b.layer}|${b.name}|${b.kind}`))
}
const featureKey = (layers: Layer[], f: UserFeature) => `${layerPath(layers, f.layerId)}|${f.name}|${f.kind}`

describe('KMZ round trip', async () => {
  const input = await buildModel()
  const zipBytes = await bytesOf(await featuresToKmz(input, allOf(input, 'kmz')))
  const entries = unzipSync(zipBytes)
  const back = parseKmz(zipBytes, { fileName: 'Round trip.kmz', format: 'kmz' })

  it('lays the KMZ out like Avenza: doc.kml first, photos in images/, icons in files/', () => {
    const names = Object.keys(entries)
    expect(names[0]).toBe('doc.kml')
    expect(names.filter((n) => n.startsWith('images/'))).toHaveLength(5)
    expect(names).toEqual(expect.arrayContaining(['files/dot.png', 'files/helispot.png', 'files/nwcg-aerial-hazard.png']))
  })

  it('writes schemas the way Avenza does: built-in fields first, Avenza type names, avenza:picklist', () => {
    const dom = new DOMParser().parseFromString(strFromU8(entries['doc.kml']), 'application/xml')
    const folder = [...dom.getElementsByTagName('Folder')].find(
      (el) => el.getElementsByTagName('name')[0]?.textContent === 'Day 3',
    )!
    const schemaUrl = folder.getElementsByTagName('SchemaData')[0].getAttribute('schemaUrl')!
    const schema = [...dom.getElementsByTagName('Schema')].find((s) => s.getAttribute('id') === schemaUrl.slice(1))!
    expect([...schema.getElementsByTagName('SimpleField')].map((f) => `${f.getAttribute('name')}:${f.getAttribute('type')}`)).toEqual([
      'Description:string',
      'pdfmaps_photos:string',
      'Crew:string',
      'Done:bool',
      'Count:int',
      'Area ha:double',
    ])
    const picklists = [...dom.getElementsByTagNameNS('http://www.avenza.com', 'picklist')].filter(
      (p) => p.getAttribute('schemaUrl') === schemaUrl.slice(1),
    )
    expect(picklists.map((p) => [
      p.getAttributeNS('http://www.avenza.com', 'field'),
      [...p.getElementsByTagNameNS('http://www.avenza.com', 'picklistvalue')].map((v) => v.textContent),
    ])).toEqual([['Crew', ['Alpha', 'Bravo']]])
  })

  it('keeps the layer tree, visibility, schemas and default styles', () => {
    expect(normLayers(back.layers)).toEqual(normLayers(input.layers))
  })

  it('keeps every feature: geometry, holes, styles, attributes, notes, times, fences, dates', () => {
    expect(normFeatures(back.layers, back.features)).toEqual(normFeatures(input.layers, input.features))
    expect(back.warnings).toEqual([])
  })

  it('keeps photos byte for byte, in order, on the same features', async () => {
    const want: Record<string, Uint8Array[]> = {}
    for (const f of input.features) {
      const list = input.photos?.get(f.id)
      if (list?.length) want[featureKey(input.layers, f)] = await Promise.all(list.map(bytesOf))
    }
    const got: Record<string, Uint8Array[]> = {}
    for (const p of back.photos) {
      const k = featureKey(back.layers, back.features.find((f) => f.id === p.featureId)!)
      ;(got[k] ??= []).push(await bytesOf(p.blob))
    }
    expect(got).toEqual(want)
  })

  it('keeps imported icons byte for byte, and built-in symbols as symbol keys', async () => {
    const before = input.features.find((f) => f.name === 'Custom icon')!
    const after = back.features.find((f) => f.name === 'Custom icon')!
    const asset = back.icons.find((icon) => `icon-${icon.id}` === after.symbol)
    expect(asset).toBeDefined()
    expect(await bytesOf(asset!.blob)).toEqual(await bytesOf((await input.symbolPng!(before.symbol!))!))
    const keys = back.features.filter((f) => f.symbol && !f.symbol.startsWith('icon-')).map((f) => f.symbol)
    expect(keys.sort()).toEqual(['helispot', 'nwcg-aerial-hazard'])
  })

  it('writes KML that @tmcw/togeojson reads: typed values, notes, styles, times, holes, folders', () => {
    const dom = new DOMParser().parseFromString(strFromU8(entries['doc.kml']), 'application/xml')
    expect(dom.getElementsByTagName('parsererror')).toHaveLength(0)
    const fc = tgKml(dom)
    expect(fc.features).toHaveLength(input.features.length)
    const white = fc.features.find((f) => f.properties?.name === 'White pin')!.properties!
    expect([white.Crew, white.Done, white.Count, white['Area ha'], white.Extra]).toEqual(['Alpha', true, 3, 1.5, 'x'])
    expect(white.Description).toBe('Line 1\nA < B & "C" ]]> end')
    expect(white['icon-color']).toBe('#ffffff')
    const track = fc.features.find((f) => f.properties?.name === 'Track_AUG01')!
    expect((track.properties?.coordinateProperties as { times: string[] }).times).toHaveLength(4)
    const unit = fc.features.find((f) => f.properties?.name === 'Unit A')!
    expect((unit.geometry as { coordinates: unknown[] }).coordinates).toHaveLength(2)
    const folders = (n: Root | Folder): unknown[] =>
      n.children.filter((c): c is Folder => c.type === 'folder').map((c) => [c.meta.name, ...folders(c)])
    expect(folders(kmlWithFolders(dom))).toEqual([['Day 3', ['Danger trees']], ['Tracks'], ['Hydrant inspection', ['Hydrants']]])
  })
})

describe('KML, GPX and CSV round trips', async () => {
  const input = await buildModel()

  it('KML keeps everything except files (imported icons become plain pins, no photos)', () => {
    const text = featuresToKml(input, { ...allOf(input, 'kml'), includePhotos: false })
    const back = parseKmlBytes(strToU8(text), { fileName: 'rt.kml', format: 'kml' })
    const noIcon = (x: ReturnType<typeof normFeatures>) =>
      x.map((f) => ({ ...f, style: { ...f.style, symbol: f.style.symbol === 'icon' ? null : f.style.symbol } }))
    expect(noIcon(normFeatures(back.layers, back.features))).toEqual(noIcon(normFeatures(input.layers, input.features)))
    expect(back.photos).toEqual([])
  })

  it('GPX keeps names, notes, coordinates, track times, symbols and waypoint times', () => {
    const back = parseGpxBytes(strToU8(featuresToGpx(input, allOf(input, 'gpx'))), { fileName: 'rt.gpx' })
    const pick = (fs: UserFeature[]) =>
      fs
        .map((f) => ({
          kind: f.kind === 'area' ? 'line' : f.kind,
          name: f.name,
          notes: f.notes,
          coordinates: f.kind === 'area' ? [...(f.coordinates as number[][]), (f.coordinates as number[][])[0]] : f.coordinates,
          times: f.times ?? null,
          symbol: f.symbol?.startsWith('icon-') ? null : (f.symbol ?? null),
          created: f.kind === 'pin' ? f.createdAt : null,
        }))
        .sort((a, b) => `${a.name}|${a.kind}`.localeCompare(`${b.name}|${b.kind}`))
    expect(pick(back.features)).toEqual(pick(input.features))
  })

  it('GPX "tracks as lines" drops the track times', () => {
    const text = featuresToGpx(input, { ...allOf(input, 'gpx'), tracksAsLines: true })
    expect(text).not.toMatch(/<trkpt[^>]*>.*<time>/)
  })

  it('CSV keeps placemarks: coordinates, notes, layer, symbol, colour, date, attributes', () => {
    const back = parseCsvText(featuresToCsv(input, allOf(input, 'csv')), { fileName: 'rt.csv' })
    const pins = (layers: Layer[], fs: UserFeature[]) =>
      fs
        .filter((f) => f.kind === 'pin')
        .map((f) => ({
          layer: layerPath(layers, f.layerId),
          name: f.name,
          notes: f.notes,
          coordinates: f.coordinates,
          symbol: f.symbol?.startsWith('icon-') ? null : (f.symbol ?? null),
          color: f.color,
          createdAt: f.createdAt,
          attributes: byAttr(f),
        }))
        .sort((a, b) => `${a.layer}|${a.name}`.localeCompare(`${b.layer}|${b.name}`))
    expect(pins(back.layers, back.features)).toEqual(pins(input.layers, input.features))
    expect(back.features.every((f) => f.kind === 'pin')).toBe(true)
  })
})

describe('visibleStyledFeatures (read API for map writers)', async () => {
  const input = await buildModel()
  const vis = visibleStyledFeatures(input.layers, input.features)

  it('leaves out features in hidden layers', () => {
    const names = vis.map((v) => v.feature.name)
    expect(names).toContain('White pin')
    expect(names).not.toContain('Guard')
  })

  it('resolves each feature style against its layer defaults', () => {
    expect(vis.find((v) => v.feature.name === 'Helispot 1')!.style).toEqual({
      color: '#1d4ed8',
      width: 3,
      fill: '#1d4ed8',
      fillOpacity: 0.25,
      symbol: 'helispot',
    })
  })
})
