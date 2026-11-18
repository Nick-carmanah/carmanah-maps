// Pack layout on disk (Directory.LibraryNoCloud):
//
//   maps/_packs/<name>/
//     pack.json            manifest: area, zooms, tile index, download/build timings
//     style.json           OpenFreeMap Liberty, rewritten to read from this pack
//     sprites/ofm[@2x].{json,png}
//     glyphs/<fontstack>/<range>.pbf
//     tiles/<src>/<z>/<x>/<y>.<ext>   read path "file"   (one file per tile)
//     <src>.pmtiles                   read paths "range" and "offset" (one file per source)
//
// <src> is "omt" (OpenMapTiles vector tiles from OpenFreeMap) or "terrain"
// (AWS Terrain Tiles, terrarium-encoded PNG).
//
// Three ways to get a tile's bytes back into the web view, each registered as
// a MapLibre custom protocol so the same style can be pointed at any of them:
//
//   pkfile://   Filesystem.readFile on the per-tile file (base64 over the bridge)
//   pkrange://  fetch(convertFileSrc(pack), { Range }) — Capacitor's own scheme
//               handler seeks and reads just those bytes; binary, no base64
//   pkoffset:// Filesystem.readFile({ offset, length }) on the pack (8.1+);
//               base64 over the bridge

import maplibregl from 'maplibre-gl'
import { PMTiles, type RangeResponse, type Source } from 'pmtiles'
import { Filesystem } from '@capacitor/filesystem'
import { DIR, PACKS, now, readBytes, readText, webUrl } from './fsx.ts'

export type ReadPath = 'file' | 'range' | 'offset'
export const READ_PATHS: ReadPath[] = ['file', 'range', 'offset']
export type SrcId = 'omt' | 'terrain'
export const SOURCES: SrcId[] = ['omt', 'terrain']
export const EXT: Record<SrcId, string> = { omt: 'pbf', terrain: 'png' }

export interface PackManifest {
  name: string
  created: string
  bbox: [number, number, number, number]
  center: [number, number]
  minZoom: number
  maxZoom: number
  attribution: string
  upstream: Record<string, string>
  tiles: Record<SrcId, [number, number, number, number][]> // z, x, y, bytes
  glyphs: { fontstacks: string[]; ranges: string[]; missing: string[] }
  download?: Record<string, unknown>
  packed?: Record<string, { file: string; bytes: number; buildMs: number; leafCount: number }>
}

export const packDir = (pack: string) => `${PACKS}/${pack}`
export const tilePath = (pack: string, src: SrcId, z: number, x: number, y: number) =>
  `${packDir(pack)}/tiles/${src}/${z}/${x}/${y}.${EXT[src]}`
export const pmtilesPath = (pack: string, src: string) => `${packDir(pack)}/${src}.pmtiles`

export async function loadManifest(pack: string): Promise<PackManifest> {
  return JSON.parse(await readText(`${packDir(pack)}/pack.json`))
}

// ---------- PMTiles sources ----------

/** Byte ranges through Capacitor's WKURLSchemeHandler (capacitor://localhost/_capacitor_file_/…). */
export class RangeFetchSource implements Source {
  rangeIgnored = false
  constructor(private url: string) {}
  getKey() { return this.url }
  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    const resp = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal, cache: 'no-store' })
    if (resp.status !== 206 && resp.status !== 200) throw new Error(`range read ${resp.status}`)
    let data = await resp.arrayBuffer()
    if (resp.status === 200 && data.byteLength > length) {
      // Server ignored Range and sent the whole file. Never acceptable for a big pack.
      this.rangeIgnored = true
      data = data.slice(offset, offset + length)
    }
    return { data }
  }
}

/** Byte ranges through Filesystem.readFile({ offset, length }) — base64 over the bridge. */
export class FsOffsetSource implements Source {
  private size = -1
  constructor(private path: string) {}
  getKey() { return 'fs:' + this.path }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    if (this.size < 0) this.size = (await Filesystem.stat({ path: this.path, directory: DIR })).size
    const len = Math.max(0, Math.min(length, this.size - offset))
    const bytes = await readBytes(this.path, offset, len)
    return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }
  }
}

const archives = new Map<string, PMTiles>()
export const rangeSources = new Map<string, RangeFetchSource>()

export async function archive(pack: string, src: string, path: 'range' | 'offset', file?: string): Promise<PMTiles> {
  const p = file ?? pmtilesPath(pack, src)
  const key = `${path}:${p}`
  let a = archives.get(key)
  if (!a) {
    let source: Source
    if (path === 'range') {
      const s = new RangeFetchSource(await webUrl(p))
      rangeSources.set(key, s)
      source = s
    } else source = new FsOffsetSource(p)
    a = new PMTiles(source)
    archives.set(key, a)
  }
  return a
}

export function forgetArchives() { archives.clear(); rangeSources.clear() }

/** Read one tile by any path. Returns null when the pack doesn't have it. */
export async function readTile(path: ReadPath, pack: string, src: SrcId, z: number, x: number, y: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  if (path === 'file') {
    try { return await readBytes(tilePath(pack, src, z, x, y)) } catch { return null }
  }
  const a = await archive(pack, src, path)
  const r = await a.getZxy(z, x, y, signal)
  return r ? new Uint8Array(r.data) : null
}

// ---------- MapLibre protocols + live stats ----------

export interface ReqStats { ms: number[]; bytes: number; misses: number; errors: number }
export const stats: Record<string, ReqStats> = {}
function stat(key: string): ReqStats { return (stats[key] ??= { ms: [], bytes: 0, misses: 0, errors: 0 }) }
export function resetStats() { for (const k of Object.keys(stats)) delete stats[k] }
export const missingGlyphs = new Set<string>()

const TILE_RE = /^pk(file|range|offset):\/\/([^/]+)\/(omt|terrain)\/(\d+)\/(\d+)\/(\d+)/

let registered = false
export function registerProtocols() {
  if (registered) return
  registered = true
  for (const path of READ_PATHS) {
    maplibregl.addProtocol('pk' + path, async (params, abort) => {
      const m = TILE_RE.exec(params.url)
      if (!m) throw new Error('bad tile url ' + params.url)
      const [, , pack, src, z, x, y] = m
      const s = stat(`${path}/${src}`)
      const t0 = now()
      try {
        const bytes = await readTile(path, pack, src as SrcId, +z, +x, +y, abort.signal)
        s.ms.push(now() - t0)
        if (!bytes) {
          s.misses++
          if (src === 'omt') return { data: new ArrayBuffer(0) }
          throw new Error('tile not in pack')
        }
        s.bytes += bytes.byteLength
        return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') s.errors++
        throw e
      }
    })
  }

  // Glyphs and sprites: small files, fetched whole through the scheme handler.
  maplibregl.addProtocol('pkasset', async (params) => {
    const m = /^pkasset:\/\/([^/]+)\/(.+)$/.exec(params.url)
    if (!m) throw new Error('bad asset url ' + params.url)
    const rel = decodeURIComponent(m[2])
    const kind = rel.startsWith('glyphs/') ? 'glyphs' : 'sprites'
    const s = stat(`asset/${kind}`)
    const t0 = now()
    let resp: Response
    try {
      resp = await fetch(await webUrl(`${packDir(m[1])}/${rel}`), { cache: 'no-store' })
    } catch {
      // Missing file: the scheme handler fails the request.
      s.misses++
      if (kind === 'glyphs') { missingGlyphs.add(rel); return { data: new ArrayBuffer(0) } }
      throw new Error('missing ' + rel)
    }
    const data = params.type === 'json' ? await resp.json() : await resp.arrayBuffer()
    s.ms.push(now() - t0)
    return { data }
  })
}

/** The pack's style, pointed at one read path. */
export async function styleFor(pack: string, path: ReadPath): Promise<maplibregl.StyleSpecification> {
  const raw = await readText(`${packDir(pack)}/style.json`)
  return JSON.parse(raw.replaceAll('pkfile://', `pk${path}://`))
}
