import type { FeatureCollection, Position } from 'geojson'
import type { LngLatBoundsLike } from 'maplibre-gl'

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
