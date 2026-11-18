/**
 * pack.json and catalog.json (src/lib/packs/manifest.ts), and publishing a
 * built pack into a folder laid out like the bucket (scripts/packs/publish.ts).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  manifestJson,
  packIdFor,
  parseCatalog,
  parseManifest,
  perimeterOf,
  type PackManifest,
} from '../src/lib/packs/manifest'
import { localTarget, publishArea, publishPack, removePack } from '../scripts/packs/publish'

const SHA = 'a'.repeat(64)

function manifest(over: Partial<PackManifest> = {}): PackManifest {
  return {
    format: 'carmanah-pack',
    version: 1,
    id: 'c40983-20261118',
    name: 'Sample fire (C40983)',
    fireNumber: 'C40983',
    created: '2026-11-18T20:00:00Z',
    bbox: [-122.2, 50.8, -121.2, 51.5],
    bufferKm: 5,
    perimeter: perimeterOf([[[-122, 51], [-121.5, 51], [-121.5, 51.3]]]),
    areaHa: 165000,
    files: [
      { name: 'basemap.pmtiles', source: 'basemap', format: 'mvt', minzoom: 6, maxzoom: 14, tiles: 1956, bytes: 12, sha256: SHA, attribution: 'x' },
      { name: 'terrain.pmtiles', source: 'terrain', format: 'png', encoding: 'terrarium', minzoom: 6, maxzoom: 12, tiles: 160, bytes: 8, sha256: SHA, attribution: 'y' },
    ],
    bytes: 20,
    attribution: 'x. y',
    madeBy: 'builder',
    ...over,
  }
}

describe('pack.json', () => {
  it('round-trips through the file text', () => {
    const m = manifest()
    const text = manifestJson(m)
    expect(text).toMatch(/"perimeter": \{"type":"MultiPolygon"/)
    expect(parseManifest(JSON.parse(text))).toEqual(m)
  })

  it('refuses files that could escape the pack folder or lie about their hash', () => {
    const bad = (over: Record<string, unknown>, fileOver: Record<string, unknown> = {}) => () =>
      parseManifest({ ...manifest(), ...over, files: [{ ...manifest().files[0], ...fileOver }] })
    expect(bad({ id: '../x' })).toThrow(/bad id/)
    expect(bad({ id: '_packs' })).toThrow(/bad id/)
    expect(bad({}, { name: '../../basemap.pmtiles' })).toThrow(/file name/)
    expect(bad({}, { name: 'basemap.pmtiles.part' })).toThrow(/file name/)
    expect(bad({}, { sha256: 'abc' })).toThrow(/sha256/)
    expect(bad({}, { source: 'evil' })).toThrow(/source/)
    expect(bad({ version: 2 })).toThrow(/version 2/)
    expect(bad({ bbox: [10, 0, 0, 1] })).toThrow(/bbox/)
    expect(() => parseManifest({ ...manifest(), files: [manifest().files[0], manifest().files[0]] })).toThrow(/file name/)
  })

  it('totals bytes from the files, not from what the file claims', () => {
    expect(parseManifest({ ...manifest(), bytes: 999 }).bytes).toBe(20)
  })

  it('makes file-name-safe ids', () => {
    expect(packIdFor('C40983', '2026-11-18T20:00:00Z')).toBe('c40983-20261118')
    expect(packIdFor('Pear Lake (C40983)', new Date('2026-07-01T00:00:00Z'))).toBe('pear-lake-c40983-20260701')
    expect(packIdFor('***', '2026-07-01')).toBe('area-20260701')
  })

  it('keeps the stored perimeter small', () => {
    const ring: [number, number][] = []
    for (let i = 0; i < 2000; i++) {
      const a = (i / 2000) * 2 * Math.PI
      ring.push([-121 + 0.3 * Math.cos(a), 51 + 0.2 * Math.sin(a)])
    }
    const p = perimeterOf([ring])!
    expect(p.coordinates[0][0].length).toBeLessThan(400)
  })
})

describe('catalog.json', () => {
  it('drops bad entries instead of failing', () => {
    const c = parseCatalog({
      format: 'carmanah-catalog',
      version: 1,
      updated: 'x',
      sources: {
        basemap: [{ area: 'bc', url: 'basemap/bc/b.pmtiles', bounds: [-139, 48, -114, 60], minzoom: 0, maxzoom: 14, bytes: 5 }, { area: 'bad' }],
        terrain: 'nope',
      },
      packs: [{ id: 'Bad Id', name: 'x' }, { id: 'ok-1', name: 'OK', bbox: [0, 0, 1, 1], bytes: 1, created: 'now', url: 'packs/ok-1/pack.json' }],
    })
    expect(c.sources.basemap).toHaveLength(1)
    expect(c.sources.terrain).toEqual([])
    expect(c.packs.map((p) => p.id)).toEqual(['ok-1'])
    expect(() => parseCatalog({ format: 'other' })).toThrow()
  })
})

describe('publish to a bucket folder', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('uploads a pack, then lists it in the catalog; never overwrites an immutable file', () => {
    root = mkdtempSync(join(tmpdir(), 'publish-'))
    const packDir = join(root, 'built', 'c40983-20261118')
    mkdirSync(packDir, { recursive: true })
    writeFileSync(join(packDir, 'basemap.pmtiles'), 'x'.repeat(12))
    writeFileSync(join(packDir, 'terrain.pmtiles'), 'y'.repeat(8))
    writeFileSync(join(packDir, 'pack.json'), manifestJson(manifest()))
    const bucket = join(root, 'bucket')
    const target = localTarget(bucket)
    publishPack(target, packDir)
    expect(readFileSync(join(bucket, 'packs', 'c40983-20261118', 'basemap.pmtiles'), 'utf8')).toBe('x'.repeat(12))
    const catalog = target.getCatalog()
    expect(catalog.packs).toEqual([
      expect.objectContaining({ id: 'c40983-20261118', bytes: 20, url: 'packs/c40983-20261118/pack.json' }),
    ])
    // Same pack again: same sizes, skipped; still one entry.
    publishPack(target, packDir)
    expect(target.getCatalog().packs).toHaveLength(1)
    // A changed file under the same id is refused.
    writeFileSync(join(packDir, 'basemap.pmtiles'), 'z'.repeat(13))
    writeFileSync(join(packDir, 'pack.json'), manifestJson(manifest({ files: [{ ...manifest().files[0], bytes: 13 }, manifest().files[1]] })))
    expect(() => publishPack(target, packDir)).toThrow(/immutable/)
    removePack(target, 'c40983-20261118')
    expect(target.getCatalog().packs).toEqual([])
  })

  it('publishes area archives, newest per area', () => {
    root = mkdtempSync(join(tmpdir(), 'publish-'))
    const area = join(root, 'area-bc')
    mkdirSync(join(area, 'basemap', 'bc'), { recursive: true })
    mkdirSync(join(area, 'terrain', 'bc'), { recursive: true })
    writeFileSync(join(area, 'basemap', 'bc', 'b1.pmtiles'), 'b')
    writeFileSync(join(area, 'terrain', 'bc', 'v1.pmtiles'), 't')
    const src = (url: string) => ({ area: 'bc', url, bounds: [-139, 48, -114, 60], minzoom: 0, maxzoom: 14, bytes: 1 })
    writeFileSync(join(area, 'sources.json'), JSON.stringify({ basemap: [src('basemap/bc/b1.pmtiles')], terrain: [src('terrain/bc/v1.pmtiles')] }))
    const target = localTarget(join(root, 'bucket'))
    publishArea(target, area)
    writeFileSync(join(area, 'basemap', 'bc', 'b2.pmtiles'), 'b')
    writeFileSync(join(area, 'sources.json'), JSON.stringify({ basemap: [src('basemap/bc/b2.pmtiles')], terrain: [src('terrain/bc/v1.pmtiles')] }))
    publishArea(target, area)
    const c = target.getCatalog()
    expect(c.sources.basemap.map((s) => s.url)).toEqual(['basemap/bc/b2.pmtiles'])
    expect(c.sources.terrain.map((s) => s.url)).toEqual(['terrain/bc/v1.pmtiles'])
  })
})
