import type { FileStore } from '../storage/files'
import { Sha256 } from '../sha256'
import { PmCompression, PmTileType, planPack } from '../pmtiles-writer'
import { areaBbox, coverArea, ringsHectares, simplifyArea, tileIdsOf, type LonLat, type PackArea } from './area.ts'
import { locateTiles, openArchive, type ReadRange } from './archive.ts'
import { outputOf, planExtract, resumeAt, type ExtractPlan } from './extract.ts'
import {
  BASEMAP_ATTRIBUTION,
  PACK_FORMAT,
  PACK_VERSION,
  TERRAIN_ATTRIBUTION,
  manifestJson,
  parseManifest,
  perimeterOf,
  type PackFile,
  type PackManifest,
  type PackSource,
} from './manifest.ts'
import { JOB_FILE, MANIFEST_FILE, type JobSummary } from './registry'

/**
 * Downloading packs onto the phone, resumably.
 *
 * - **Cut** (the usual way): the area is cut out of the bucket's BC-wide
 *   archives with the same plan the Mac builder uses (./extract.ts). The
 *   plan is made before anything downloads, so the exact size is known.
 *   Each file is written to `<name>.part` one Range read at a time; after
 *   a dropped connection or a restart, the part file's size says which read
 *   comes next. Every read is pinned to the archive's ETag (If-Range), so a
 *   pack can't mix two builds.
 * - **Whole**: a ready-made pack from the bucket, fetched in 2 MB ranges,
 *   resumed the same way, then checked against pack.json's sha256.
 * - **Small**: no bucket (or outside it): tiles one by one from OpenFreeMap
 *   and AWS, within OpenFreeMap's terms (≤ 3,000 basemap tiles, 4 at a
 *   time). Not resumable; small enough to start again.
 *
 * Every file's sha256 is computed by reading it back from storage before it
 * is renamed into place, so pack.json describes what's really on disk.
 */

export const BASEMAP_ZOOMS: [number, number] = [6, 14]
export const TERRAIN_ZOOMS: [number, number] = [6, 12]
/** OpenFreeMap's per-download limit for in-app offline areas (openfreemap.org/tos). */
export const OFM_MAX_TILES = 3000
const OFM_PARALLEL = 4
const READ_GAP = 32 * 1024
/** Largest Range read: what a dropped connection can cost. */
const READ_MAX = 2 * 1024 * 1024
const WHOLE_CHUNK = 2 * 1024 * 1024
const HASH_CHUNK = 1024 * 1024
const IN_FLIGHT = 3

export interface JobFile {
  name: string
  source: PackSource
  format: PackFile['format']
  encoding?: 'terrarium'
  minzoom: number
  maxzoom: number
  /** Archive (cut) or file (whole) URL. */
  url: string
  /** The archive's ETag when planned: reads must match it. */
  etag: string
  /** Final size. */
  bytes: number
  tiles: number
  /** Expected (whole) or, once done, computed. */
  sha256?: string
  build?: string
  attribution: string
}

export interface PackJob extends JobSummary {
  kind: 'cut' | 'whole' | 'small'
  created: string
  area?: { rings: LonLat[][]; bufferM: number }
  /** Whole: the published pack.json. */
  manifest?: PackManifest
  files: JobFile[]
  /** True while it was downloading when last saved (resume it on the next start). */
  wasRunning?: boolean
  /** Cut: how reads were merged. A resume must re-plan with the same values. */
  reads?: { gap: number; max: number }
}

export interface Progress {
  done: number
  total: number
  /** No signal: retrying. */
  waiting: boolean
}

export class ArchiveChanged extends Error {
  constructor(url: string) {
    super(`The map on the server changed (${url.split('/').pop()}). Start the download again.`)
  }
}

class HttpStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

export interface Deps {
  fetch: typeof fetch
  /** Wait before retrying; resolves early when the phone comes back online. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>
}

export const defaultDeps = (): Deps => ({
  fetch: (...a) => fetch(...a),
  wait: (ms, signal) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        window.removeEventListener('online', done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      window.addEventListener('online', done)
      signal.addEventListener('abort', done)
    }),
})

// ---------- Range reads ----------

/** Reads from a hosted file by Range, pinned to one ETag once known. */
export function rangeReader(url: string, deps: Deps, signal?: AbortSignal, etag?: string) {
  let known = etag || ''
  const read: ReadRange = async (offset, length) => {
    const res = await deps.fetch(url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}`, ...(known ? { 'If-Range': known } : {}) },
      cache: 'no-store',
      signal,
    })
    if (res.status === 200 && known) {
      void res.body?.cancel().catch(() => {})
      throw new ArchiveChanged(url)
    }
    if (res.status !== 206) {
      void res.body?.cancel().catch(() => {})
      throw new HttpStatus(res.status)
    }
    const tag = res.headers.get('ETag') ?? ''
    if (known && tag && tag !== known) throw new ArchiveChanged(url)
    if (!known) known = tag
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '')
    if (!m || Number(m[1]) !== offset) throw new Error(`bad Content-Range "${res.headers.get('Content-Range')}"`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const expected = Math.min(length, Number(m[3]) - offset)
    if (bytes.length !== expected) throw new Error(`short read: ${bytes.length} of ${expected} bytes`)
    return bytes
  }
  return { read, etag: () => known }
}

const fatal = (err: unknown) =>
  err instanceof ArchiveChanged ||
  (err instanceof HttpStatus && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) ||
  (err as Error)?.name === 'AbortError'

/** Retry a network step until it works, the job is paused, or it fails for good. */
async function retrying<T>(step: () => Promise<T>, deps: Deps, signal: AbortSignal, onWaiting: (w: boolean) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new DOMException('paused', 'AbortError')
    try {
      const value = await step()
      if (attempt) onWaiting(false)
      return value
    } catch (err) {
      if (fatal(err) || signal.aborted) throw signal.aborted ? new DOMException('paused', 'AbortError') : err
      onWaiting(true)
      await deps.wait(Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)), signal)
    }
  }
}

// ---------- Planning ----------

export interface AreaRequest {
  id: string
  name: string
  fireNumber?: string
  area: PackArea
}

export interface PlannedDownload {
  job: PackJob
  /** Cut plans by file name (kept for the first run so it needn't re-plan). */
  plans: Map<string, ExtractPlan>
}

type ReadSizes = { gap: number; max: number }
const DEFAULT_READS: ReadSizes = { gap: READ_GAP, max: READ_MAX }

async function planOne(url: string, area: PackArea, zooms: [number, number], reads: ReadSizes, deps: Deps, signal?: AbortSignal, etag?: string) {
  const reader = rangeReader(url, deps, signal, etag)
  const index = await openArchive(reader.read)
  const levels = coverArea(simplifyArea(area, zooms[1]), zooms[0], zooms[1])
  const ids = tileIdsOf(levels, Math.max(zooms[0], index.header.minZoom), Math.min(zooms[1], index.header.maxZoom))
  const locations = await locateTiles(index, ids)
  const bounds = areaBbox(area)
  const plan = planExtract(
    index,
    locations,
    {
      minZoom: zooms[0],
      maxZoom: zooms[1],
      bounds,
      center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, Math.min(zooms[1], zooms[0] + 4)],
      metadata: { ...index.metadata, carmanah: { from: url } },
    },
    { maxGap: reads.gap, maxRead: reads.max },
  )
  return { plan, etag: reader.etag() }
}

/**
 * Plan cutting an area from the bucket's archives: reads their indexes
 * (a few hundred kB), not the tiles. The job's file sizes are exact.
 */
export async function planCut(
  req: AreaRequest,
  basemap: { url: string; build?: string },
  terrain: { url: string; version?: string },
  deps: Deps = defaultDeps(),
  signal?: AbortSignal,
  reads: ReadSizes = DEFAULT_READS,
): Promise<PlannedDownload> {
  const [b, t] = await Promise.all([
    planOne(basemap.url, req.area, BASEMAP_ZOOMS, reads, deps, signal),
    planOne(terrain.url, req.area, TERRAIN_ZOOMS, reads, deps, signal),
  ])
  const job: PackJob = {
    id: req.id,
    name: req.name,
    ...(req.fireNumber ? { fireNumber: req.fireNumber } : {}),
    kind: 'cut',
    created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    area: { rings: req.area.rings, bufferM: req.area.bufferM },
    reads,
    state: 'paused',
    bytesTotal: b.plan.totalLength + t.plan.totalLength,
    files: [
      {
        name: 'basemap.pmtiles', source: 'basemap', format: 'mvt', minzoom: BASEMAP_ZOOMS[0], maxzoom: BASEMAP_ZOOMS[1],
        url: basemap.url, etag: b.etag, bytes: b.plan.totalLength, tiles: b.plan.tiles,
        ...(basemap.build ? { build: basemap.build } : {}), attribution: BASEMAP_ATTRIBUTION,
      },
      {
        name: 'terrain.pmtiles', source: 'terrain', format: 'png', encoding: 'terrarium', minzoom: TERRAIN_ZOOMS[0], maxzoom: TERRAIN_ZOOMS[1],
        url: terrain.url, etag: t.etag, bytes: t.plan.totalLength, tiles: t.plan.tiles,
        ...(terrain.version ? { build: terrain.version } : {}), attribution: TERRAIN_ATTRIBUTION,
      },
    ],
  }
  return { job, plans: new Map([['basemap.pmtiles', b.plan], ['terrain.pmtiles', t.plan]]) }
}

/** Plan downloading a ready-made pack: its pack.json says what to fetch. */
export async function planWhole(packJsonUrl: string, deps: Deps = defaultDeps()): Promise<PlannedDownload> {
  const res = await deps.fetch(packJsonUrl, { cache: 'no-cache' })
  if (!res.ok) throw new HttpStatus(res.status)
  const manifest = parseManifest(await res.json())
  const job: PackJob = {
    id: manifest.id,
    name: manifest.name,
    ...(manifest.fireNumber ? { fireNumber: manifest.fireNumber } : {}),
    kind: 'whole',
    created: manifest.created,
    manifest,
    state: 'paused',
    bytesTotal: manifest.bytes,
    files: manifest.files.map((f) => ({ ...f, url: new URL(f.name, packJsonUrl).href, etag: '' })),
  }
  return { job, plans: new Map() }
}

// ---------- Running ----------

export async function saveJob(store: FileStore, job: PackJob) {
  await store.write(`${job.id}/${JOB_FILE}`, [JSON.stringify(job)])
}

export async function readJob(store: FileStore, id: string): Promise<PackJob | null> {
  try {
    const blob = await store.read(`${id}/${JOB_FILE}`)
    return blob ? (JSON.parse(await blob.text()) as PackJob) : null
  } catch {
    return null
  }
}

/** sha256 of a stored file, read back a piece at a time. */
export async function hashStored(store: FileStore, path: string, size: number): Promise<string> {
  const h = new Sha256()
  for (let at = 0; at < size; at += HASH_CHUNK) {
    h.update(new Uint8Array(await store.readRange(path, at, Math.min(HASH_CHUNK, size - at))))
  }
  return h.hex()
}

/** Run reads `from..count-1` with a few in flight, handing results over in order. */
async function inOrder<T>(from: number, count: number, job: (i: number) => Promise<T>, use: (v: T, i: number) => Promise<void>) {
  const started = new Map<number, Promise<T>>()
  let next = from
  const fill = () => {
    while (next < count && started.size < IN_FLIGHT) {
      const p = job(next)
      p.catch(() => {}) // handled when awaited
      started.set(next++, p)
    }
  }
  try {
    for (let i = from; i < count; i++) {
      fill()
      const v = await started.get(i)!
      started.delete(i)
      fill()
      await use(v, i)
    }
  } finally {
    started.clear()
  }
}

export interface RunOptions {
  store: FileStore
  deps?: Deps
  signal: AbortSignal
  onProgress?: (p: Progress) => void
  /** Plans from planCut, to skip re-planning on the first run. */
  plans?: Map<string, ExtractPlan>
}

/**
 * Download (or carry on downloading) a cut or whole pack. Resolves with its
 * manifest once pack.json is written; rejects with an AbortError when
 * paused, or the reason it failed.
 */
export async function runJob(job: PackJob, opts: RunOptions): Promise<PackManifest> {
  const { store, signal } = opts
  const deps = opts.deps ?? defaultDeps()
  if (job.kind === 'small') throw new Error('small-area downloads run with downloadSmallArea')
  job.state = 'running'
  job.wasRunning = true
  delete job.error
  await saveJob(store, job)

  const sizes = new Map<string, number>()
  let waiting = false
  const report = () =>
    opts.onProgress?.({ done: [...sizes.values()].reduce((a, b) => a + b, 0), total: job.bytesTotal, waiting })
  const onWaiting = (w: boolean) => {
    waiting = w
    report()
  }

  for (const file of job.files) {
    const final = `${job.id}/${file.name}`
    const part = `${final}.part`
    if ((await store.size(final)) === file.bytes && file.sha256) {
      sizes.set(file.name, file.bytes)
      continue
    }
    let size = (await store.size(part)) ?? 0
    sizes.set(file.name, size)
    report()

    if (job.kind === 'cut') {
      let plan = opts.plans?.get(file.name)
      if (!plan) {
        const zooms: [number, number] = [file.minzoom, file.maxzoom]
        plan = await retrying(
          async () => (await planOne(file.url, job.area!, zooms, job.reads ?? DEFAULT_READS, deps, signal, file.etag)).plan,
          deps,
          signal,
          onWaiting,
        )
      }
      if (plan.totalLength !== file.bytes) throw new ArchiveChanged(file.url)
      let next = size === 0 ? 0 : resumeAt(plan, size)
      if (next === null) {
        // A write was cut short mid-read: start this file again.
        await store.remove(part)
        size = 0
        next = 0
      }
      if (size === 0) {
        size = await store.append(part, plan.prefix)
        sizes.set(file.name, size)
      }
      const reader = rangeReader(file.url, deps, signal, file.etag)
      const p = plan
      await inOrder(
        next,
        p.reads.length,
        (i) => retrying(() => reader.read(p.reads[i].offset, p.reads[i].length), deps, signal, onWaiting),
        async (bytes, i) => {
          size = await store.append(part, outputOf(p, p.reads[i], bytes))
          if (size !== p.reads[i].outEnd) throw new Error(`${file.name}: ${size} bytes on disk, expected ${p.reads[i].outEnd}`)
          sizes.set(file.name, size)
          report()
        },
      )
    } else {
      if (size > file.bytes) {
        await store.remove(part)
        size = 0
      }
      const reader = rangeReader(file.url, deps, signal, file.etag || undefined)
      const starts: number[] = []
      for (let at = size; at < file.bytes; at += WHOLE_CHUNK) starts.push(at)
      await inOrder(
        0,
        starts.length,
        (i) => retrying(() => reader.read(starts[i], Math.min(WHOLE_CHUNK, file.bytes - starts[i])), deps, signal, onWaiting),
        async (bytes) => {
          size = await store.append(part, bytes)
          sizes.set(file.name, size)
          report()
        },
      )
      if (!file.etag && reader.etag()) file.etag = reader.etag()
    }

    if (size !== file.bytes) throw new Error(`${file.name}: ${size} of ${file.bytes} bytes`)
    const sha = await hashStored(store, part, size)
    if (file.sha256 && sha !== file.sha256) {
      await store.remove(part)
      throw new Error(`${file.name} arrived damaged (checksum mismatch). Download it again.`)
    }
    file.sha256 = sha
    await store.rename(part, final)
    await saveJob(store, job)
  }

  const manifest = job.kind === 'whole' ? { ...job.manifest!, files: job.manifest!.files } : manifestFor(job)
  await store.write(`${job.id}/${MANIFEST_FILE}`, [manifestJson(manifest)])
  await store.remove(`${job.id}/${JOB_FILE}`)
  return manifest
}

function manifestFor(job: PackJob): PackManifest {
  const area: PackArea = { rings: job.area!.rings, bufferM: job.area!.bufferM }
  const files: PackFile[] = job.files.map((f) => ({
    name: f.name,
    source: f.source,
    format: f.format,
    ...(f.encoding ? { encoding: f.encoding } : {}),
    minzoom: f.minzoom,
    maxzoom: f.maxzoom,
    tiles: f.tiles,
    bytes: f.bytes,
    sha256: f.sha256!,
    ...(f.build ? { build: f.build } : {}),
    from: f.url,
    attribution: f.attribution,
  }))
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: job.id,
    name: job.name,
    ...(job.fireNumber ? { fireNumber: job.fireNumber } : {}),
    created: job.created,
    bbox: areaBbox(area).map((v) => Math.round(v * 1e5) / 1e5) as PackManifest['bbox'],
    bufferKm: area.bufferM / 1000,
    perimeter: perimeterOf(area.rings),
    areaHa: Math.round(ringsHectares(area.rings)),
    files,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    attribution: [...new Set(files.map((f) => f.attribution))].join('. '),
    madeBy: 'app',
  }
}

// ---------- Small areas, tile by tile ----------

export interface SmallPlan {
  basemap: { z: number; x: number; y: number }[]
  terrain: { z: number; x: number; y: number }[]
}

function tilesOf(levels: ReturnType<typeof coverArea>, min: number, max: number) {
  return levels
    .filter((l) => l.z >= min && l.z <= max)
    .flatMap(({ z, keys }) => keys.map((k) => ({ z, x: Math.floor(k / 2 ** z), y: k % 2 ** z })))
}

/** The tiles a small-area download fetches. */
export function planSmall(area: PackArea): SmallPlan {
  const levels = coverArea(simplifyArea(area, BASEMAP_ZOOMS[1]), BASEMAP_ZOOMS[0], BASEMAP_ZOOMS[1])
  return { basemap: tilesOf(levels, ...BASEMAP_ZOOMS), terrain: tilesOf(levels, ...TERRAIN_ZOOMS) }
}

/**
 * Download a small area tile by tile: basemap from OpenFreeMap (≤ 3,000
 * tiles, 4 requests at a time, per its terms), terrain from AWS. Tiles are
 * held in memory (a few tens of MB at most), then written as one pack.
 */
export async function downloadSmallArea(
  req: AreaRequest,
  opts: { store: FileStore; signal: AbortSignal; tileJsonUrl: string; terrainUrl: (z: number, x: number, y: number) => string; deps?: Deps; onProgress?: (p: Progress) => void },
): Promise<PackManifest> {
  const deps = opts.deps ?? defaultDeps()
  const { store, signal } = opts
  const plan = planSmall(req.area)
  if (plan.basemap.length > OFM_MAX_TILES) {
    throw new Error(`This area needs ${plan.basemap.length} basemap tiles; without hosted maps the limit is ${OFM_MAX_TILES}. Choose a smaller area.`)
  }
  const job: PackJob = {
    id: req.id,
    name: req.name,
    ...(req.fireNumber ? { fireNumber: req.fireNumber } : {}),
    kind: 'small',
    created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    area: { rings: req.area.rings, bufferM: req.area.bufferM },
    state: 'running',
    wasRunning: true,
    bytesTotal: 0,
    files: [],
  }
  await saveJob(store, job)
  let waiting = false
  const total = plan.basemap.length + plan.terrain.length
  let done = 0
  const report = () => opts.onProgress?.({ done, total, waiting })
  const onWaiting = (w: boolean) => {
    waiting = w
    report()
  }

  const tj = await retrying(
    async () => {
      const res = await deps.fetch(opts.tileJsonUrl, { signal })
      if (!res.ok) throw new HttpStatus(res.status)
      return (await res.json()) as { tiles: string[] }
    },
    deps,
    signal,
    onWaiting,
  )
  const template = tj.tiles[0]
  const build = /\/planet\/([^/]+)\//.exec(template)?.[1]
  const fetchAll = async (tiles: { z: number; x: number; y: number }[], url: (t: { z: number; x: number; y: number }) => string) => {
    const out: ({ z: number; x: number; y: number; data: Uint8Array } | null)[] = new Array(tiles.length).fill(null)
    let i = 0
    const worker = async () => {
      while (i < tiles.length) {
        const k = i++
        const bytes = await retrying(
          async () => {
            const res = await deps.fetch(url(tiles[k]), { signal })
            if (res.status === 404 || res.status === 204) return null
            if (!res.ok) throw new HttpStatus(res.status)
            return new Uint8Array(await res.arrayBuffer())
          },
          deps,
          signal,
          onWaiting,
        )
        if (bytes?.length) out[k] = { ...tiles[k], data: bytes }
        done++
        report()
      }
    }
    await Promise.all(Array.from({ length: OFM_PARALLEL }, worker))
    return out.filter((t): t is NonNullable<typeof t> => !!t)
  }
  const fill = (t: string, { z, x, y }: { z: number; x: number; y: number }) =>
    t.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  const basemap = await fetchAll(plan.basemap, (t) => fill(template, t))
  const terrain = await fetchAll(plan.terrain, (t) => opts.terrainUrl(t.z, t.x, t.y))

  const bounds = areaBbox(req.area)
  const center: [number, number, number] = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, 10]
  const write = async (name: string, tiles: typeof basemap, info: { tileType: number; zooms: [number, number]; meta: Record<string, unknown> }) => {
    const p = planPack(tiles.map(({ z, x, y, data }) => ({ z, x, y, length: data.length })), {
      tileType: info.tileType as 1 | 2,
      tileCompression: PmCompression.None,
      minZoom: info.zooms[0],
      maxZoom: info.zooms[1],
      bounds,
      center,
      metadata: info.meta,
    })
    const byKey = new Map(tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t.data]))
    const parts = [p.prefix, ...p.tiles.map((t) => byKey.get(`${t.z}/${t.x}/${t.y}`)!)]
    const h = new Sha256()
    for (const part of parts) h.update(part)
    await store.write(`${req.id}/${name}`, parts as BlobPart[])
    return { bytes: p.totalLength, sha256: h.hex(), tiles: tiles.length }
  }
  const b = await write('basemap.pmtiles', basemap, { tileType: PmTileType.Mvt, zooms: BASEMAP_ZOOMS, meta: { name: 'OpenFreeMap', attribution: BASEMAP_ATTRIBUTION, build } })
  const t = await write('terrain.pmtiles', terrain, { tileType: PmTileType.Png, zooms: TERRAIN_ZOOMS, meta: { encoding: 'terrarium', attribution: TERRAIN_ATTRIBUTION } })
  job.files = [
    { name: 'basemap.pmtiles', source: 'basemap', format: 'mvt', minzoom: BASEMAP_ZOOMS[0], maxzoom: BASEMAP_ZOOMS[1], url: template, etag: '', bytes: b.bytes, tiles: b.tiles, sha256: b.sha256, ...(build ? { build } : {}), attribution: BASEMAP_ATTRIBUTION },
    { name: 'terrain.pmtiles', source: 'terrain', format: 'png', encoding: 'terrarium', minzoom: TERRAIN_ZOOMS[0], maxzoom: TERRAIN_ZOOMS[1], url: 'aws-terrain-tiles', etag: '', bytes: t.bytes, tiles: t.tiles, sha256: t.sha256, attribution: TERRAIN_ATTRIBUTION },
  ]
  const manifest = manifestFor(job)
  await store.write(`${req.id}/${MANIFEST_FILE}`, [manifestJson(manifest)])
  await store.remove(`${req.id}/${JOB_FILE}`)
  return manifest
}
