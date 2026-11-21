import type { Feature, FeatureCollection, Position } from 'geojson'
import { destination, metresPerDegree } from './geodesic'
import { haversineMeters } from './measure'
import type { UserFeature } from './features'
import { splitSegments } from './track'

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

/** Distance in meters from point to a polyline (local flat frame, true at the point's latitude on WGS84). */
export function distToPolylineM(point: Position, line: Position[]): number {
  const { east: mPerDegLng, north: mPerDegLat } = metresPerDegree(point[1])
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
    // A paused track's gaps are not part of the line.
    return splitSegments(feature.coordinates as Position[], feature.segmentStarts).some(
      (seg) => distToPolylineM(position, seg) <= radius,
    )
  }
  return (
    pointInRing(position, feature.coordinates as Position[]) &&
    !(feature.holes ?? []).some((h) => pointInRing(position, h))
  )
}

/** Circle polygon (for drawing pin fences on the map): every vertex exactly radiusM from the centre. */
export function circlePolygon(center: Position, radiusM: number, steps = 48): Position[] {
  const ring: Position[] = []
  // From east, anticlockwise, closed (the last vertex repeats the first).
  for (let i = 0; i <= steps; i++) ring.push(destination(center, 90 - (360 * (i % steps)) / steps, radiusM))
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
        geometry: {
          type: 'MultiLineString',
          coordinates: splitSegments(f.coordinates as Position[], f.segmentStarts),
        },
      })
    }
  }
  return { type: 'FeatureCollection', features: shapes }
}
