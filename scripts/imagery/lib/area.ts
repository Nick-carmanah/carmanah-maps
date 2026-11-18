// Which tiles cover an area: a polygon (lon/lat rings) plus a margin in km,
// so fires on the border and coastal islands are covered too.

import { children, tileBounds, type TileId } from './tiles.ts'

export interface Area {
  name: string
  /** Each polygon is a list of rings; only outer rings matter here. */
  rings: [number, number][][]
  marginKm: number
  /** [west, south, east, north] of the rings, without the margin. */
  bbox: [number, number, number, number]
}

const KM_PER_DEG_LAT = 110.574
const KM_PER_DEG_LON_EQ = 111.32

export function areaFromRings(name: string, rings: [number, number][][], marginKm: number): Area {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      w = Math.min(w, lon)
      e = Math.max(e, lon)
      s = Math.min(s, lat)
      n = Math.max(n, lat)
    }
  }
  return { name, rings, marginKm, bbox: [w, s, e, n] }
}

/** A plain rectangle, e.g. a test area. */
export function areaFromBbox(name: string, [w, s, e, n]: [number, number, number, number]): Area {
  return areaFromRings(name, [[[w, s], [e, s], [e, n], [w, n], [w, s]]], 0)
}

/** Even-odd rule over all rings (outer rings of separate islands). */
export function insideRings(lon: number, lat: number, rings: [number, number][][]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/** Shortest distance in km from a point to any ring edge (local flat projection). */
export function distanceToRingsKm(lon: number, lat: number, rings: [number, number][][]): number {
  const kx = KM_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180)
  const ky = KM_PER_DEG_LAT
  let best = Infinity
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * kx
      const ay = (ring[i - 1][1] - lat) * ky
      const bx = (ring[i][0] - lon) * kx
      const by = (ring[i][1] - lat) * ky
      const dx = bx - ax
      const dy = by - ay
      const len2 = dx * dx + dy * dy
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
      const px = ax + t * dx
      const py = ay + t * dy
      best = Math.min(best, Math.sqrt(px * px + py * py))
    }
  }
  return best
}

/**
 * Does a tile touch the area (or come within its margin)? Conservative: a
 * tile whose centre is within half its diagonal plus the margin of the
 * outline counts, so a few corner tiles more than needed may be included.
 */
export function tileTouchesArea(tile: TileId, area: Area): boolean {
  return bboxTouchesArea(tileBounds(tile), area)
}

/** Same test for any [west, south, east, north] box (e.g. a STAC item). */
export function bboxTouchesArea([w, s, e, n]: [number, number, number, number], area: Area): boolean {
  const marginDegLat = area.marginKm / KM_PER_DEG_LAT
  const marginDegLon = area.marginKm / (KM_PER_DEG_LON_EQ * Math.cos((Math.max(Math.abs(s), Math.abs(n)) * Math.PI) / 180))
  const [aw, as, ae, an] = area.bbox
  if (e < aw - marginDegLon || w > ae + marginDegLon || n < as - marginDegLat || s > an + marginDegLat) return false
  const lon = (w + e) / 2
  const lat = (s + n) / 2
  if (insideRings(lon, lat, area.rings)) return true
  const kx = KM_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180)
  const halfDiagKm = Math.hypot(((e - w) / 2) * kx, ((n - s) / 2) * KM_PER_DEG_LAT)
  return distanceToRingsKm(lon, lat, area.rings) <= halfDiagKm + area.marginKm
}

/** Count the tiles at each zoom from 0 to maxZoom that touch the area. */
export function countTiles(area: Area, maxZoom: number): number[] {
  const counts = new Array<number>(maxZoom + 1).fill(0)
  const walk = (tile: TileId) => {
    if (!tileTouchesArea(tile, area)) return
    counts[tile.z]++
    if (tile.z < maxZoom) for (const child of children(tile)) walk(child)
  }
  walk({ z: 0, x: 0, y: 0 })
  return counts
}
