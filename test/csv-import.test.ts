// @vitest-environment jsdom
/**
 * CSV import (src/lib/importers.ts): finding the latitude/longitude columns
 * under the names, delimiters, decimal commas and coordinate formats that
 * spreadsheets and other apps produce. All rows are invented.
 */
// The storage module opens IndexedDB on import; tests use an in-memory one.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { parseCsvText } from '../src/lib/importers'
import { layerPath } from '../src/lib/layers'
import { formatCoord } from '../src/lib/coords'
import { CSV_VARIANTS } from './fixtures/layers'

const round = (n: number) => Math.round(n * 1e6) / 1e6
const coords = (text: string) =>
  parseCsvText(text, { fileName: 'x.csv' }).features.map((f) => (f.coordinates as number[]).map(round))

describe('CSV latitude/longitude detection', () => {
  it.each(CSV_VARIANTS)('$name', ({ text, expect: want }) => {
    expect(coords(text)).toEqual(want.map((p) => p.map(round)))
  })

  it.each([
    ['lat/lng', 'lat,lng\n49.1,-123.2\n'],
    ['Latitude/Longitude', 'Latitude,Longitude\n49.1,-123.2\n'],
    ['y/x', 'y,x\n49.1,-123.2\n'],
    ['names that start with lat/lon', 'Lat_deg,Long_deg\n49.1,-123.2\n'],
    ['one "lat, lon" column', 'Name,Coordinates\nP,"49.1, -123.2"\n'],
    ['decimal degrees with hemispheres', 'lat,lon\n49.1N,123.2W\n'],
  ])('%s', (_label, text) => {
    expect(coords(text)).toEqual([[-123.2, 49.1]])
  })

  it('reads MGRS and UTM columns, and Zone/Easting/Northing columns', () => {
    const at: [number, number] = [-123.3651, 48.4284]
    const mgrs = formatCoord(at, 'mgrs')
    const utm = formatCoord(at, 'utm')
    const [zone, east, north] = utm.replace(/[^\dA-Z. ]/gi, ' ').trim().split(/\s+/)
    for (const text of [
      `name,MGRS\nM,"${mgrs}"\n`,
      `name,UTM\nU,"${utm}"\n`,
      `name,Zone,Easting,Northing\nZ,${zone},${east},${north}\n`,
    ]) {
      const [[lon, lat]] = coords(text)
      expect(lon).toBeCloseTo(at[0], 4)
      expect(lat).toBeCloseTo(at[1], 4)
    }
  })

  it('throws when it finds no coordinates', () => {
    expect(() => parseCsvText('name,notes\nA,b\n', { fileName: 'x.csv' })).toThrow()
  })
})

describe('CSV columns', () => {
  it('maps name and notes columns, keeps quoted delimiters, and keeps the rest as attributes', () => {
    const r = parseCsvText(CSV_VARIANTS[0].text, { fileName: 'x.csv' })
    expect([r.features[1].name, r.features[1].notes]).toEqual(['B', 'two; quoted'])
    const wkt = parseCsvText(CSV_VARIANTS[2].text, { fileName: 'x.csv' })
    expect(wkt.features[0].attributes).toEqual([{ k: 'id', v: '1' }, { k: 'kind', v: 'x' }])
  })

  it('types attribute columns from their values', () => {
    const r = parseCsvText(CSV_VARIANTS[4].text, { fileName: 'x.csv' })
    expect(r.layers[0].schema).toEqual([{ name: 'Count', type: 'integer' }])
  })

  it('files rows into nested layers from a Layer column', () => {
    const r = parseCsvText('Name,Latitude,Longitude,Layer\nA,49,-123,Day 3 / Hazards\nB,49.1,-123.1,Day 3\n', {
      fileName: 'x.csv',
    })
    expect(r.layers.map((l) => layerPath(r.layers, l.id))).toEqual(['Day 3', 'Day 3 / Hazards'])
    expect(r.features.map((f) => layerPath(r.layers, f.layerId))).toEqual(['Day 3 / Hazards', 'Day 3'])
  })

  it('reads the old Carmanah CSV export: k=v attributes, line/area rows skipped with a warning', () => {
    const old = parseCsvText(
      'name,kind,latitude,longitude,measurement,notes,attributes,created\n' +
        '"P1",pin,48.1,-123.1,"48.1, -123.1","n","Crew=A; Done=yes",2026-07-01T00:00:00.000Z\n' +
        '"L1",line,48.2,-123.2,"1 km","","",2026-07-01T00:00:00.000Z\n',
      { fileName: 'old.csv' },
    )
    expect(old.features).toHaveLength(1)
    expect(old.features[0].attributes).toEqual([{ k: 'Crew', v: 'A' }, { k: 'Done', v: 'yes' }])
    expect(old.features[0].notes).toBe('n')
    expect(old.features[0].createdAt).toBe(Date.parse('2026-07-01T00:00:00.000Z'))
    expect(old.warnings).toEqual(['1 line/area row(s) skipped (CSV only holds their first point)'])
  })
})
