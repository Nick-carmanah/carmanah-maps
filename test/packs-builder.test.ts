/**
 * The Mac pack builder (scripts/packs/build.ts) end to end, offline: a
 * fixture archive on disk stands in for OpenFreeMap's planet, and a fake
 * fetch stands in for AWS Terrain Tiles.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zxyToTileId } from 'pmtiles'
import { bboxRing, tileXToLon, tileYToLat, type PackArea } from '../src/lib/packs/area'
import { parseManifest } from '../src/lib/packs/manifest'
import { buildPack, planCut, sha256File, writeCut } from '../scripts/packs/build'
import { fileSource } from '../scripts/packs/sources'
import { fixtureTiles, makeArchive, pmtilesOf } from './helpers/pmtiles-fixture'

const TILES = fixtureTiles(4, 10, 320, 704, 64)
const byId = new Map(TILES.map((t) => [zxyToTileId(t.z, t.x, t.y), t.data]))
// An area well inside the fixture: z10 tiles ~330–345 × 710–725.
const AREA: PackArea = {
  rings: [bboxRing([tileXToLon(331, 10), tileYToLat(724, 10), tileXToLon(344, 10), tileYToLat(711, 10)])],
  bufferM: 2000,
}

let dir: string
let sourcePath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'builder-'))
  sourcePath = join(dir, 'planet.pmtiles')
  writeFileSync(sourcePath, makeArchive(TILES, { leafSize: 400 }))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A fake AWS: a tiny "PNG" per tile, 404 for one tile. */
const fakeAws: typeof fetch = async (input) => {
  const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(input))!
  if (m[1] === '8' && Number(m[2]) % 7 === 0) return new Response('missing', { status: 404 })
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, Number(m[1]), Number(m[2]) & 0xff, Number(m[3]) & 0xff])
  return new Response(png)
}

describe('pack builder', () => {
  it('cuts an area from a file to a file, tile for tile, with its sha256', async () => {
    const src = await fileSource(sourcePath)
    const cut = await planCut(src, AREA, 6, 10)
    expect(cut.plan.tiles).toBeGreaterThan(200)
    const out = join(dir, 'cut.pmtiles')
    const result = await writeCut(src, cut.plan, out)
    expect(existsSync(`${out}.part`)).toBe(false)
    expect(result.sha256).toBe(await sha256File(out))
    const bytes = new Uint8Array(readFileSync(out))
    expect(bytes.length).toBe(cut.plan.totalLength)
    const p = pmtilesOf(bytes)
    let n = 0
    for (const level of cut.levels) {
      const size = 2 ** level.z
      for (const k of level.keys) {
        const [x, y] = [Math.floor(k / size), k % size]
        const want = byId.get(zxyToTileId(level.z, x, y))
        if (!want) continue
        expect(new Uint8Array((await p.getZxy(level.z, x, y))!.data)).toEqual(want)
        n++
      }
    }
    expect(n).toBe(cut.plan.tiles)
  })

  it('builds a whole pack folder: basemap, terrain from AWS, and a pack.json that checks out', async () => {
    const manifest = await buildPack({
      id: 'test-fire-20261118',
      name: 'Test fire',
      fireNumber: 'X12345',
      area: AREA,
      created: '2026-11-18T00:00:00Z',
      basemap: await fileSource(sourcePath),
      basemapBuild: 'fixture',
      terrain: null,
      basemapZooms: [6, 10],
      terrainZooms: [6, 9],
      outDir: dir,
      fetch: fakeAws,
    })
    const packDir = join(dir, 'test-fire-20261118')
    const onDisk = parseManifest(JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf8')))
    expect(onDisk).toEqual(manifest)
    for (const f of onDisk.files) {
      const bytes = readFileSync(join(packDir, f.name))
      expect(bytes.length).toBe(f.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256)
    }
    const terrain = pmtilesOf(new Uint8Array(readFileSync(join(packDir, 'terrain.pmtiles'))))
    const h = await terrain.getHeader()
    expect([h.minZoom, h.maxZoom, h.tileType]).toEqual([6, 9, 2])
    const terrainFile = onDisk.files.find((f) => f.source === 'terrain')!
    expect(terrainFile.encoding).toBe('terrarium')
    expect(h.numAddressedTiles).toBe(terrainFile.tiles)
    // 404s are skipped, not fatal.
    expect(await terrain.getZxy(8, 84, 177)).toBeUndefined()
    expect(onDisk.areaHa).toBeGreaterThan(0)
    expect(onDisk.bbox[0]).toBeLessThan(tileXToLon(331, 10))
  })
})
