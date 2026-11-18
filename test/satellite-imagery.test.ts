import { mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PMTiles, type RangeResponse, type Source } from 'pmtiles'
import proj4 from 'proj4'
// The imagery pipeline's pure parts (scripts/imagery/lib). raster.ts and
// build-satellite.ts need the folder's own dependencies, so they aren't
// imported here.
import { areaFromRings, countTiles, insideRings, tileTouchesArea } from '../scripts/imagery/lib/area'
import { addImageryEntry, imageryKey, type Catalog, type ImageryEntry } from '../scripts/imagery/lib/catalog'
import { alphaStats, downsample, drawTile, planTile, type Block, type SourceRaster } from '../scripts/imagery/lib/render'
import { presignGetUrl, parseS3Url } from '../scripts/imagery/lib/s3-presign'
import { previousQuarter, quarterOf, quarterStart } from '../scripts/imagery/lib/sources'
import { dnLookup, lutIndex, reflectanceToByte } from '../scripts/imagery/lib/stretch'
import { SpoolWriter } from '../scripts/imagery/lib/pmtiles-out'
import { groundResolution, latToY, lonToX, pixelLonLat, xToLon, yToLat } from '../scripts/imagery/lib/tiles'
import { parseRange } from '../scripts/imagery/serve'
import { PmCompression, PmTileType } from '../src/lib/pmtiles-writer'
import {
  checkSentinelFile,
  ESRI_ATTRIBUTION,
  initialSatelliteKind,
  satelliteSource,
} from '../src/map/satellite-source'
import { FAILURES_FOR_NO_SIGNAL, SatelliteSignal } from '../src/lib/satellite-signal'

const bc = JSON.parse(readFileSync(join(__dirname, '../scripts/imagery/bc-boundary.geojson'), 'utf8')) as {
  geometry: { coordinates: [number, number][][][] }
}
const bcArea = areaFromRings('bc', bc.geometry.coordinates.map((p) => p[0]), 10)

describe('tile math', () => {
  it('round-trips lon/lat and gives Web Mercator resolution', () => {
    expect(xToLon(lonToX(-121.58, 13), 13)).toBeCloseTo(-121.58, 9)
    expect(yToLat(latToY(50.24, 13), 13)).toBeCloseTo(50.24, 9)
    // 10 m Sentinel-2 vs z13: 12.5 m/px at 49°N, 9.6 m/px at 60°N.
    expect(groundResolution(49, 13)).toBeCloseTo(12.5, 1)
    expect(groundResolution(60, 13)).toBeCloseTo(9.55, 1)
    const [lon, lat] = pixelLonLat({ z: 0, x: 0, y: 0 }, 127.5, 127.5)
    expect(lon).toBeCloseTo(0, 9)
    expect(lat).toBeCloseTo(0, 9)
  })
})

describe('BC area', () => {
  it('has places in BC inside and others outside', () => {
    expect(insideRings(-120.34, 50.67, bcArea.rings)).toBe(true) // Kamloops
    expect(insideRings(-122.75, 53.92, bcArea.rings)).toBe(true) // Prince George
    expect(insideRings(-123.37, 48.43, bcArea.rings)).toBe(true) // Victoria (island)
    expect(insideRings(-114.07, 51.05, bcArea.rings)).toBe(false) // Calgary
    expect(insideRings(-122.33, 47.61, bcArea.rings)).toBe(false) // Seattle
  })

  it('selects tiles near BC only, within the margin', () => {
    expect(tileTouchesArea({ z: 13, x: Math.floor(lonToX(-120.34, 13)), y: Math.floor(latToY(50.67, 13)) }, bcArea)).toBe(true)
    // Calgary is ~70 km past the Alberta line: outside even with the margin.
    expect(tileTouchesArea({ z: 13, x: Math.floor(lonToX(-114.07, 13)), y: Math.floor(latToY(51.05, 13)) }, bcArea)).toBe(false)
    // Blaine, WA sits on the border: inside the 10 km margin.
    expect(tileTouchesArea({ z: 13, x: Math.floor(lonToX(-122.75, 13)), y: Math.floor(latToY(48.99, 13)) }, bcArea)).toBe(true)
  })

  it('counts a plausible pyramid (BC ≈ 950,000 km²)', () => {
    const counts = countTiles(bcArea, 10)
    expect(counts[0]).toBe(1)
    // z10 tiles are ~22 km wide at 54°N: ~2,000 cover BC plus the margin.
    expect(counts[10]).toBeGreaterThan(1800)
    expect(counts[10]).toBeLessThan(2600)
    for (let z = 1; z <= 10; z++) expect(counts[z]).toBeGreaterThanOrEqual(counts[z - 1])
  })
})

describe('colour stretch', () => {
  it('maps reflectance to bytes with a gamma lift', () => {
    expect(reflectanceToByte(0)).toBe(0)
    expect(reflectanceToByte(-0.01)).toBe(0)
    expect(reflectanceToByte(0.3)).toBe(255)
    expect(reflectanceToByte(1)).toBe(255)
    // Dark forest (~0.03) is lifted well above a linear 26.
    expect(reflectanceToByte(0.03)).toBeGreaterThan(60)
    let prev = -1
    for (let r = 0; r <= 0.3; r += 0.01) {
      const b = reflectanceToByte(r)
      expect(b).toBeGreaterThanOrEqual(prev)
      prev = b
    }
  })

  it('reads mosaic int16 and L2A uint16 DNs', () => {
    const mosaic = dnLookup({ scale: 1e-4, offset: 0, signed: true, nodata: -32768 })
    expect(mosaic[lutIndex(3000, true)]).toBe(255)
    expect(mosaic[lutIndex(-32768, true)]).toBe(0)
    const l2a = dnLookup({ scale: 1e-4, offset: -0.1, signed: false, nodata: 0 })
    // DN 1300 = reflectance 0.03 after the -0.1 offset.
    expect(l2a[lutIndex(1300, false)]).toBe(reflectanceToByte(0.03))
  })
})

describe('S3 presigned URLs', () => {
  it("matches AWS's documented example signature", () => {
    const url = presignGetUrl({
      endpoint: 'https://examplebucket.s3.amazonaws.com',
      bucket: '',
      key: 'test.txt',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      expiresSeconds: 86400,
      date: new Date('2013-05-24T00:00:00Z'),
    })
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
    expect(url).not.toContain('wJalrXUtnFEMI')
  })

  it('builds path-style CDSE URLs', () => {
    const { bucket, key } = parseS3Url('s3://eodata/Global-Mosaics/Sentinel-2/S2MSI_L3__MCQ/2026/07/01/X/B04.tif')
    const url = presignGetUrl({
      endpoint: 'https://eodata.dataspace.copernicus.eu',
      bucket,
      key,
      region: 'default',
      credentials: { accessKeyId: 'KEY', secretAccessKey: 'SECRET' },
      expiresSeconds: 3600,
      date: new Date('2026-11-18T00:00:00Z'),
    })
    expect(url.startsWith('https://eodata.dataspace.copernicus.eu/eodata/Global-Mosaics/Sentinel-2/S2MSI_L3__MCQ/2026/07/01/X/B04.tif?')).toBe(true)
    expect(url).toContain('X-Amz-Credential=KEY%2F20261118%2Fdefault%2Fs3%2Faws4_request')
  })

  it('names quarters', () => {
    expect(quarterOf('2026-07-01T00:00:00Z')).toBe('2026-Q3')
    expect(quarterStart('2026-Q3')).toBe('2026-07-01T00:00:00Z')
    expect(quarterStart('2027-Q1')).toBe('2027-01-01T00:00:00Z')
    expect(previousQuarter('2026-Q3')).toBe('2026-Q2')
    expect(previousQuarter('2027-Q1')).toBe('2026-Q4')
  })
})

/** A synthetic UTM zone 10 source: 2 × 2 blocks of 64 px at 10 m. */
function syntheticSource(id: string, fill: (x: number, y: number) => [number, number, number] | null): {
  source: SourceRaster
  blocks: Map<string, Block>
} {
  const utm = proj4('EPSG:4326', '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs')
  // Around 50.24°N, 123°W (zone 10's central meridian).
  const [cx, cy] = utm.forward([-123, 50.24])
  const originX = Math.round(cx) - 640
  const originY = Math.round(cy) + 640
  const size = 128
  const block = 64
  const nodata = -32768
  const blocks = new Map<string, Block>()
  for (let by = 0; by < 2; by++) {
    for (let bx = 0; bx < 2; bx++) {
      const bands: [Int16Array, Int16Array, Int16Array] = [
        new Int16Array(block * block),
        new Int16Array(block * block),
        new Int16Array(block * block),
      ]
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) {
          const v = fill(bx * block + x, by * block + y)
          for (let b = 0; b < 3; b++) bands[b][y * block + x] = v ? v[b] : nodata
        }
      }
      blocks.set(`${id}|0|${bx}|${by}`, { width: block, height: block, bands })
    }
  }
  const sw = utm.inverse([originX, originY - size * 10])
  const ne = utm.inverse([originX + size * 10, originY])
  return {
    blocks,
    source: {
      id,
      forward: (lon, lat) => utm.forward([lon, lat]) as [number, number],
      centralMeridian: -123,
      levels: [{ width: size, height: size, originX, originY, res: 10, blockWidth: block, blockHeight: block }],
      lut: dnLookup({ scale: 1e-4, offset: 0, signed: true, nodata }),
      signed: true,
      nodata,
      bbox: [sw[0], sw[1], ne[0], ne[1]],
    },
  }
}

describe('drawing a tile from UTM sources', () => {
  const z16 = { z: 16, x: Math.floor(lonToX(-123, 16)), y: Math.floor(latToY(50.24, 16)) }

  it('reprojects and samples the source', () => {
    // Red on the west half of the source, blue on the east half.
    const { source, blocks } = syntheticSource('a', (x) => (x < 64 ? [3000, 0, 0] : [0, 0, 3000]))
    const plan = planTile(z16, [source])
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0].blocks.length).toBeGreaterThan(0)
    const rgba = drawTile(plan, { get: (s, l, bx, by) => blocks.get(`${s.id}|${l}|${bx}|${by}`) })
    // The tile's centre column straddles the source's middle; check a pixel
    // left and right of -123° (the source's centre).
    const lonAt = (i: number) => pixelLonLat(z16, i, 128)[0]
    const left = [...Array(256).keys()].find((i) => lonAt(i) < -123.0006 && lonAt(i) > -123.003)!
    const right = [...Array(256).keys()].find((i) => lonAt(i) > -122.9994 && lonAt(i) < -122.997)!
    const px = (i: number) => Array.from(rgba.slice((128 * 256 + i) * 4, (128 * 256 + i) * 4 + 4))
    expect(px(left)).toEqual([255, 0, 0, 255])
    expect(px(right)).toEqual([0, 0, 255, 255])
  })

  it('falls through nodata to the next source, and leaves alpha 0 where none has data', () => {
    const holey = syntheticSource('holey', (x) => (x < 64 ? [3000, 3000, 3000] : null))
    const green = syntheticSource('green', (x) => (x < 96 ? [0, 3000, 0] : null))
    const lookup = {
      get: (s: SourceRaster, l: number, bx: number, by: number) =>
        holey.blocks.get(`${s.id}|${l}|${bx}|${by}`) ?? green.blocks.get(`${s.id}|${l}|${bx}|${by}`),
    }
    // A z14 tile (~1.6 km) holds the whole 1.28 km source and some outside it.
    const z14 = { z: 14, x: Math.floor(lonToX(-123, 14)), y: Math.floor(latToY(50.24, 14)) }
    const rgba = drawTile(planTile(z14, [holey.source, green.source]), lookup)
    const colours = new Set<string>()
    for (let o = 0; o < rgba.length; o += 4) colours.add(Array.from(rgba.slice(o, o + 4)).join(','))
    expect(colours.has('255,255,255,255')).toBe(true) // first source
    expect(colours.has('0,255,0,255')).toBe(true) // second source where the first has none
    expect(colours.has('0,0,0,0')).toBe(true) // neither: transparent
  })

  it('uses an older quarter only to fill gaps in the main one', () => {
    const main = syntheticSource('2026q3', (x) => (x < 64 ? [3000, 0, 0] : null))
    const older = syntheticSource('2026q2', () => [0, 0, 3000])
    older.source.priority = 1
    const lookup = {
      get: (s: SourceRaster, l: number, bx: number, by: number) =>
        main.blocks.get(`${s.id}|${l}|${bx}|${by}`) ?? older.blocks.get(`${s.id}|${l}|${bx}|${by}`),
    }
    // Listed older-first on purpose: priority decides, not order.
    const plan = planTile(z16, [older.source, main.source])
    expect(plan.entries.map((e) => e.source.id)).toEqual(['2026q3', '2026q2'])
    const rgba = drawTile(plan, lookup)
    const colours = new Set<string>()
    for (let o = 0; o < rgba.length; o += 4) colours.add(Array.from(rgba.slice(o, o + 4)).join(','))
    expect(colours).toEqual(new Set(['255,0,0,255', '0,0,255,255']))
  })

  it('skips sources that are elsewhere', () => {
    const { source } = syntheticSource('a', () => [1, 1, 1])
    expect(planTile({ z: 13, x: Math.floor(lonToX(-118, 13)), y: Math.floor(latToY(50.24, 13)) }, [source]).entries).toEqual([])
  })
})

describe('pyramid', () => {
  const solid = (r: number, a = 255) => {
    const t = new Uint8Array(256 * 256 * 4)
    for (let o = 0; o < t.length; o += 4) t.set([r, r, r, a], o)
    return t
  }

  it('averages 2 × 2 children into the parent, by quadrant', () => {
    const parent = downsample([solid(10), solid(20), null, solid(40)])!
    const at = (i: number, j: number) => Array.from(parent.slice((j * 256 + i) * 4, (j * 256 + i) * 4 + 4))
    expect(at(0, 0)).toEqual([10, 10, 10, 255])
    expect(at(255, 0)).toEqual([20, 20, 20, 255])
    expect(at(0, 255)).toEqual([0, 0, 0, 0])
    expect(at(255, 255)).toEqual([40, 40, 40, 255])
    expect(downsample([null, null, null, null])).toBeNull()
  })

  it('weights by alpha so transparent edges stay clean', () => {
    const half = solid(200)
    for (let o = 0; o < half.length; o += 8) half.set([0, 0, 0, 0], o) // every other pixel transparent
    const parent = downsample([half, null, null, null])!
    expect(Array.from(parent.slice(0, 4))).toEqual([200, 200, 200, 128])
    expect(alphaStats(parent)).toEqual({ empty: false, opaque: false })
    expect(alphaStats(solid(5))).toEqual({ empty: false, opaque: true })
    expect(alphaStats(solid(5, 0))).toEqual({ empty: true, opaque: false })
  })
})

describe('PMTiles output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sat-pmtiles-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  class FileSource implements Source {
    private fd: number
    constructor(private path: string) {
      this.fd = openSync(path, 'r')
    }
    getKey() {
      return this.path
    }
    async getBytes(offset: number, length: number): Promise<RangeResponse> {
      const buf = Buffer.alloc(length)
      const n = readSync(this.fd, buf, 0, length, offset)
      return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + n) as ArrayBuffer }
    }
  }

  it('writes tiles that arrive in any order, resumes, and reads back', async () => {
    const path = join(dir, 'test.pmtiles')
    const tile = (z: number, x: number, y: number) => new TextEncoder().encode(`${z}/${x}/${y}`)
    const first = new SpoolWriter(path, false)
    first.add(13, 1329, 2770, tile(13, 1329, 2770))
    first.add(0, 0, 0, tile(0, 0, 0))
    // An interrupted run: a new writer picks up what was spooled.
    const resumed = new SpoolWriter(path, true)
    expect(resumed.count).toBe(2)
    expect(new TextDecoder().decode(resumed.read(0, 0, 0)!)).toBe('0/0/0')
    resumed.add(12, 664, 1385, tile(12, 664, 1385))
    const result = resumed.finish({
      tileType: PmTileType.Webp,
      tileCompression: PmCompression.None,
      minZoom: 0,
      maxZoom: 13,
      bounds: [-121.7, 50.17, -121.45, 50.33],
      center: [-121.58, 50.25, 10],
      metadata: { attribution: 'Contains modified Copernicus Sentinel data 2026' },
    })
    expect(result.tiles).toBe(3)

    const pm = new PMTiles(new FileSource(path))
    const header = await pm.getHeader()
    expect(header).toMatchObject({ tileType: PmTileType.Webp, minZoom: 0, maxZoom: 13, clustered: true, numAddressedTiles: 3 })
    expect((await pm.getMetadata()) as { attribution: string }).toMatchObject({
      attribution: 'Contains modified Copernicus Sentinel data 2026',
    })
    for (const [z, x, y] of [[0, 0, 0], [12, 664, 1385], [13, 1329, 2770]]) {
      const got = await pm.getZxy(z, x, y)
      expect(new TextDecoder().decode(got!.data)).toBe(`${z}/${x}/${y}`)
    }
    expect(await pm.getZxy(13, 1328, 2770)).toBeUndefined()
  })
})

describe('bucket catalog', () => {
  const entry = (period: string, area = 'bc'): ImageryEntry => ({
    area,
    product: 's2-quarterly',
    period,
    url: imageryKey('s2-quarterly', area, period),
    bounds: [-139.1, 48.2, -114, 60],
    minzoom: 0,
    maxzoom: 13,
    bytes: 1,
    format: 'webp',
    attribution: 'Contains modified Copernicus Sentinel data 2026',
    licence: 'Copernicus Sentinel data: free, full and open',
  })

  it('uses the bucket layout key (docs/hosting-r2.md)', () => {
    expect(imageryKey('s2-quarterly', 'bc', '2026-q3')).toBe('imagery/s2-quarterly/bc/2026-q3.pmtiles')
  })

  it('adds the entry under sources.imagery, keeping the rest of the catalog', () => {
    const existing: Catalog = {
      format: 'carmanah-catalog',
      version: 1,
      updated: '2026-11-18T20:00:00Z',
      sources: {
        basemap: [{ area: 'bc', url: 'basemap/bc/20261115_080022_pt.pmtiles' }],
        imagery: [entry('2026-q2'), entry('2026-q2', 'lytton')],
      },
      packs: [{ id: 'c40983-20261118' }],
    }
    const next = addImageryEntry(existing, entry('2026-q3'), new Date('2026-11-19T01:02:03.456Z'))
    expect(next.updated).toBe('2026-11-19T01:02:03Z')
    expect(next.sources.basemap).toEqual(existing.sources.basemap)
    expect(next.packs).toEqual(existing.packs)
    // The same area and product is replaced; other areas stay.
    expect(next.sources.imagery!.map((e) => `${e.area} ${e.period}`)).toEqual(['lytton 2026-q2', 'bc 2026-q3'])
  })

  it('starts a catalog when there is none, and refuses an unknown one', () => {
    const fresh = addImageryEntry(null, entry('2026-q3'))
    expect(fresh).toMatchObject({ format: 'carmanah-catalog', version: 1, packs: [] })
    expect(fresh.sources.imagery).toHaveLength(1)
    expect(() => addImageryEntry({ ...fresh, version: 2 as 1 }, entry('2026-q3'))).toThrow(/expected carmanah-catalog v1/)
  })
})

describe('local Range server', () => {
  it('parses byte ranges the way R2 answers them', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('bytes=0-126', 1000)).toEqual([0, 126])
    expect(parseRange('bytes=900-', 1000)).toEqual([900, 999])
    expect(parseRange('bytes=-10', 1000)).toEqual([990, 999])
    expect(parseRange('bytes=0-5000', 1000)).toEqual([0, 999])
    expect(parseRange('bytes=1000-1001', 1000)).toBe('bad')
    expect(parseRange('bytes=0-1,5-6', 1000)).toBe('bad')
  })
})

describe('app satellite source', () => {
  const url = 'https://maps.example.test/imagery/sentinel-2-bc-2026-q3.pmtiles'

  it('uses our Sentinel-2 file when configured, Esri otherwise', () => {
    expect(initialSatelliteKind('')).toBe('esri')
    expect(initialSatelliteKind(url)).toBe('sentinel')
    expect(satelliteSource('sentinel', url)).toEqual({ type: 'raster', url: `pmtiles://${url}`, tileSize: 256 })
    expect(satelliteSource('esri', url)).toMatchObject({ type: 'raster', maxzoom: 19, attribution: ESRI_ATTRIBUTION })
    // Not configured: Esri even if asked for Sentinel.
    expect(satelliteSource('sentinel', '')).toMatchObject({ attribution: ESRI_ATTRIBUTION })
  })

  it('takes the URL from the build, not a committed .env', () => {
    // The website build sets it (empty until the file is on R2).
    const deploy = readFileSync(join(__dirname, '../.github/workflows/deploy.yml'), 'utf8')
    expect(deploy).toMatch(/run: npm run build\n\s+env:\n(\s+#.*\n)*\s+VITE_SATELLITE_PMTILES_URL: ''/)
    // The repo is public: env files stay out of git.
    expect(readFileSync(join(__dirname, '../.gitignore'), 'utf8')).toMatch(/^\.env$/m)
  })

  it('tells a missing file (use Esri) from no signal', async () => {
    const header = new Uint8Array(127)
    header.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 3])
    const answer = (status: number, body: Uint8Array) => (async () => new Response(body, { status })) as unknown as typeof fetch
    expect(await checkSentinelFile(url, answer(206, header))).toBe('ok')
    expect(await checkSentinelFile(url, answer(404, new Uint8Array()))).toBe('missing')
    expect(await checkSentinelFile(url, answer(200, new TextEncoder().encode('<html>not found</html>')))).toBe('missing')
    const offline = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await checkSentinelFile(url, offline)).toBe('unreachable')
  })

  it('treats a source that never loads as no signal', () => {
    const signal = new SatelliteSignal({ isOnline: () => true, probe: async () => true })
    signal.sourceFailed()
    expect(signal.ok()).toBe(false)
    expect(signal.needsRecheck()).toBe(true)
    signal.tileFailed()
    signal.tileLoaded()
    expect(signal.ok()).toBe(true)
    expect(FAILURES_FOR_NO_SIGNAL).toBeGreaterThan(1)
  })
})
