import type { Feature, FeatureCollection } from 'geojson'
import type { LngLatBounds } from 'maplibre-gl'
import { fromUtm, toUtm } from './coords'

/**
 * UTM grid overlay (the "grid lines" on agency fire maps). 1 km cells at
 * close zooms, 10 km when zoomed out; hidden when the view is too wide.
 * Cell labels use the MGRS-style 4-digit reference (easting km + northing km
 * within the 100 km square), e.g. "1265" — radio-friendly and international.
 */

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function gridSpacingM(zoom: number): number | null {
  if (zoom >= 12) return 1000
  if (zoom >= 8.5) return 10000
  return null
}

export function buildGrid(
  bounds: LngLatBounds,
  zoom: number,
): { lines: FeatureCollection; labels: FeatureCollection } {
  const spacing = gridSpacingM(zoom)
  if (!spacing) return { lines: EMPTY, labels: EMPTY }

  const center = bounds.getCenter()
  const centerUtm = toUtm(center.lat, center.lng)
  if (!centerUtm) return { lines: EMPTY, labels: EMPTY }
  const zone = centerUtm.zone

  // Work in the center's UTM zone across the whole view.
  const corners = [
    toUtm(bounds.getSouth(), bounds.getWest(), zone),
    toUtm(bounds.getSouth(), bounds.getEast(), zone),
    toUtm(bounds.getNorth(), bounds.getWest(), zone),
    toUtm(bounds.getNorth(), bounds.getEast(), zone),
  ]
  if (corners.some((c) => !c)) return { lines: EMPTY, labels: EMPTY }
  const eastings = corners.map((c) => c!.easting)
  const northings = corners.map((c) => c!.northing)
  const minE = Math.floor(Math.min(...eastings) / spacing) * spacing
  const maxE = Math.ceil(Math.max(...eastings) / spacing) * spacing
  const minN = Math.floor(Math.min(...northings) / spacing) * spacing
  const maxN = Math.ceil(Math.max(...northings) / spacing) * spacing

  const cols = (maxE - minE) / spacing
  const rows = (maxN - minN) / spacing
  if (cols > 60 || rows > 60) return { lines: EMPTY, labels: EMPTY }

  const toLngLat = (e: number, n: number) =>
    fromUtm({ zone, band: centerUtm.band, easting: e, northing: n })

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
