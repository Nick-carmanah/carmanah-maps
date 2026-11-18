// Draw one Web Mercator tile from UTM source rasters (no I/O here).
//
// Two steps so reading stays async and drawing stays fast:
//   planTile()  which sources and which of their blocks the tile needs;
//   drawTile()  once those blocks are loaded, the 256 × 256 RGBA pixels.
//
// Each pixel is reprojected (Web Mercator → lon/lat → UTM) through a 9 × 9
// grid of exact points with bilinear interpolation in between, the way GDAL's
// approximate transformer works; the error is far below a pixel. Samples are
// bilinear in the source. Where sources overlap (neighbouring UTM grid
// squares), the one whose zone's central meridian is nearest wins; nodata
// falls through to the next.

import { lutIndex } from './stretch.ts'
import { TILE_SIZE, groundResolution, tileBounds, type TileId } from './tiles.ts'

export interface Level {
  width: number
  height: number
  /** Top-left corner of the top-left pixel, projected metres. */
  originX: number
  originY: number
  /** Metres per pixel (square pixels). */
  res: number
  blockWidth: number
  blockHeight: number
}

export interface SourceRaster {
  id: string
  /** lon/lat → projected metres (the source's UTM zone). */
  forward(lon: number, lat: number): [number, number]
  centralMeridian: number
  /** Full resolution first, then overviews. */
  levels: Level[]
  /** Byte for each DN (dnLookup in stretch.ts). */
  lut: Uint8Array
  signed: boolean
  nodata: number
  /** [west, south, east, north] */
  bbox: [number, number, number, number]
  /** 0 = the main imagery; 1, 2… = older imagery that only fills its gaps. */
  priority?: number
}

/** A decoded block: the three bands (red, green, blue) of one source block. */
export interface Block {
  width: number
  height: number
  bands: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>]
}

export interface BlockKey {
  source: SourceRaster
  level: number
  bx: number
  by: number
}

export interface BlockLookup {
  get(source: SourceRaster, level: number, bx: number, by: number): Block | undefined
}

const GRID = 8 // cells per side; (GRID + 1)² exact points per tile

export interface PlanEntry {
  source: SourceRaster
  level: number
  /** Level pixel coordinates (x, y) at each grid point, row-major. */
  grid: Float64Array
  blocks: BlockKey[]
}

export interface TilePlan {
  tile: TileId
  entries: PlanEntry[]
}

/** Coarsest level that is still at least as sharp as the tile needs. */
export function chooseLevel(levels: Level[], metresPerPixel: number): number {
  let best = 0
  for (let i = 1; i < levels.length; i++) if (levels[i].res <= metresPerPixel * 1.0001) best = i
  return best
}

export function planTile(tile: TileId, sources: SourceRaster[]): TilePlan {
  const [w, s, e, n] = tileBounds(tile)
  const centreLon = (w + e) / 2
  const metresPerPixel = groundResolution((s + n) / 2, tile.z)
  const entries: PlanEntry[] = []
  for (const source of sources) {
    const [sw, ss, se, sn] = source.bbox
    if (se < w || sw > e || sn < s || ss > n) continue
    const level = chooseLevel(source.levels, metresPerPixel)
    const L = source.levels[level]
    const grid = new Float64Array((GRID + 1) * (GRID + 1) * 2)
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let gy = 0; gy <= GRID; gy++) {
      for (let gx = 0; gx <= GRID; gx++) {
        const lon = w + ((e - w) * gx) / GRID
        // Mercator rows are evenly spaced in y, not latitude.
        const lat = latAtTileFraction(tile, gy / GRID)
        const [X, Y] = source.forward(lon, lat)
        const px = (X - L.originX) / L.res
        const py = (L.originY - Y) / L.res
        const k = (gy * (GRID + 1) + gx) * 2
        grid[k] = px
        grid[k + 1] = py
        minX = Math.min(minX, px)
        maxX = Math.max(maxX, px)
        minY = Math.min(minY, py)
        maxY = Math.max(maxY, py)
      }
    }
    // One pixel of slack for bilinear neighbours.
    const x0 = Math.max(0, Math.floor(minX) - 1)
    const x1 = Math.min(L.width - 1, Math.ceil(maxX) + 1)
    const y0 = Math.max(0, Math.floor(minY) - 1)
    const y1 = Math.min(L.height - 1, Math.ceil(maxY) + 1)
    if (x0 > x1 || y0 > y1) continue
    const blocks: BlockKey[] = []
    for (let by = Math.floor(y0 / L.blockHeight); by <= Math.floor(y1 / L.blockHeight); by++) {
      for (let bx = Math.floor(x0 / L.blockWidth); bx <= Math.floor(x1 / L.blockWidth); bx++) {
        blocks.push({ source, level, bx, by })
      }
    }
    entries.push({ source, level, grid, blocks })
  }
  entries.sort(
    (a, b) =>
      (a.source.priority ?? 0) - (b.source.priority ?? 0) ||
      Math.abs(a.source.centralMeridian - centreLon) - Math.abs(b.source.centralMeridian - centreLon),
  )
  return { tile, entries }
}

function latAtTileFraction(tile: TileId, f: number): number {
  const y = tile.y + f
  const nn = Math.PI * (1 - (2 * y) / 2 ** tile.z)
  return (Math.atan(Math.sinh(nn)) * 180) / Math.PI
}

/** The RGBA tile; alpha 0 where no source has data. */
export function drawTile(plan: TilePlan, lookup: BlockLookup): Uint8Array {
  const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4)
  if (plan.entries.length === 0) return rgba
  const rgb = new Uint8Array(3)
  const cell = TILE_SIZE / GRID
  for (let j = 0; j < TILE_SIZE; j++) {
    const fy = (j + 0.5) / cell
    const gy = Math.min(GRID - 1, Math.floor(fy))
    const ty = fy - gy
    for (let i = 0; i < TILE_SIZE; i++) {
      const fx = (i + 0.5) / cell
      const gx = Math.min(GRID - 1, Math.floor(fx))
      const tx = fx - gx
      for (const entry of plan.entries) {
        const g = entry.grid
        const k00 = (gy * (GRID + 1) + gx) * 2
        const k10 = k00 + 2
        const k01 = k00 + (GRID + 1) * 2
        const k11 = k01 + 2
        const px =
          (g[k00] * (1 - tx) + g[k10] * tx) * (1 - ty) + (g[k01] * (1 - tx) + g[k11] * tx) * ty
        const py =
          (g[k00 + 1] * (1 - tx) + g[k10 + 1] * tx) * (1 - ty) +
          (g[k01 + 1] * (1 - tx) + g[k11 + 1] * tx) * ty
        if (sample(entry, lookup, px, py, rgb)) {
          const o = (j * TILE_SIZE + i) * 4
          rgba[o] = rgb[0]
          rgba[o + 1] = rgb[1]
          rgba[o + 2] = rgb[2]
          rgba[o + 3] = 255
          break
        }
      }
    }
  }
  return rgba
}

/** Raw DN of one band at level pixel (x, y), or undefined if not loaded. */
function dn(entry: PlanEntry, lookup: BlockLookup, band: 0 | 1 | 2, x: number, y: number): number | undefined {
  const L = entry.source.levels[entry.level]
  const bx = Math.floor(x / L.blockWidth)
  const by = Math.floor(y / L.blockHeight)
  const block = lookup.get(entry.source, entry.level, bx, by)
  if (!block) return undefined
  return block.bands[band][(y - by * L.blockHeight) * block.width + (x - bx * L.blockWidth)]
}

/**
 * Bilinear sample at continuous level pixel coordinates (pixel k covers
 * [k, k + 1)). If any neighbour is nodata, the nearest pixel is used instead.
 */
function sample(entry: PlanEntry, lookup: BlockLookup, px: number, py: number, out: Uint8Array): boolean {
  const { source } = entry
  const L = source.levels[entry.level]
  if (px < 0 || py < 0 || px >= L.width || py >= L.height) return false
  const fx = px - 0.5
  const fy = py - 0.5
  const x0 = Math.max(0, Math.floor(fx))
  const y0 = Math.max(0, Math.floor(fy))
  const x1 = Math.min(L.width - 1, x0 + 1)
  const y1 = Math.min(L.height - 1, y0 + 1)
  const tx = Math.min(1, Math.max(0, fx - x0))
  const ty = Math.min(1, Math.max(0, fy - y0))
  const values = [0, 0, 0]
  let bilinear = true
  for (let b = 0 as 0 | 1 | 2; b < 3; b = (b + 1) as 0 | 1 | 2) {
    const v00 = dn(entry, lookup, b, x0, y0)
    const v10 = dn(entry, lookup, b, x1, y0)
    const v01 = dn(entry, lookup, b, x0, y1)
    const v11 = dn(entry, lookup, b, x1, y1)
    if (
      v00 === undefined || v10 === undefined || v01 === undefined || v11 === undefined ||
      v00 === source.nodata || v10 === source.nodata || v01 === source.nodata || v11 === source.nodata
    ) {
      bilinear = false
      break
    }
    values[b] = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty
  }
  if (!bilinear) {
    const x = Math.min(L.width - 1, Math.floor(px))
    const y = Math.min(L.height - 1, Math.floor(py))
    for (let b = 0 as 0 | 1 | 2; b < 3; b = (b + 1) as 0 | 1 | 2) {
      const v = dn(entry, lookup, b, x, y)
      if (v === undefined || v === source.nodata) return false
      values[b] = v
    }
  }
  for (let b = 0; b < 3; b++) out[b] = source.lut[lutIndex(Math.round(values[b]), source.signed)]
  return true
}

/**
 * A parent tile from its four children (top-left, top-right, bottom-left,
 * bottom-right; null where a child has no data): each parent pixel is the
 * alpha-weighted mean of 2 × 2 child pixels. Null if all children are null.
 */
export function downsample(kids: (Uint8Array | null)[]): Uint8Array | null {
  if (kids.every((k) => k === null)) return null
  const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4)
  const half = TILE_SIZE / 2
  for (let j = 0; j < TILE_SIZE; j++) {
    for (let i = 0; i < TILE_SIZE; i++) {
      const kid = kids[(j >= half ? 2 : 0) + (i >= half ? 1 : 0)]
      if (!kid) continue
      const cx = (i % half) * 2
      const cy = (j % half) * 2
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const o = ((cy + dy) * TILE_SIZE + cx + dx) * 4
          const w = kid[o + 3]
          r += kid[o] * w
          g += kid[o + 1] * w
          b += kid[o + 2] * w
          a += w
        }
      }
      if (a === 0) continue
      const o = (j * TILE_SIZE + i) * 4
      out[o] = Math.round(r / a)
      out[o + 1] = Math.round(g / a)
      out[o + 2] = Math.round(b / a)
      out[o + 3] = Math.round(a / 4)
    }
  }
  return out
}

export function alphaStats(rgba: Uint8Array): { empty: boolean; opaque: boolean } {
  let any = false
  let all = true
  for (let o = 3; o < rgba.length; o += 4) {
    if (rgba[o] > 0) any = true
    if (rgba[o] < 255) all = false
  }
  return { empty: !any, opaque: all }
}
