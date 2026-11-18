// The area an offline pack covers: a fire perimeter (or any polygon, or a
// box) plus a buffer, and the map tiles that touch it.
//
// Shared by the app ("Download this fire") and the Mac pack builder
// (scripts/packs/), so both cut exactly the same tiles. No DOM, no Node:
// imports carry their .ts extension so Node runs this file as it is.

import { zxyToTileId } from 'pmtiles'

export type LonLat = [number, number]
/** west, south, east, north */
export type Bbox = [number, number, number, number]

export interface PackArea {
  /** Outer rings of the polygons, lon/lat. Holes (unburned islands) are filled in. */
  rings: LonLat[][]
  /** Metres around the polygons that the pack also covers. */
  bufferM: number
}

const R = 6371008.8
const RAD = Math.PI / 180
const MAX_LAT = 85.0511

// ---------- From GeoJSON ----------

interface GeoLike {
  type: string
  coordinates?: unknown
  geometries?: GeoLike[]
  geometry?: GeoLike | null
  features?: GeoLike[]
}

function closeRing(ring: LonLat[]): LonLat[] {
  const out = ring.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([x, y]) => [x, y] as LonLat)
  if (out.length > 1) {
    const [a, b] = [out[0], out[out.length - 1]]
    if (a[0] === b[0] && a[1] === b[1]) out.pop()
  }
  return out
}

/** Outer rings of every Polygon/MultiPolygon in a GeoJSON object (Feature, FeatureCollection, geometry). */
export function ringsFromGeoJSON(geo: unknown): LonLat[][] {
  const out: LonLat[][] = []
  const visit = (g: GeoLike | null | undefined) => {
    if (!g || typeof g !== 'object') return
    switch (g.type) {
      case 'FeatureCollection':
        g.features?.forEach(visit)
        break
      case 'Feature':
        visit(g.geometry)
        break
      case 'GeometryCollection':
        g.geometries?.forEach(visit)
        break
      case 'Polygon': {
        const outer = (g.coordinates as LonLat[][] | undefined)?.[0]
        if (outer) out.push(closeRing(outer))
        break
      }
      case 'MultiPolygon':
        for (const poly of (g.coordinates as LonLat[][][] | undefined) ?? []) {
          if (poly[0]) out.push(closeRing(poly[0]))
        }
        break
    }
  }
  visit(geo as GeoLike)
  return out.filter((r) => r.length >= 3)
}

export function bboxRing([w, s, e, n]: Bbox): LonLat[] {
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]
}

// ---------- Measuring ----------

/** Area of the rings in hectares (spherical excess; overlapping rings count twice). */
export function ringsHectares(rings: LonLat[][]): number {
  let total = 0
  for (const ring of rings) {
    let sum = 0
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]
      const [x2, y2] = ring[(i + 1) % ring.length]
      sum += (x2 - x1) * RAD * (2 + Math.sin(y1 * RAD) + Math.sin(y2 * RAD))
    }
    total += Math.abs((sum * R * R) / 2)
  }
  return total / 10_000
}

/** Bounding box of the area including its buffer. */
export function areaBbox(area: PackArea): Bbox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const ring of area.rings) {
    for (const [x, y] of ring) {
      w = Math.min(w, x)
      e = Math.max(e, x)
      s = Math.min(s, y)
      n = Math.max(n, y)
    }
  }
  const dLat = area.bufferM / (R * RAD)
  const dLon = dLat / Math.max(0.05, Math.cos(Math.max(Math.abs(s), Math.abs(n)) * RAD))
  return [Math.max(-180, w - dLon), Math.max(-MAX_LAT, s - dLat), Math.min(180, e + dLon), Math.min(MAX_LAT, n + dLat)]
}

// ---------- Tiles ----------

export const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z
export function latToTileY(lat: number, z: number): number {
  const r = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * RAD
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}
export const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z
  return Math.atan(Math.sinh(n)) / RAD
}

/** A zoom level's tiles, as x/y pairs packed into one number (x * 2^z + y). */
export interface ZoomTiles {
  z: number
  keys: number[]
}

/**
 * Tiles at zoom `z` that touch the area (polygon or within `bufferM` of it).
 * Exact for the shapes given: a tile counts if its rectangle overlaps the
 * buffered polygon, measured in a local projection (good to ~1% over a few
 * hundred km).
 */
export function coverZoom(area: PackArea, z: number): ZoomTiles {
  const n = 2 ** z
  const rings = area.rings.filter((r) => r.length >= 3)
  if (!rings.length) return { z, keys: [] }
  const [w, s, e, nn] = areaBbox(area)
  const lat0 = (s + nn) / 2
  const kx = R * RAD * Math.cos(lat0 * RAD)
  const ky = R * RAD
  // Projected coordinates: metres east/north of (0°, 0°) at the area's latitude scale.
  const px = (lon: number) => lon * kx
  const py = (lat: number) => lat * ky
  const buf = area.bufferM

  const x0 = Math.max(0, Math.floor(lonToTileX(w, z)))
  const x1 = Math.min(n - 1, Math.floor(lonToTileX(e, z)))
  const y0 = Math.max(0, Math.floor(latToTileY(nn, z)))
  const y1 = Math.min(n - 1, Math.floor(latToTileY(s, z)))
  const cols = x1 - x0 + 1
  const rows = y1 - y0 + 1
  if (cols <= 0 || rows <= 0) return { z, keys: [] }

  // Tile edges in projected metres.
  const colX = Array.from({ length: cols + 1 }, (_, i) => px(tileXToLon(x0 + i, z)))
  const rowY = Array.from({ length: rows + 1 }, (_, j) => py(tileYToLat(y0 + j, z)))
  const colOf = (x: number) => {
    let lo = 0
    let hi = cols
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (colX[mid] <= x) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const rowOf = (y: number) => {
    // rowY decreases with j (north to south).
    let lo = 0
    let hi = rows
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (rowY[mid] >= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const hit = new Uint8Array(cols * rows)
  const edges: [number, number, number, number][] = []
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      edges.push([px(a[0]), py(a[1]), px(b[0]), py(b[1])])
    }
  }

  // 1. Tiles whose centre is inside a polygon: scanline per row, even-odd per ring.
  for (let j = 0; j < rows; j++) {
    const yc = (rowY[j] + rowY[j + 1]) / 2
    for (const ring of rings) {
      const xs: number[] = []
      for (let i = 0; i < ring.length; i++) {
        const ax = px(ring[i][0])
        const ay = py(ring[i][1])
        const b = ring[(i + 1) % ring.length]
        const bx = px(b[0])
        const by = py(b[1])
        if (ay > yc !== by > yc) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax))
      }
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let i = 0; i < cols; i++) {
          const xc = (colX[i] + colX[i + 1]) / 2
          if (xc >= xs[k] && xc < xs[k + 1]) hit[j * cols + i] = 1
        }
      }
    }
  }

  // 2. Tiles an edge passes through or comes within the buffer of.
  for (const [ax, ay, bx, by] of edges) {
    const ci0 = Math.max(0, colOf(Math.min(ax, bx) - buf))
    const ci1 = Math.min(cols - 1, colOf(Math.max(ax, bx) + buf))
    const rj0 = Math.max(0, rowOf(Math.max(ay, by) + buf))
    const rj1 = Math.min(rows - 1, rowOf(Math.min(ay, by) - buf))
    for (let j = rj0; j <= rj1; j++) {
      for (let i = ci0; i <= ci1; i++) {
        const idx = j * cols + i
        if (hit[idx]) continue
        if (segmentRectDistance(ax, ay, bx, by, colX[i], rowY[j + 1], colX[i + 1], rowY[j]) <= buf) hit[idx] = 1
      }
    }
  }

  const keys: number[] = []
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) if (hit[j * cols + i]) keys.push((x0 + i) * n + (y0 + j))
  }
  return { z, keys }
}

function pointSegmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px))
  return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by)
}

/** Distance from segment AB to the rectangle [minX, maxX] × [minY, maxY] (0 if they touch). */
export function segmentRectDistance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number {
  const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY
  if (inside(ax, ay) || inside(bx, by)) return 0
  const corners: [number, number][] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ]
  for (let k = 0; k < 4; k++) {
    const [cx, cy] = corners[k]
    const [dx, dy] = corners[(k + 1) % 4]
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0
  }
  const clampDist = (x: number, y: number) => Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minY - y, 0, y - maxY))
  return Math.min(clampDist(ax, ay), clampDist(bx, by), ...corners.map(([cx, cy]) => pointSegmentDistance(cx, cy, ax, ay, bx, by)))
}

/** The parents of a zoom level's tiles. Exact: a parent touches the area iff one of its children does. */
export function parentZoom({ z, keys }: ZoomTiles): ZoomTiles {
  const n = 2 ** z
  const pn = n / 2
  const out = new Set<number>()
  for (const k of keys) out.add(Math.floor(Math.floor(k / n) / 2) * pn + Math.floor((k % n) / 2))
  return { z: z - 1, keys: [...out] }
}

/** Every zoom from minZoom to maxZoom: computed at maxZoom, then up to the parents. */
export function coverArea(area: PackArea, minZoom: number, maxZoom: number): ZoomTiles[] {
  const levels: ZoomTiles[] = [coverZoom(area, maxZoom)]
  while (levels[0].z > minZoom) levels.unshift(parentZoom(levels[0]))
  return levels
}

/** Tile ids (PMTiles Hilbert ids), ascending, for some zoom levels. */
export function tileIdsOf(levels: ZoomTiles[], minZoom = 0, maxZoom = 30): number[] {
  const ids: number[] = []
  for (const { z, keys } of levels) {
    if (z < minZoom || z > maxZoom) continue
    const n = 2 ** z
    for (const k of keys) ids.push(zxyToTileId(z, Math.floor(k / n), k % n))
  }
  return ids.sort((a, b) => a - b)
}

/** Tiles per zoom, for counts and size estimates. */
export function countTiles(levels: ZoomTiles[], minZoom = 0, maxZoom = 30): number {
  return levels.reduce((sum, l) => sum + (l.z >= minZoom && l.z <= maxZoom ? l.keys.length : 0), 0)
}

// ---------- Simplifying ----------

/**
 * Douglas–Peucker in metres. Big BCWS perimeters carry tens of thousands of
 * points; the tile cover doesn't need detail finer than a fraction of a tile.
 */
export function simplifyRing(ring: LonLat[], toleranceM: number): LonLat[] {
  if (ring.length <= 8 || toleranceM <= 0) return ring
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length
  const kx = R * RAD * Math.cos(lat0 * RAD)
  const ky = R * RAD
  const pts = ring.map(([x, y]) => [x * kx, y * ky] as [number, number])
  const keep = new Uint8Array(ring.length)
  keep[0] = 1
  keep[ring.length - 1] = 1
  const stack: [number, number][] = [[0, ring.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let worst = -1
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const d = pointSegmentDistance(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1])
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (worst > toleranceM) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  const out = ring.filter((_, i) => keep[i])
  return out.length >= 3 ? out : ring
}

/** Simplify an area for tiling: detail under 1/8 of a max-zoom tile can't change the cover much. */
export function simplifyArea(area: PackArea, maxZoom: number): PackArea {
  const tileM = (2 * Math.PI * R) / 2 ** maxZoom
  const lat = area.rings[0]?.[0]?.[1] ?? 50
  const tolerance = (tileM * Math.cos(lat * RAD)) / 8
  return { ...area, rings: area.rings.map((r) => simplifyRing(r, tolerance)) }
}
