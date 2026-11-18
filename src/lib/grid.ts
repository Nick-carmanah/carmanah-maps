import type { Feature, FeatureCollection, Position } from 'geojson'
import type { LngLatBounds } from 'maplibre-gl'
import { fromBcAlbers, inBcAlbersArea, toBcAlbers } from './albers'
import { fromUtm, toUtm, type CoordFormat } from './coords'

/**
 * Grid overlay (the "grid lines" on agency fire maps). 1 km cells at close
 * zooms, 10 km when zoomed out; hidden when the view is too wide.
 * Cell labels use the MGRS-style 4-digit reference (easting km + northing km
 * within the 100 km square), e.g. "1265" — radio-friendly and international.
 *
 * The grid follows the coordinate setting: BC Albers coordinates get a BC
 * Albers grid (inside BC); every other format keeps the UTM grid.
 */

export type GridSystem = 'utm' | 'bcalbers'

export function gridSystemFor(format: CoordFormat): GridSystem {
  return format === 'bcalbers' ? 'bcalbers' : 'utm'
}

interface GridProjection {
  forward(lat: number, lon: number): [number, number] | null
  inverse(easting: number, northing: number): Position
}

function gridProjection(
  system: GridSystem,
  center: { lat: number; lng: number },
): GridProjection | null {
  if (system === 'bcalbers' && inBcAlbersArea([center.lng, center.lat])) {
    return {
      forward: (lat, lon) => {
        const a = toBcAlbers(lat, lon)
        return [a.easting, a.northing]
      },
      inverse: (e, n) => fromBcAlbers(e, n) ?? [NaN, NaN],
    }
  }
  // Work in the center's UTM zone across the whole view.
  const centerUtm = toUtm(center.lat, center.lng)
  if (!centerUtm) return null
  const { zone, band } = centerUtm
  return {
    forward: (lat, lon) => {
      const u = toUtm(lat, lon, zone)
      return u ? [u.easting, u.northing] : null
    },
    inverse: (e, n) => fromUtm({ zone, band, easting: e, northing: n }),
  }
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function gridSpacingM(zoom: number): number | null {
  if (zoom >= 12) return 1000
  if (zoom >= 8.5) return 10000
  return null
}

export function buildGrid(
  bounds: LngLatBounds,
  zoom: number,
  system: GridSystem = 'utm',
): { lines: FeatureCollection; labels: FeatureCollection } {
  const spacing = gridSpacingM(zoom)
  if (!spacing) return { lines: EMPTY, labels: EMPTY }

  const proj = gridProjection(system, bounds.getCenter())
  if (!proj) return { lines: EMPTY, labels: EMPTY }

  const corners = [
    proj.forward(bounds.getSouth(), bounds.getWest()),
    proj.forward(bounds.getSouth(), bounds.getEast()),
    proj.forward(bounds.getNorth(), bounds.getWest()),
    proj.forward(bounds.getNorth(), bounds.getEast()),
  ]
  if (corners.some((c) => !c)) return { lines: EMPTY, labels: EMPTY }
  const eastings = corners.map((c) => c![0])
  const northings = corners.map((c) => c![1])
  const minE = Math.floor(Math.min(...eastings) / spacing) * spacing
  const maxE = Math.ceil(Math.max(...eastings) / spacing) * spacing
  const minN = Math.floor(Math.min(...northings) / spacing) * spacing
  const maxN = Math.ceil(Math.max(...northings) / spacing) * spacing

  const cols = (maxE - minE) / spacing
  const rows = (maxN - minN) / spacing
  if (cols > 60 || rows > 60) return { lines: EMPTY, labels: EMPTY }

  const toLngLat = (e: number, n: number) => proj.inverse(e, n)

  const lines: Feature[] = []
  for (let e = minE; e <= maxE; e += spacing) {
    const coords = []
    for (let n = minN; n <= maxN; n += spacing / 2) coords.push(toLngLat(e, n))
    lines.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    })
  }
  for (let n = minN; n <= maxN; n += spacing) {
    const coords = []
    for (let e = minE; e <= maxE; e += spacing / 2) coords.push(toLngLat(e, n))
    lines.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    })
  }

  const labels: Feature[] = []
  if (cols * rows <= 900) {
    const unit = spacing === 1000 ? 1000 : 10000
    const pad = spacing === 1000 ? 2 : 1
    for (let e = minE; e < maxE; e += spacing) {
      for (let n = minN; n < maxN; n += spacing) {
        const eRef = String(Math.floor(e / unit) % (spacing === 1000 ? 100 : 10)).padStart(pad, '0')
        const nRef = String(Math.floor(n / unit) % (spacing === 1000 ? 100 : 10)).padStart(pad, '0')
        labels.push({
          type: 'Feature',
          properties: { ref: `${eRef}${nRef}` },
          geometry: {
            type: 'Point',
            coordinates: toLngLat(e + spacing / 2, n + spacing / 2),
          },
        })
      }
    }
  }

  return {
    lines: { type: 'FeatureCollection', features: lines },
    labels: { type: 'FeatureCollection', features: labels },
  }
}
