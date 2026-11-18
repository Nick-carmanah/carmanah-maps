import type { Position } from 'geojson'
import type { Corners } from './types'

/**
 * "You are here" and distances on the My Maps screen, as in Avenza: a map
 * whose frame contains the GPS position gets a marker, the others show how
 * far away they are, and the list can be sorted nearest first.
 *
 * Maths on a local flat projection centred on the position (metres east and
 * north). That's exact enough for "inside or not" (the frame is a few km
 * across) and for ranking maps by distance; the label rounds anyway.
 */

const EARTH_RADIUS_M = 6371008.8
const RAD = Math.PI / 180

type Xy = [number, number]

function localXy(origin: Position, p: Position): Xy {
  const k = EARTH_RADIUS_M * RAD
  return [(p[0] - origin[0]) * k * Math.cos(origin[1] * RAD), (p[1] - origin[1]) * k]
}

/** Distance from the origin (0, 0) to segment a–b. */
function distanceToSegment(a: Xy, b: Xy): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(a[0] * dx + a[1] * dy) / len2)) : 0
  return Math.hypot(a[0] + t * dx, a[1] + t * dy)
}

/** True when the position is inside the map's frame (edges count as inside). */
export function containsPoint(corners: Corners, position: Position): boolean {
  const ring = corners.map((c) => localXy(position, c))
  // Crossing number for the origin against the four edges.
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (distanceToSegment(ring[i], ring[j]) < 1e-6) return true
    if (yi > 0 !== yj > 0 && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Metres from the position to the nearest edge of the map's frame; 0 inside it. */
export function distanceToMapM(corners: Corners, position: Position): number {
  if (containsPoint(corners, position)) return 0
  const ring = corners.map((c) => localXy(position, c))
  let best = Infinity
  for (let i = 0; i < ring.length; i++) best = Math.min(best, distanceToSegment(ring[i], ring[(i + 1) % ring.length]))
  return best
}

export interface MapDistance {
  /** Metres to the frame's nearest edge; 0 when inside. */
  metres: number
  inside: boolean
}

/** Distance to every map, by id. Empty without a position. */
export function mapDistances(
  maps: readonly { id: string; corners: Corners }[],
  position: Position | null,
): Map<string, MapDistance> {
  const out = new Map<string, MapDistance>()
  if (!position) return out
  for (const m of maps) {
    const metres = distanceToMapM(m.corners, position)
    out.set(m.id, { metres, inside: metres === 0 })
  }
  return out
}

/**
 * Nearest first: maps you're on, then by distance. Ties (and maps with no
 * distance) keep their order, so without a position the list is unchanged.
 */
export function sortByDistance<T extends { id: string }>(maps: readonly T[], distances: Map<string, MapDistance>): T[] {
  const d = (m: T) => distances.get(m.id)?.metres ?? Infinity
  return maps
    .map((m, i) => ({ m, i }))
    .sort((a, b) => d(a.m) - d(b.m) || a.i - b.i)
    .map(({ m }) => m)
}

/**
 * "41.28 km" → "41 km", "3.46 km" → "3.5 km": a list only needs a rough
 * distance. Takes a formatted distance (any unit) and rounds its number.
 */
export function roughDistance(formatted: string): string {
  return formatted.replace(/^(\d+(?:\.\d+)?)/, (n) => {
    const v = Number(n)
    return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  })
}
