// @vitest-environment jsdom
/**
 * Importing KML/KMZ into editable layers (src/lib/kml.ts): Avenza-style
 * Schema/SchemaData with picklists, Google-style <Data>, Folders → sublayers,
 * styles, and KMZ photos and custom icons. Fixtures are synthetic (see
 * test/fixtures/layers.ts); assumptions are listed in docs/avenza-layers.md.
 */
// The storage module opens IndexedDB on import; tests use an in-memory one.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { parseKmlBytes, parseKmz } from '../src/lib/kml'
import { parseImportedFile } from '../src/lib/importers'
import { layerPath } from '../src/lib/layers'
import { AVENZA_KML, bytesOf, fakeImage, GOOGLE_KML, pointShapefile } from './fixtures/layers'

const PHOTO_1 = fakeImage('jpeg', 'photo 1')
const PHOTO_2 = fakeImage('jpeg', 'photo 2')
const PHOTO_3 = fakeImage('jpeg', 'photo 3')
const ICON = fakeImage('png', 'hydrant icon')

async function avenzaKmz() {
  const zip = zipSync({
    'doc.kml': strToU8(AVENZA_KML),
    'images/Placemark 1.jpg': await bytesOf(PHOTO_1),
    'images/Placemark 2.jpg': await bytesOf(PHOTO_2),
    'images/Placemark 2 (1).jpg': await bytesOf(PHOTO_3),
    'files/hydrant icon.png': await bytesOf(ICON),
  })
  return parseKmz(zip, { fileName: 'Hydrant inspection.kmz', format: 'kmz' })
}

describe('Avenza-style KMZ', async () => {
  const r = await avenzaKmz()
  const [p1, p2, icon, track, area] = r.features
  const photoNames = (id: string) => r.photos.filter((p) => p.featureId === id).map((p) => p.name)

  it('turns nested Folders into a layer and sublayer', () => {
    expect(r.layers.map((l) => layerPath(r.layers, l.id))).toEqual([
      'Hydrant inspection',
      'Hydrant inspection / Hydrants',
    ])
    expect(r.layers[1].parentId).toBe(r.layers[0].id)
    expect(r.features.map((f) => `${f.kind}:${f.name}:${layerPath(r.layers, f.layerId)}`)).toEqual([
      'pin:Placemark 1:Hydrant inspection / Hydrants',
      'pin:Placemark 2:Hydrant inspection / Hydrants',
      'pin:Custom icon:Hydrant inspection / Hydrants',
      'line:Track 1:Hydrant inspection',
      'area:Area 1:Hydrant inspection',
    ])
  })

  it('reads the typed Schema and its picklists (built-in fields and empty picklists skipped)', () => {
    expect(r.layers[1].schema).toEqual([
      { name: 'Status', type: 'string', picklist: ['OK', 'Damaged', 'Missing'] },
      { name: 'Flushed', type: 'boolean' },
      { name: 'Pressure kPa', type: 'real' },
      { name: 'Outlets', type: 'integer' },
    ])
    expect(r.layers[0].schema).toEqual([])
  })

  it('reads SchemaData values as attributes and the Description field as notes', () => {
    expect(p1.notes).toBe('Cap missing & leaking')
    expect(p1.attributes).toEqual([
      { k: 'Status', v: 'Damaged' },
      { k: 'Flushed', v: 'true' },
      { k: 'Pressure kPa', v: '412.5' },
      { k: 'Outlets', v: '2' },
    ])
    expect(p2.attributes).toEqual([{ k: 'Status', v: 'OK' }, { k: 'Flushed', v: 'false' }])
  })

  it('keeps styles: folder default, pin colours, line and fill', () => {
    expect(r.layers[0].style).toEqual({ color: '#ff802f', width: 4, fill: '#ff802f', fillOpacity: 0.5 })
    expect([p1.color, p1.iconHref]).toEqual(['#e11d1d', 'http://download.avenza.com/images/pdfmaps_icons/red_pin.png'])
    expect(p2.color).toBe('#facc15')
    expect([track.color, track.width]).toEqual(['#ff802e', 4])
    expect([area.color, area.width, area.fill, area.fillOpacity]).toEqual(['#ff0000', 2, '#ff0000', 0.3])
  })

  it('keeps coordinates, altitude, TimeStamp and gx:Track times', () => {
    expect(p1.coordinates).toEqual([-123.3651, 48.4284, 12.5])
    expect(icon.coordinates).toEqual([-123.3611, 48.4311]) // altitude 0 is "none"
    expect(p1.createdAt).toBe(Date.parse('2026-07-21T11:15:47-07:00'))
    expect(track.times).toEqual(
      ['10:11:04', '10:11:11', '10:11:19'].map((t) => Date.parse(`2026-07-21T${t}-07:00`)),
    )
    expect((track.coordinates as number[][])[2]).toEqual([-123.368, 48.4222, 21.7])
    expect(area.coordinates).toHaveLength(4) // ring stored unclosed
  })

  it('restores photos from images/ onto their placemarks, in order, byte for byte', async () => {
    expect(photoNames(p1.id)).toEqual(['images/Placemark 1.jpg'])
    expect(photoNames(p2.id)).toEqual(['images/Placemark 2.jpg', 'images/Placemark 2 (1).jpg'])
    expect(photoNames(icon.id)).toEqual([])
    expect(await bytesOf(r.photos[0].blob)).toEqual(await bytesOf(PHOTO_1))
    expect(await bytesOf(r.photos[2].blob)).toEqual(await bytesOf(PHOTO_3))
    expect(r.photos[0].blob.type).toBe('image/jpeg')
  })

  it('restores a custom icon from files/ as the pin symbol', async () => {
    expect(r.icons).toHaveLength(1)
    expect(icon.symbol).toBe(`icon-${r.icons[0].id}`)
    expect(await bytesOf(r.icons[0].blob)).toEqual(await bytesOf(ICON))
  })

  it('has no warnings', () => {
    expect(r.warnings).toEqual([])
  })
})

describe('Google Earth-style KML', () => {
  const r = parseKmlBytes(strToU8(GOOGLE_KML), { fileName: 'notes.kml', format: 'kml' })
  const [spot, island] = r.features

  it('puts loose placemarks in one layer named after the Document', () => {
    expect(r.layers.map((l) => l.name)).toEqual(['Field notes'])
    expect(r.features.map((f) => `${f.kind}:${f.name}`)).toEqual(['pin:Spot fire', 'area:Island', 'pin:Combo', 'line:Combo'])
  })

  it('reads <Data> as per-feature attributes, not schema fields', () => {
    expect(spot.attributes).toEqual([{ k: 'Reported by', v: 'Crew 2' }, { k: 'Size ha', v: '0.1' }])
    expect(r.layers[0].schema).toEqual([])
  })

  it('follows a StyleMap to its normal style, and turns HTML descriptions into text', () => {
    expect([spot.color, spot.iconHref]).toEqual(['#ffff00', 'http://maps.google.com/mapfiles/kml/pushpin/wht-pushpin.png'])
    expect(spot.notes).toBe('Smoke seen at 14:05\nCrew notified')
    expect(spot.coordinates).toEqual([-123.3, 48.45])
  })

  it('keeps polygon holes and <fill>0</fill>', () => {
    expect([island.holes?.length, island.holes?.[0].length, island.fillOpacity, island.color, island.width]).toEqual([1, 4, 0, '#00ff00', 3])
  })

  it('warns about what it skipped', () => {
    expect(r.warnings).toEqual([
      '1 image overlay(s) not imported (use GeoPDF import for maps)',
      '1 item without usable coordinates skipped',
    ])
  })
})

describe('KMZ photos referenced from files/', () => {
  it('attaches an <img> in the description to its placemark', async () => {
    const smoke = fakeImage('jpeg', 'smoke')
    const zip = zipSync({ 'doc.kml': strToU8(GOOGLE_KML), 'files/smoke.jpg': await bytesOf(smoke) })
    const r = parseKmz(zip, { fileName: 'notes.kmz', format: 'kmz' })
    const spot = r.features.find((f) => f.name === 'Spot fire')!
    const photos = r.photos.filter((p) => p.featureId === spot.id)
    expect(photos.map((p) => p.name)).toEqual(['files/smoke.jpg'])
    expect(await bytesOf(photos[0].blob)).toEqual(await bytesOf(smoke))
    expect(spot.notes).toBe('Smoke seen at 14:05\nCrew notified')
  })
})

describe('zipped files', () => {
  const hydrants = pointShapefile(
    [{ x: -123.1, y: 49.2, attrs: ['Hydrant A', 3, 1.25] }, { x: -123.2, y: 49.3, attrs: ['Hydrant B', 4, 2] }],
    [{ name: 'NAME', type: 'C', len: 20 }, { name: 'OUTLETS', type: 'N', len: 4 }, { name: 'PRESSURE', type: 'N', len: 8, dec: 2 }],
  )
  const camps = pointShapefile([{ x: -122, y: 50, attrs: ['Camp'] }], [{ name: 'LABEL', type: 'C', len: 10 }])
  const file = (entries: Record<string, Uint8Array>, name: string) =>
    new File([zipSync(entries) as Uint8Array<ArrayBuffer>], name)
  const round = (n: number) => Math.round(n * 1e9) / 1e9

  it('reads a zip of shapefiles as a layer with one sublayer per shapefile', async () => {
    const r = await parseImportedFile(
      file({ 'hydrants.shp': hydrants.shp, 'hydrants.shx': hydrants.shx, 'hydrants.dbf': hydrants.dbf, 'hydrants.prj': hydrants.prj,
        'camps.shp': camps.shp, 'camps.shx': camps.shx, 'camps.dbf': camps.dbf, 'camps.prj': camps.prj }, 'Assets.zip'),
    )
    expect(r.layers.map((l) => layerPath(r.layers, l.id)).sort()).toEqual(['Assets', 'Assets / camps', 'Assets / hydrants'])
    expect(r.layers.find((l) => l.name === 'hydrants')!.schema).toEqual([
      { name: 'OUTLETS', type: 'integer' },
      { name: 'PRESSURE', type: 'real' },
    ])
    const rows = r.features
      .map((f) => [f.name, (f.coordinates as number[]).map(round), f.attributes])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(rows).toEqual([
      ['Camp', [-122, 50], undefined],
      ['Hydrant A', [-123.1, 49.2], [{ k: 'OUTLETS', v: '3' }, { k: 'PRESSURE', v: '1.25' }]],
      ['Hydrant B', [-123.2, 49.3], [{ k: 'OUTLETS', v: '4' }, { k: 'PRESSURE', v: '2' }]],
    ])
  })

  it('reads a single shapefile as one layer named after the zip', async () => {
    const r = await parseImportedFile(
      file({ 'h.shp': hydrants.shp, 'h.shx': hydrants.shx, 'h.dbf': hydrants.dbf, 'h.prj': hydrants.prj }, 'Hydrants only.zip'),
    )
    expect(r.layers.map((l) => l.name)).toEqual(['Hydrants only'])
  })

  it('reads a KML inside a .zip', async () => {
    const r = await parseImportedFile(file({ 'doc.kml': strToU8(GOOGLE_KML) }, 'notes.zip'))
    expect(r.features).toHaveLength(4)
  })
})
