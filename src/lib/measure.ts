import type { Position } from 'geojson'
import { distanceM, lengthM, ringAreaM2 } from './geodesic'

// Lengths and areas as GIS reports them: geodesics on the WGS84 ellipsoid
// (geodesic.ts, Karney's algorithm; ArcGIS "geodesic", QGIS, PostGIS). Areas
// agree with BC Albers (EPSG:3005). Until 2026-11 this was a 6,371,008.8 m
// sphere, which read ~0.3% short east–west and ~0.35% small in area at BC
// latitudes.

/** Shortest distance between two [lng, lat] positions on the ellipsoid, in metres. */
export function distanceMeters(a: Position, b: Position): number {
  return distanceM(a, b)
}

/**
 * The same as distanceMeters. The old name, kept so existing callers
 * (navigation, tracks, geofences) don't change; it is no longer haversine.
 */
export const haversineMeters = distanceMeters

/** Total length of a [lng, lat] path, in metres. */
export function pathLengthMeters(coords: Position[]): number {
  return lengthM(coords)
}

/**
 * Area of the polygon formed by the given ring (closed implicitly, either
 * direction), in square metres: geodesic edges on the ellipsoid.
 */
export function ringAreaSqMeters(coords: Position[]): number {
  return ringAreaM2(coords)
}

// Display formatting lives in units.ts (one choice per metric). Re-exported
// here so existing imports keep working.
export { formatArea, formatDistance } from './units'
