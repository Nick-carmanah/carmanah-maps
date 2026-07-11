import type { Feature, FeatureCollection, Position } from 'geojson'
import { haversineMeters } from './measure'
import type { UserFeature } from './features'

export const DEFAULT_FENCE_RADIUS_M = 500

/** Ray-casting point-in-polygon (ring unclosed, as stored on UserFeature). */
export function pointInRing(point: Position, ring: Position[]): boolean {
  let inside = false
  const [x, y] = point
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Distance in meters from point to a polyline (local flat-earth approx). */
export function distToPolylineM(point: Position, line: Position[]): number {
  const mPerDegLat = 111320
  const mPerDegLng = mPerDegLat * Math.cos((point[1] * Math.PI) / 180)
  const toXY = ([lng, lat]: Position) => [
    (lng - point[0]) * mPerDegLng,
    (lat - point[1]) * mPerDegLat,
  ]
  let best = Infinity
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = toXY(line[i - 1])
    const [bx, by] = toXY(line[i])
    const abx = bx - ax
    const aby = by - ay
    const lenSq = abx * abx + aby * aby
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (-ax * abx - ay * aby) / lenSq))
    const dx = ax + t * abx
    const dy = ay + t * aby
    best = Math.min(best, Math.hypot(dx, dy))
  }
  return best
}

/** Is the position inside this feature's geofence? */
export function insideFence(position: Position, feature: UserFeature): boolean {
  const radius = feature.geofence?.radiusM ?? DEFAULT_FENCE_RADIUS_M
  if (feature.kind === 'pin') {
    return haversineMeters(position, feature.coordinates as Position) <= radius
  }
  if (feature.kind === 'line') {
    return distToPolylineM(position, feature.coordinates as Position[]) <= radius
  }
  return pointInRing(position, feature.coordinates as Position[])
}

/** Circle polygon (for drawing pin fences on the map). */
export function circlePolygon(center: Position, radiusM: number, steps = 48): Position[] {
  const mPerDegLat = 111320
  const mPerDegLng = mPerDegLat * Math.cos((center[1] * Math.PI) / 180)
  const ring: Position[] = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2
    ring.push([
      center[0] + (Math.cos(a) * radiusM) / mPerDegLng,
      center[1] + (Math.sin(a) * radiusM) / mPerDegLat,
    ])
  }
  return ring
}

/** Dashed outlines for every armed fence, for the map. */
export function fenceShapes(features: UserFeature[]): FeatureCollection {
  const shapes: Feature[] = []
  for (const f of features) {
    if (!f.geofence?.enabled) continue
    const radius = f.geofence.radiusM ?? DEFAULT_FENCE_RADIUS_M
    if (f.kind === 'pin') {
      shapes.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: circlePolygon(f.coordinates as Position, radius),
        },
      })
    } else if (f.kind === 'area') {
      const ring = f.coordinates as Position[]
      shapes.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [...ring, ring[0]] },
      })
    } else {
      shapes.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: f.coordinates as Position[] },
      })
    }
  }
  return { type: 'FeatureCollection', features: shapes }
}
