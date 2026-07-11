import type { FeatureCollection, Position } from 'geojson'
import type { LngLatBoundsLike } from 'maplibre-gl'

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Initial great-circle bearing from a to b, degrees true (0–360). */
export function bearingDeg(a: Position, b: Position): number {
  const phi1 = rad(a[1])
  const phi2 = rad(b[1])
  const dLam = rad(b[0] - a[0])
  const y = Math.sin(dLam) * Math.cos(phi2)
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** Simple vertex centroid — good enough for picking a navigation target. */
export function centroidOf(coords: Position[]): Position {
  let sx = 0
  let sy = 0
  for (const [x, y] of coords) {
    sx += x
    sy += y
  }
  return [sx / coords.length, sy / coords.length]
}

/** Compute a bounding box for any GeoJSON FeatureCollection. */
export function boundsOf(fc: FeatureCollection): LngLatBoundsLike | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return
    if (typeof coords[0] === 'number') {
      const [x, y] = coords as Position
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      return
    }
    for (const c of coords) visit(c)
  }

  for (const feature of fc.features) {
    if (feature.geometry && 'coordinates' in feature.geometry) {
      visit(feature.geometry.coordinates)
    }
  }

  if (!isFinite(minX)) return null
  return [
    [minX, minY],
    [maxX, maxY],
  ]
}
