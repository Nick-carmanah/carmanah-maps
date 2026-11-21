import type { Position } from 'geojson'
import { distanceM, metresPerDegree } from '../geodesic'
import type { Corners } from './types'

/**
 * "You are here" and distances on the My Maps screen, as in Avenza: a map
 * whose frame contains the GPS position gets a marker, the others show how
 * far away they are, and the list can be sorted nearest first.
 *
 * "Inside or not" and the nearest point of the frame come from a local flat
 * projection centred on the position (metres east and north, true at its
 * latitude on WGS84): exact enough, the frame is a few km across. The
 * distance to that nearest point is then the geodesic one (geodesic.ts), so
 * it matches the measure tool.
 */

type Xy = [number, number]

function localScale(origin: Position): Xy {
  const { east, north } = metresPerDegree(origin[1])
  return [east, north]
}

function localXy(origin: Position, p: Position, [kx, ky] = localScale(origin)): Xy {
  return [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky]
}

/** Point on segment a–b nearest the origin (0, 0). */
function nearestOnSegment(a: Xy, b: Xy): Xy {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 > 0 ? Math.min(1, Math.max(0, -(a[0] * dx + a[1] * dy) / len2)) : 0
  return [a[0] + t * dx, a[1] + t * dy]
}

/** Distance from the origin (0, 0) to segment a–b. */
function distanceToSegment(a: Xy, b: Xy): number {
  return Math.hypot(...nearestOnSegment(a, b))
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

/** Metres from the position to the nearest edge of the map's frame (geodesic); 0 inside it. */
export function distanceToMapM(corners: Corners, position: Position): number {
  if (containsPoint(corners, position)) return 0
  const k = localScale(position)
  const ring = corners.map((c) => localXy(position, c, k))
  let best: Xy | null = null
  for (let i = 0; i < ring.length; i++) {
    const p = nearestOnSegment(ring[i], ring[(i + 1) % ring.length])
    if (!best || Math.hypot(...p) < Math.hypot(...best)) best = p
  }
  if (!best) return Infinity
  return distanceM(position, [position[0] + best[0] / k[0], position[1] + best[1] / k[1]])
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
