import type { Position } from 'geojson'

const EARTH_RADIUS_M = 6371008.8

const rad = (deg: number) => (deg * Math.PI) / 180

/** Great-circle distance between two [lng, lat] positions, in meters. */
export function haversineMeters(a: Position, b: Position): number {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}

/** Total length of a [lng, lat] path, in meters. */
export function pathLengthMeters(coords: Position[]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1], coords[i])
  }
  return total
}

/**
 * Spherical area of the polygon formed by the given ring (closed implicitly),
 * in square meters. Same approach as turf/area (Chamberlain & Duquette).
 */
export function ringAreaSqMeters(coords: Position[]): number {
  if (coords.length < 3) return 0
  let sum = 0
  for (let i = 0; i < coords.length; i++) {
    const p1 = coords[i]
    const p2 = coords[(i + 1) % coords.length]
    sum += (rad(p2[0]) - rad(p1[0])) * (2 + Math.sin(rad(p1[1])) + Math.sin(rad(p2[1])))
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2)
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`
}

/** Hectares are the working unit for fire sizes. */
export function formatArea(sqMeters: number): string {
  const ha = sqMeters / 10000
  if (ha >= 100) return `${Math.round(ha)} ha`
  if (ha >= 1) return `${ha.toFixed(1)} ha`
  return `${Math.round(sqMeters)} m²`
}
