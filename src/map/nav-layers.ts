import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, Position } from 'geojson'
import { circlePolygon } from '../lib/fences'

/**
 * What navigation draws on the map besides MapView's "you → target" line:
 * the route's waypoints (numbered) and legs, the arrival ring round the
 * current waypoint, and the preview of a projected point. One GeoJSON
 * source, added on top of everything the first time it's needed (like the
 * GPS average sheet's), so it shows on the base map and on a custom map
 * viewed on its own alike.
 */

const SOURCE = 'nav-extra'
const LAYERS = ['nav-extra-ring', 'nav-extra-legs', 'nav-extra-proj', 'nav-extra-pts', 'nav-extra-num', 'nav-extra-you'] as const

export type WaypointState = 'done' | 'current' | 'next'

export interface NavDrawing {
  /** Route or plan waypoints, in order. */
  waypoints?: { position: Position; state: WaypointState; label: string }[]
  /** Draw legs between the waypoints (dashed). */
  legs?: boolean
  /** Arrival ring. */
  ring?: { center: Position; radiusM: number } | null
  /** Projection preview: origin → point. */
  projection?: { from: Position; to: Position } | null
  /** Where you are, while navigating (under MapLibre's dot when that's on). */
  you?: Position | null
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function navDrawingData(d: NavDrawing): FeatureCollection {
  const features: Feature[] = []
  const wps = d.waypoints ?? []
  if (d.legs && wps.length >= 2) {
    for (let i = 1; i < wps.length; i++) {
      features.push({
        type: 'Feature',
        properties: { kind: 'leg', state: wps[i].state === 'done' ? 'done' : wps[i].state === 'current' ? 'current' : 'next' },
        geometry: { type: 'LineString', coordinates: [wps[i - 1].position, wps[i].position] },
      })
    }
  }
  wps.forEach((w, i) => {
    features.push({
      type: 'Feature',
      properties: { kind: 'wp', state: w.state, label: w.label, order: i },
      geometry: { type: 'Point', coordinates: w.position },
    })
  })
  if (d.ring) {
    features.push({
      type: 'Feature',
      properties: { kind: 'ring' },
      geometry: { type: 'LineString', coordinates: circlePolygon(d.ring.center, d.ring.radiusM, 64) },
    })
  }
  if (d.projection) {
    features.push(
      {
        type: 'Feature',
        properties: { kind: 'proj' },
        geometry: { type: 'LineString', coordinates: [d.projection.from, d.projection.to] },
      },
      {
        type: 'Feature',
        properties: { kind: 'wp', state: 'project', label: '' },
        geometry: { type: 'Point', coordinates: d.projection.to },
      },
    )
  }
  if (d.you) {
    features.push({ type: 'Feature', properties: { kind: 'you' }, geometry: { type: 'Point', coordinates: d.you } })
  }
  return { type: 'FeatureCollection', features }
}

const STATE_COLOR = [
  'match',
  ['get', 'state'],
  'done',
  '#9ca3af',
  'current',
  '#4ade80',
  'project',
  '#f97316',
  '#facc15',
] as unknown as ExpressionSpecification

/** Draw (or clear, with null) navigation's extras. False while the style is still loading. */
export function drawNav(map: MlMap, drawing: NavDrawing | null): boolean {
  const data = drawing ? navDrawingData(drawing) : EMPTY
  try {
    const source = map.getSource(SOURCE) as GeoJSONSource | undefined
    if (source) {
      source.setData(data)
      return true
    }
    if (!drawing) return true
    map.addSource(SOURCE, { type: 'geojson', data })
    map.addLayer({
      id: LAYERS[0],
      type: 'line',
      source: SOURCE,
      filter: ['==', ['get', 'kind'], 'ring'],
      paint: { 'line-color': '#4ade80', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8 },
    })
    map.addLayer({
      id: LAYERS[1],
      type: 'line',
      source: SOURCE,
      filter: ['==', ['get', 'kind'], 'leg'],
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': STATE_COLOR,
        'line-width': ['match', ['get', 'state'], 'done', 2, 3],
        'line-dasharray': [2, 1.5],
        'line-opacity': ['match', ['get', 'state'], 'done', 0.6, 0.95],
      },
    })
    map.addLayer({
      id: LAYERS[2],
      type: 'line',
      source: SOURCE,
      filter: ['==', ['get', 'kind'], 'proj'],
      paint: { 'line-color': '#f97316', 'line-width': 3, 'line-dasharray': [1.5, 1] },
    })
    map.addLayer({
      id: LAYERS[3],
      type: 'circle',
      source: SOURCE,
      filter: ['==', ['get', 'kind'], 'wp'],
      paint: {
        'circle-radius': ['match', ['get', 'state'], 'current', 12, 10],
        'circle-color': STATE_COLOR,
        'circle-stroke-color': '#111827',
        'circle-stroke-width': 2,
        'circle-opacity': ['match', ['get', 'state'], 'done', 0.7, 1],
      },
    })
    map.addLayer({
      id: LAYERS[4],
      type: 'symbol',
      source: SOURCE,
      filter: ['all', ['==', ['get', 'kind'], 'wp'], ['!=', ['get', 'label'], '']],
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#111827' },
    })
    map.addLayer({
      id: LAYERS[5],
      type: 'circle',
      source: SOURCE,
      filter: ['==', ['get', 'kind'], 'you'],
      paint: {
        'circle-radius': 7,
        'circle-color': '#1da1f2',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    })
    return true
  } catch {
    return false
  }
}

/** Take the layers off (the map is going, or nothing to show). */
export function removeNav(map: MlMap): void {
  try {
    for (const id of [...LAYERS].reverse()) if (map.getLayer(id)) map.removeLayer(id)
    if (map.getSource(SOURCE)) map.removeSource(SOURCE)
  } catch {
    // Map already gone.
  }
}
