/**
 * The PMTiles writer (src/lib/pmtiles-writer.ts) against the `pmtiles`
 * reader the map uses: an archive written the way tiles.ts writes it (plan,
 * then the prefix followed by each tile in plan order) must read back with
 * the same header, metadata and tile bytes. Also read through the owner's
 * file store, the way the carmanah-map:// protocol does (IndexedDB fallback
 * here, on an in-memory IndexedDB).
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { Compression, PMTiles, TileType, type RangeResponse, type Source } from 'pmtiles'
import { PmCompression, PmTileType, planPack, type PackHeaderInfo } from '../src/lib/pmtiles-writer'
import { openFileStore } from '../src/lib/storage/files'

interface Tile {
  z: number
  x: number
  y: number
  bytes: Uint8Array
}

/** Web Mercator tile holding a point (the scheme MapLibre and PMTiles use). */
function tileOf(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const r = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n)
  return [x, y]
}

/** Distinct, varied-length bytes per tile, so a tile read from the wrong offset can't pass. */
function tileBytes(z: number, x: number, y: number): Uint8Array {
  const label = new TextEncoder().encode(`tile ${z}/${x}/${y};`)
  const out = new Uint8Array(label.length + ((x * 7 + y * 13 + z) % 61))
  out.set(label)
  for (let i = label.length; i < out.length; i++) out[i] = (i * 31 + x + y + z) & 0xff
  return out
}

/** Every tile covering bounds from minZoom to maxZoom, in a scrambled order (the writer must sort). */
function pyramid(bounds: [number, number, number, number], minZoom: number, maxZoom: number): Tile[] {
  const [w, s, e, n] = bounds
  const tiles: Tile[] = []
  for (let z = minZoom; z <= maxZoom; z++) {
    const [x0, y0] = tileOf(w, n, z)
    const [x1, y1] = tileOf(e, s, z)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ z, x, y, bytes: tileBytes(z, x, y) })
  }
  return tiles.sort((a, b) => ((a.x * 31 + a.y * 17 + a.z) % 23) - ((b.x * 31 + b.y * 17 + b.z) % 23))
}

/** Write the archive exactly as tiles.ts does: plan, then prefix + tiles in plan order. */
function writeArchive(tiles: Tile[], info: PackHeaderInfo) {
  const plan = planPack(
    tiles.map((t) => ({ z: t.z, x: t.x, y: t.y, length: t.bytes.length })),
    info,
  )
  const byKey = new Map(tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t.bytes]))
  const archive = new Uint8Array(plan.totalLength)
  archive.set(plan.prefix)
  let at = plan.prefix.length
  for (const t of plan.tiles) {
    archive.set(byKey.get(`${t.z}/${t.x}/${t.y}`)!, at)
    at += t.length
  }
  return { plan, archive, written: at }
}

class BufferSource implements Source {
  reads = 0
  constructor(
    private bytes: Uint8Array,
    private key: string,
  ) {}
  getKey() {
    return this.key
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    this.reads++
    return { data: this.bytes.slice(offset, offset + length).buffer }
  }
}

const BOUNDS: [number, number, number, number] = [-123.4012345, 48.4012345, -123.2987655, 48.4687655]
const META = {
  format: 'webp',
  generator: 'carmanah-maps',
  corners: [[-123.4, 48.47], [-123.3, 48.47], [-123.3, 48.4], [-123.4, 48.4]],
  pdfFrame: [36, 36, 1188, 756],
  dpi: 334,
}
const INFO: PackHeaderInfo = {
  tileType: PmTileType.Webp,
  tileCompression: PmCompression.None,
  minZoom: 10,
  maxZoom: 15,
  bounds: BOUNDS,
  center: [-123.35, 48.435, 12],
  metadata: META,
}

async function expectAllTiles(reader: PMTiles, tiles: Tile[]) {
  for (const t of tiles) {
    const got = await reader.getZxy(t.z, t.x, t.y)
    expect(got, `${t.z}/${t.x}/${t.y}`).toBeDefined()
    expect(new Uint8Array(got!.data)).toEqual(t.bytes)
  }
}

describe('PMTiles writer → pmtiles reader', () => {
  const tiles = pyramid(BOUNDS, INFO.minZoom, INFO.maxZoom)
  const { plan, archive, written } = writeArchive(tiles, INFO)

  it('lays the archive out as planned: prefix, then tiles in tile-id order, back to back', () => {
    expect(tiles.length).toBeGreaterThan(50)
    expect(written).toBe(plan.totalLength)
    expect(plan.prefix.length).toBe(plan.tileDataOffset)
    expect(plan.tileDataLength).toBe(tiles.reduce((s, t) => s + t.bytes.length, 0))
    plan.tiles.forEach((t, i) => {
      if (i === 0) return expect(t.offset).toBe(0)
      const prev = plan.tiles[i - 1]
      expect(t.tileId).toBeGreaterThan(prev.tileId)
      expect(t.offset).toBe(prev.offset + prev.length)
    })
  })

  it('writes a v3 header the reader understands: zooms, bounds, centre, types, counts', async () => {
    const reader = new PMTiles(new BufferSource(archive, 'header'))
    const h = await reader.getHeader()
    expect(new TextDecoder().decode(archive.slice(0, 7))).toBe('PMTiles')
    expect(h).toMatchObject({
      specVersion: 3,
      minZoom: 10,
      maxZoom: 15,
      centerZoom: 12,
      tileType: TileType.Webp,
      tileCompression: Compression.None,
      internalCompression: Compression.None,
      clustered: true,
      numAddressedTiles: tiles.length,
      numTileEntries: tiles.length,
      numTileContents: tiles.length,
      tileDataOffset: plan.tileDataOffset,
      tileDataLength: plan.tileDataLength,
      leafDirectoryLength: 0,
    })
    // Bounds and centre are stored to 1e-7 degrees.
    const [w, s, e, n] = BOUNDS
    expect(h.minLon).toBeCloseTo(w, 7)
    expect(h.minLat).toBeCloseTo(s, 7)
    expect(h.maxLon).toBeCloseTo(e, 7)
    expect(h.maxLat).toBeCloseTo(n, 7)
    expect(h.centerLon).toBeCloseTo(-123.35, 7)
    expect(h.centerLat).toBeCloseTo(48.435, 7)
  })

  it('reads back the metadata', async () => {
    const reader = new PMTiles(new BufferSource(archive, 'meta'))
    expect(await reader.getMetadata()).toEqual(META)
  })

  it('reads back every tile byte for byte, at every zoom', async () => {
    await expectAllTiles(new PMTiles(new BufferSource(archive, 'tiles')), tiles)
  })

  it('has no tile outside the pyramid (MapLibre then draws nothing there)', async () => {
    const reader = new PMTiles(new BufferSource(archive, 'outside'))
    const [x, y] = tileOf(BOUNDS[0], BOUNDS[3], 15)
    expect(await reader.getZxy(15, x - 1, y)).toBeUndefined()
    expect(await reader.getZxy(16, 2 * x, 2 * y)).toBeUndefined()
    expect(await reader.getZxy(9, x >> 6, y >> 6)).toBeUndefined()
  })

  it('reads back through the owner file store, as the carmanah-map:// protocol does', async () => {
    const files = await openFileStore('pmtiles-test')
    expect(files.backend).toBe('idb') // No OPFS in Node.
    const path = 'library/maps/test-map/map.pmtiles'
    const parts: BlobPart[] = [plan.prefix as Uint8Array<ArrayBuffer>]
    const byKey = new Map(tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t.bytes]))
    for (const t of plan.tiles) parts.push(byKey.get(`${t.z}/${t.x}/${t.y}`)! as Uint8Array<ArrayBuffer>)
    expect(await files.write(path, parts)).toBe(plan.totalLength)
    const reader = new PMTiles({
      getKey: () => path,
      getBytes: async (offset, length) => ({ data: await files.readRange(path, offset, length) }),
    })
    expect((await reader.getHeader()).maxZoom).toBe(15)
    await expectAllTiles(reader, tiles)
  })

  it('moves big directories into leaf directories and still finds every tile', async () => {
    // Every tile of zooms 0–6 (5,461 entries) is more than the 16 KB root holds.
    const world = pyramid([-180, -85.05, 179.999, 85.05], 0, 6).map((t) => ({ ...t, bytes: t.bytes.slice(0, 12) }))
    const big = writeArchive(world, { ...INFO, tileType: PmTileType.Png, minZoom: 0, maxZoom: 6, center: [0, 0, 0] })
    const source = new BufferSource(big.archive, 'leaves')
    const reader = new PMTiles(source)
    const h = await reader.getHeader()
    expect(world.length).toBe(5461)
    expect(h.leafDirectoryLength).toBeGreaterThan(0)
    expect(h.rootDirectoryLength).toBeLessThanOrEqual(16384 - 127)
    expect(h.tileType).toBe(TileType.Png)
    await expectAllTiles(reader, world)
  })
})
