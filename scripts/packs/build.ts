// The pack builder's work: cut an area out of a PMTiles archive, pack AWS
// terrain tiles into one, and write a pack folder with its pack.json.
// The CLI is build-pack.ts; the app does the same cut on the phone with the
// same src/lib/packs/ code.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { open, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { zxyToTileId } from 'pmtiles'
import { locateTiles, openArchive } from '../../src/lib/packs/archive.ts'
import { outputOf, planExtract, type ExtractPlan } from '../../src/lib/packs/extract.ts'
import {
  areaBbox,
  coverArea,
  countTiles,
  ringsHectares,
  simplifyArea,
  tileIdsOf,
  type Bbox,
  type PackArea,
  type ZoomTiles,
} from '../../src/lib/packs/area.ts'
import {
  BASEMAP_ATTRIBUTION,
  PACK_FORMAT,
  PACK_VERSION,
  TERRAIN_ATTRIBUTION,
  manifestJson,
  perimeterOf,
  type PackFile,
  type PackManifest,
} from '../../src/lib/packs/manifest.ts'
import { PmCompression, PmTileType, planPack } from '../../src/lib/pmtiles-writer.ts'
import { USER_AGENT, type ByteSource } from './sources.ts'

export type Log = (line: string) => void

export const AWS_TERRAIN = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

export interface CutResult {
  plan: ExtractPlan
  bytes: number
  sha256: string
  tiles: number
}

const centerOf = ([w, s, e, n]: Bbox, z: number): [number, number, number] => [(w + e) / 2, (s + n) / 2, z]

/** Run `jobs` with at most `limit` in flight, handing results to `use` in order. */
async function inOrder<T>(count: number, limit: number, job: (i: number) => Promise<T>, use: (value: T, i: number) => Promise<void> | void) {
  const started = new Map<number, Promise<T>>()
  let next = 0
  const start = () => {
    while (next < count && started.size < limit) {
      const i = next++
      started.set(i, job(i))
    }
  }
  for (let i = 0; i < count; i++) {
    start()
    const value = await started.get(i)!
    started.delete(i)
    start()
    await use(value, i)
  }
}

/** Plan a cut: which tiles of `source` the area needs, and where they go in the new file. */
export async function planCut(source: ByteSource, area: PackArea, minZoom: number, maxZoom: number, extraMeta: Record<string, unknown> = {}) {
  const index = await openArchive(source.read)
  const levels = coverArea(simplifyArea(area, maxZoom), minZoom, maxZoom)
  const ids = tileIdsOf(levels, Math.max(minZoom, index.header.minZoom), Math.min(maxZoom, index.header.maxZoom))
  let dirBytes = 0
  const locations = await locateTiles(index, ids, { onRead: (n) => (dirBytes += n) })
  const bounds = areaBbox(area)
  const plan = planExtract(
    index,
    locations,
    {
      minZoom,
      maxZoom,
      bounds,
      center: centerOf(bounds, Math.min(maxZoom, minZoom + 4)),
      metadata: { ...index.metadata, ...extraMeta },
    },
    { maxGap: 128 * 1024, maxRead: 8 * 1024 * 1024 },
  )
  return { index, levels, wanted: ids.length, plan, dirBytes }
}

/** Write a planned cut to `out` (via `out.part`, renamed when complete). */
export async function writeCut(source: ByteSource, plan: ExtractPlan, out: string, log?: Log): Promise<CutResult> {
  mkdirSync(dirname(out), { recursive: true })
  const part = `${out}.part`
  const hash = createHash('sha256')
  const fh = await open(part, 'w')
  try {
    const write = async (bytes: Uint8Array) => {
      hash.update(bytes)
      let at = 0
      while (at < bytes.length) at += (await fh.write(bytes, at, bytes.length - at)).bytesWritten
    }
    await write(plan.prefix)
    let done = 0
    let lastLog = Date.now()
    await inOrder(
      plan.reads.length,
      4,
      (i) => source.read(plan.reads[i].offset, plan.reads[i].length),
      async (bytes, i) => {
        await write(outputOf(plan, plan.reads[i], bytes))
        done += plan.reads[i].length
        if (log && Date.now() - lastLog > 5000) {
          lastLog = Date.now()
          log(`  ${((100 * done) / plan.readLength).toFixed(0)}% (${(done / 1e6).toFixed(1)} of ${(plan.readLength / 1e6).toFixed(1)} MB)`)
        }
      },
    )
  } finally {
    await fh.close()
  }
  const size = (await stat(part)).size
  if (size !== plan.totalLength) throw new Error(`${out}: wrote ${size} bytes, planned ${plan.totalLength}`)
  await rename(part, out)
  return { plan, bytes: size, sha256: hash.digest('hex'), tiles: plan.tiles }
}

/** sha256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

// ---------- Terrain from AWS Terrain Tiles ----------

export interface TerrainOptions {
  minZoom: number
  maxZoom: number
  /** Folder to keep fetched tiles in, so a re-run fetches nothing twice. */
  cacheDir?: string
  concurrency?: number
  fetch?: typeof fetch
  log?: Log
}

async function fetchTerrainTile(z: number, x: number, y: number, opts: TerrainOptions): Promise<Uint8Array | null> {
  const cached = opts.cacheDir && join(opts.cacheDir, 'terrarium', String(z), String(x), `${y}.png`)
  if (cached && existsSync(cached)) return new Uint8Array(readFileSync(cached))
  const get = opts.fetch ?? fetch
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await get(AWS_TERRAIN(z, x, y), { headers: { 'User-Agent': USER_AGENT } })
      if (res.status === 404 || res.status === 403) return null
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length < 8 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) throw new Error('not a PNG')
      if (cached) {
        mkdirSync(dirname(cached), { recursive: true })
        writeFileSync(cached, bytes)
      }
      return bytes
    } catch (err) {
      if (attempt >= 6) throw new Error(`terrain ${z}/${x}/${y}: ${(err as Error).message}`)
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)))
    }
  }
}

/**
 * Pack the area's Terrarium tiles into one PMTiles file. Tiles are fetched
 * in tile-id order and appended to a temporary data file, so even a
 * province-sized archive never sits in memory.
 */
export async function buildTerrain(levels: ZoomTiles[], bounds: Bbox, out: string, opts: TerrainOptions): Promise<CutResult & { missing: number }> {
  const tiles = levels
    .filter((l) => l.z >= opts.minZoom && l.z <= opts.maxZoom)
    .flatMap(({ z, keys }) => {
      const n = 2 ** z
      return keys.map((k) => ({ z, x: Math.floor(k / n), y: k % n, id: zxyToTileId(z, Math.floor(k / n), k % n) }))
    })
    .sort((a, b) => a.id - b.id)
  mkdirSync(dirname(out), { recursive: true })
  const dataPath = `${out}.data`
  const data = createWriteStream(dataPath)
  const refs: { z: number; x: number; y: number; length: number }[] = []
  let missing = 0
  let lastLog = Date.now()
  await inOrder(
    tiles.length,
    opts.concurrency ?? 8,
    (i) => fetchTerrainTile(tiles[i].z, tiles[i].x, tiles[i].y, opts),
    async (bytes, i) => {
      if (!bytes) {
        missing++
        return
      }
      refs.push({ z: tiles[i].z, x: tiles[i].x, y: tiles[i].y, length: bytes.length })
      if (!data.write(bytes)) await once(data, 'drain')
      if (opts.log && Date.now() - lastLog > 5000) {
        lastLog = Date.now()
        opts.log(`  terrain ${i + 1} of ${tiles.length} tiles`)
      }
    },
  )
  data.end()
  await once(data, 'finish')
  const plan = planPack(refs, {
    tileType: PmTileType.Png,
    tileCompression: PmCompression.None,
    minZoom: opts.minZoom,
    maxZoom: opts.maxZoom,
    bounds,
    center: centerOf(bounds, Math.min(opts.maxZoom, opts.minZoom + 4)),
    metadata: {
      name: 'Terrain (Terrarium)',
      format: 'png',
      encoding: 'terrarium',
      attribution: TERRAIN_ATTRIBUTION,
      source: 'https://registry.opendata.aws/terrain-tiles/',
    },
  })
  // planPack orders tiles by id, which is the order they were written.
  const part = `${out}.part`
  const hash = createHash('sha256')
  const outStream = createWriteStream(part)
  const put = async (chunk: Uint8Array) => {
    hash.update(chunk)
    if (!outStream.write(chunk)) await once(outStream, 'drain')
  }
  await put(plan.prefix)
  for await (const chunk of createReadStream(dataPath)) await put(chunk as Buffer)
  outStream.end()
  await once(outStream, 'finish')
  rmSync(dataPath)
  const size = (await stat(part)).size
  if (size !== plan.totalLength) throw new Error(`${out}: wrote ${size} bytes, planned ${plan.totalLength}`)
  await rename(part, out)
  return {
    plan: { prefix: plan.prefix, blobs: [], reads: [], tiles: refs.length, dataLength: plan.tileDataLength, totalLength: size, readLength: plan.tileDataLength },
    bytes: size,
    sha256: hash.digest('hex'),
    tiles: refs.length,
    missing,
  }
}

// ---------- A whole pack ----------

export interface PackSpec {
  id: string
  name: string
  fireNumber?: string
  area: PackArea
  /** Rings as given (before simplifying), for pack.json and the hectares. */
  created: string
  basemap: ByteSource
  basemapBuild?: string
  /** A Terrarium PMTiles archive to cut from, or null to fetch AWS tiles. */
  terrain: ByteSource | null
  terrainBuild?: string
  basemapZooms: [number, number]
  terrainZooms: [number, number]
  outDir: string
  cacheDir?: string
  log?: Log
  /** For tests: fetch for AWS terrain tiles. */
  fetch?: typeof fetch
}

export async function buildPack(spec: PackSpec): Promise<PackManifest> {
  const log = spec.log ?? (() => {})
  const dir = join(spec.outDir, spec.id)
  mkdirSync(dir, { recursive: true })
  const bbox = areaBbox(spec.area)
  const files: PackFile[] = []

  log(`Basemap z${spec.basemapZooms[0]}–${spec.basemapZooms[1]} from ${spec.basemap.url}`)
  const cut = await planCut(spec.basemap, spec.area, spec.basemapZooms[0], spec.basemapZooms[1], {
    carmanah: { pack: spec.id, from: spec.basemap.url, build: spec.basemapBuild },
  })
  log(`  ${cut.plan.tiles} tiles (${cut.wanted} wanted), ${(cut.plan.totalLength / 1e6).toFixed(1)} MB, ${cut.plan.reads.length} reads`)
  const base = await writeCut(spec.basemap, cut.plan, join(dir, 'basemap.pmtiles'), log)
  files.push({
    name: 'basemap.pmtiles',
    source: 'basemap',
    format: 'mvt',
    minzoom: spec.basemapZooms[0],
    maxzoom: spec.basemapZooms[1],
    tiles: base.tiles,
    bytes: base.bytes,
    sha256: base.sha256,
    ...(spec.basemapBuild ? { build: spec.basemapBuild } : {}),
    from: spec.basemap.url,
    attribution: BASEMAP_ATTRIBUTION,
  })

  const [tMin, tMax] = spec.terrainZooms
  let terrain: CutResult
  if (spec.terrain) {
    log(`Terrain z${tMin}–${tMax} from ${spec.terrain.url}`)
    const t = await planCut(spec.terrain, spec.area, tMin, tMax)
    terrain = await writeCut(spec.terrain, t.plan, join(dir, 'terrain.pmtiles'), log)
  } else {
    log(`Terrain z${tMin}–${tMax} from AWS Terrain Tiles`)
    const levels = coverArea(simplifyArea(spec.area, tMax), tMin, tMax)
    terrain = await buildTerrain(levels, bbox, join(dir, 'terrain.pmtiles'), { minZoom: tMin, maxZoom: tMax, cacheDir: spec.cacheDir, log, fetch: spec.fetch })
  }
  log(`  ${terrain.tiles} tiles, ${(terrain.bytes / 1e6).toFixed(1)} MB`)
  files.push({
    name: 'terrain.pmtiles',
    source: 'terrain',
    format: 'png',
    encoding: 'terrarium',
    minzoom: tMin,
    maxzoom: tMax,
    tiles: terrain.tiles,
    bytes: terrain.bytes,
    sha256: terrain.sha256,
    ...(spec.terrainBuild ? { build: spec.terrainBuild } : {}),
    from: spec.terrain?.url ?? 'aws-terrain-tiles',
    attribution: TERRAIN_ATTRIBUTION,
  })

  const manifest: PackManifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: spec.id,
    name: spec.name,
    ...(spec.fireNumber ? { fireNumber: spec.fireNumber } : {}),
    created: spec.created,
    bbox: bbox.map((v) => Math.round(v * 1e5) / 1e5) as Bbox,
    bufferKm: spec.area.bufferM / 1000,
    perimeter: perimeterOf(spec.area.rings),
    areaHa: Math.round(ringsHectares(spec.area.rings)),
    files,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    attribution: `${BASEMAP_ATTRIBUTION}. ${TERRAIN_ATTRIBUTION}`,
    madeBy: 'builder',
  }
  writeFileSync(join(dir, 'pack.json'), manifestJson(manifest))
  return manifest
}

/** Tile counts and sizes without downloading tiles: the basemap exactly (from the index), terrain from a sample. */
export async function measure(source: ByteSource, area: PackArea, basemapZooms: [number, number], terrainZooms: [number, number], sample = 200) {
  const cut = await planCut(source, area, basemapZooms[0], basemapZooms[1])
  const levels = coverArea(simplifyArea(area, terrainZooms[1]), terrainZooms[0], terrainZooms[1])
  const terrainTiles = countTiles(levels, terrainZooms[0], terrainZooms[1])
  // Terrain sizes vary with ruggedness: HEAD a sample at each zoom.
  let estimate = 0
  for (const { z, keys } of levels.filter((l) => l.z >= terrainZooms[0] && l.z <= terrainZooms[1])) {
    const n = 2 ** z
    const step = Math.max(1, Math.floor(keys.length / sample))
    const picks = keys.filter((_, i) => i % step === 0).slice(0, sample)
    const sizes: number[] = []
    // A few at a time: hundreds of HEADs at once get connections reset.
    for (let i = 0; i < picks.length; i += 16) {
      sizes.push(
        ...(await Promise.all(
          picks.slice(i, i + 16).map(async (k) => {
            for (let attempt = 0; ; attempt++) {
              try {
                const res = await fetch(AWS_TERRAIN(z, Math.floor(k / n), k % n), { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } })
                return Number(res.headers.get('content-length') ?? 0)
              } catch (err) {
                if (attempt >= 3) throw err
                await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
              }
            }
          }),
        )),
      )
    }
    estimate += (sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length)) * keys.length
  }
  return {
    basemap: { tiles: cut.plan.tiles, bytes: cut.plan.totalLength, reads: cut.plan.reads.length, readBytes: cut.plan.readLength, indexBytes: cut.dirBytes },
    terrain: { tiles: terrainTiles, bytesEstimate: Math.round(estimate) },
    perZoom: cut.levels.map((l) => ({ z: l.z, tiles: l.keys.length })),
  }
}
