// Open Sentinel-2 band COGs over HTTP (Range requests) and load decoded
// blocks on demand, with an LRU cache so neighbouring tiles share reads.

import { fromUrl, type GeoTIFFImage } from 'geotiff'
import proj4 from 'proj4'
import { dnLookup, type DnEncoding } from './stretch.ts'
import type { Block, BlockLookup, Level, SourceRaster } from './render.ts'

export interface SourceSpec {
  id: string
  /** EPSG code of the item's UTM zone, e.g. 32610. */
  epsg: number
  /** Red, green, blue band COG URLs (https; presigned for CDSE). */
  bands: [string, string, string]
  encoding: DnEncoding
  /** [west, south, east, north] from the STAC item. */
  bbox: [number, number, number, number]
  /** Date or quarter, for the log and metadata. */
  date: string
  /** Bytes of the three band files (STAC file:size), if known. */
  bytes?: number
  /** 0 = main imagery; higher = older imagery used only to fill gaps. */
  priority?: number
}

export interface OpenSource extends SourceRaster {
  spec: SourceSpec
  /** images[band][level] */
  images: GeoTIFFImage[][]
}

function utmZone(epsg: number): { zone: number; south: boolean } {
  if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false }
  if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true }
  throw new Error(`EPSG:${epsg} is not a WGS 84 UTM zone`)
}

/** NewSubfileType bit 2 marks a transparency mask, not an overview. */
function isMask(image: GeoTIFFImage): boolean {
  const fd = image.fileDirectory as unknown as { getValue?: (k: string) => unknown; NewSubfileType?: number }
  const v = (fd.getValue ? fd.getValue('NewSubfileType') : fd.NewSubfileType) as number | undefined
  return typeof v === 'number' && (v & 4) !== 0
}

export async function openSource(spec: SourceSpec): Promise<OpenSource> {
  const tiffs = await Promise.all(spec.bands.map((url) => fromUrl(url)))
  const images: GeoTIFFImage[][] = []
  for (const tiff of tiffs) {
    const count = await tiff.getImageCount()
    const levels: GeoTIFFImage[] = []
    for (let i = 0; i < count; i++) {
      const image = await tiff.getImage(i)
      if (!isMask(image)) levels.push(image)
    }
    images.push(levels)
  }
  const base = images[0][0]
  const [originX, originY] = base.getOrigin()
  const [resX] = base.getResolution()
  const levels: Level[] = images[0].map((image) => ({
    width: image.getWidth(),
    height: image.getHeight(),
    originX,
    originY,
    res: (resX * base.getWidth()) / image.getWidth(),
    blockWidth: image.getTileWidth(),
    blockHeight: image.getTileHeight(),
  }))
  for (const band of images) {
    if (band.length !== levels.length || band.some((im, i) => im.getWidth() !== levels[i].width)) {
      throw new Error(`${spec.id}: bands have different layouts`)
    }
  }
  const { zone, south } = utmZone(spec.epsg)
  const utm = proj4('EPSG:4326', `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`)
  return {
    id: spec.id,
    spec,
    images,
    forward: (lon, lat) => utm.forward([lon, lat]) as [number, number],
    centralMeridian: -183 + 6 * zone,
    levels,
    lut: dnLookup(spec.encoding),
    signed: spec.encoding.signed,
    nodata: spec.encoding.nodata,
    bbox: spec.bbox,
    priority: spec.priority ?? 0,
  }
}

/** Decoded blocks, least recently used dropped past a byte budget. */
export class BlockCache implements BlockLookup {
  private readonly blocks = new Map<string, Block & { bytes: number }>()
  private readonly pending = new Map<string, Promise<Block & { bytes: number }>>()
  private bytes = 0
  private readonly budget: number
  /** Blocks read from the network, for the log. */
  loaded = 0

  constructor(budgetBytes: number) {
    this.budget = budgetBytes
  }

  private static key(source: SourceRaster, level: number, bx: number, by: number): string {
    return `${source.id}|${level}|${bx}|${by}`
  }

  get(source: SourceRaster, level: number, bx: number, by: number): Block | undefined {
    const key = BlockCache.key(source, level, bx, by)
    const block = this.blocks.get(key)
    if (block) {
      // Re-insert: Map order is the LRU order.
      this.blocks.delete(key)
      this.blocks.set(key, block)
    }
    return block
  }

  /** A block, read from the network if it isn't cached. */
  async load(source: OpenSource, level: number, bx: number, by: number): Promise<Block> {
    const key = BlockCache.key(source, level, bx, by)
    const cached = this.get(source, level, bx, by)
    if (cached) return cached
    let pending = this.pending.get(key)
    if (!pending) {
      pending = this.read(source, level, bx, by).then((block) => {
        this.blocks.set(key, block)
        this.bytes += block.bytes
        this.loaded++
        this.evict()
        return block
      })
      pending.finally(() => this.pending.delete(key)).catch(() => {})
      this.pending.set(key, pending)
    }
    return pending
  }

  private async read(source: OpenSource, level: number, bx: number, by: number) {
    const L = source.levels[level]
    const x0 = bx * L.blockWidth
    const y0 = by * L.blockHeight
    const x1 = Math.min(L.width, x0 + L.blockWidth)
    const y1 = Math.min(L.height, y0 + L.blockHeight)
    const bands = (await Promise.all(
      source.images.map(async (levels) => {
        const r = await levels[level].readRasters({ window: [x0, y0, x1, y1], samples: [0] })
        return (r as unknown as ArrayLike<number>[])[0]
      }),
    )) as Block['bands']
    const bytes = bands.reduce((n, b) => n + (b as unknown as { byteLength: number }).byteLength, 0)
    return { width: x1 - x0, height: y1 - y0, bands, bytes }
  }

  private evict(): void {
    for (const [key, block] of this.blocks) {
      if (this.bytes <= this.budget) break
      this.blocks.delete(key)
      this.bytes -= block.bytes
    }
  }
}

/**
 * Limit concurrent HTTP requests (CDSE allows 4 connections per user) and
 * retry transient failures with backoff. geotiff.js calls the global fetch,
 * so this wraps it for the whole build process. A slot is held until the
 * body is read, so the limit counts real transfers.
 */
export function limitFetch(maxConcurrent: number, retries = 5): void {
  const realFetch = globalThis.fetch.bind(globalThis)
  let active = 0
  const queue: (() => void)[] = []
  const acquire = () =>
    new Promise<void>((resolve) => {
      const go = () => {
        active++
        resolve()
      }
      if (active < maxConcurrent) go()
      else queue.push(go)
    })
  const release = () => {
    active--
    queue.shift()?.()
  }
  globalThis.fetch = async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      await acquire()
      try {
        const res = await realFetch(input, init)
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          await res.arrayBuffer().catch(() => {})
          throw new Error(`HTTP ${res.status}`)
        }
        const body = await res.arrayBuffer()
        release()
        return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
      } catch (err) {
        release()
        if (attempt >= retries || (init?.signal as AbortSignal | undefined)?.aborted) throw err
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
      }
    }
  }
}
