import type { Feature, FeatureCollection, Position } from 'geojson'
import { formatArea, formatDistance, pathLengthMeters, ringAreaSqMeters } from './measure'

/** A user-created map object: dropped pin, drawn line, or drawn area. */
export interface UserFeature {
  id: string
  kind: 'pin' | 'line' | 'area'
  name: string
  notes: string
  color: string
  /** Pin: single position. Line/area: vertex list (area ring is unclosed). */
  coordinates: Position | Position[]
  /** Fire-ops symbol key (pins only); empty/undefined = plain dot. */
  symbol?: string
  /** Display layer, e.g. "Danger trees" — the unit of sharing/visibility. */
  layer?: string
  /** Per-vertex timestamps for recorded tracks (parallel to coordinates). */
  times?: number[]
  /** Custom attribute fields, in display order. */
  attributes?: { k: string; v: string }[]
  /** Entry/exit alerting. Radius applies to pin and line fences. */
  geofence?: { enabled: boolean; radiusM?: number }
  createdAt: number
  updatedAt: number
}

/** Built-in fire-ops symbol set (Avenza Pro makes you import these). */
export const FIRE_SYMBOLS: Record<
  string,
  {
    label: string
    color: string
    text: string
    shape: 'circle' | 'triangle' | 'square'
    layer: string
  }
> = {
  'drop-point': { label: 'Drop point', color: '#111827', text: 'DP', shape: 'circle', layer: 'Operations' },
  helispot: { label: 'Helispot', color: '#1d4ed8', text: 'H', shape: 'circle', layer: 'Operations' },
  'safety-zone': { label: 'Safety zone', color: '#15803d', text: 'SZ', shape: 'circle', layer: 'Safety' },
  staging: { label: 'Staging', color: '#7c3aed', text: 'S', shape: 'circle', layer: 'Operations' },
  water: { label: 'Water source', color: '#0369a1', text: 'W', shape: 'circle', layer: 'Water & pumps' },
  pump: { label: 'Pump', color: '#0284c7', text: 'P', shape: 'square', layer: 'Water & pumps' },
  medical: { label: 'Medical', color: '#b91c1c', text: '+', shape: 'circle', layer: 'Safety' },
  hazard: { label: 'Hazard', color: '#ca8a04', text: '!', shape: 'triangle', layer: 'Hazards' },
  'danger-tree': { label: 'Danger tree', color: '#b45309', text: 'DT', shape: 'triangle', layer: 'Danger trees' },
  hotspot: { label: 'Hotspot', color: '#ea580c', text: 'HS', shape: 'circle', layer: 'Hotspots' },
  structure: { label: 'Structure', color: '#475569', text: 'ST', shape: 'square', layer: 'Values at risk' },
  beehive: { label: 'Beehive', color: '#a16207', text: 'BH', shape: 'square', layer: 'Values at risk' },
  camp: { label: 'Camp', color: '#78350f', text: 'C', shape: 'circle', layer: 'Operations' },
}

export const DEFAULT_LAYERS: Record<UserFeature['kind'], string> = {
  pin: 'Placemarks',
  line: 'Lines',
  area: 'Areas',
}

export function featureLayer(f: UserFeature): string {
  return f.layer || DEFAULT_LAYERS[f.kind]
}

/** Rasterize a symbol for maplibre addImage (drawn at 2x for retina). */
export function renderSymbolImage(key: string): ImageData {
  const spec = FIRE_SYMBOLS[key]
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.lineWidth = 3
  ctx.strokeStyle = '#ffffff'
  ctx.fillStyle = spec.color
  if (spec.shape === 'triangle') {
    ctx.beginPath()
    ctx.moveTo(size / 2, 4)
    ctx.lineTo(size - 4, size - 6)
    ctx.lineTo(4, size - 6)
    ctx.closePath()
  } else if (spec.shape === 'square') {
    ctx.beginPath()
    ctx.roundRect(5, 5, size - 10, size - 10, 6)
  } else {
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${spec.text.length > 1 ? 18 : 24}px -apple-system, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(spec.text, size / 2, spec.shape === 'triangle' ? size * 0.62 : size / 2 + 1)
  return ctx.getImageData(0, 0, size, size)
}

export const FEATURE_COLORS = [
  '#e11d1d', // red — fire edge
  '#111111', // black — machine guard
  '#f97316', // orange — general track
  '#facc15', // yellow
  '#22c55e', // green
  '#3b82f6', // blue
  '#a855f7', // purple
  '#ffffff', // white
]

export const KIND_ICONS: Record<UserFeature['kind'], string> = {
  pin: '📍',
  line: '─',
  area: '▰',
}

export function featureGeometry(f: UserFeature): Feature['geometry'] {
  if (f.kind === 'pin') {
    return { type: 'Point', coordinates: f.coordinates as Position }
  }
  if (f.kind === 'line') {
    return { type: 'LineString', coordinates: f.coordinates as Position[] }
  }
  const ring = f.coordinates as Position[]
  return { type: 'Polygon', coordinates: [[...ring, ring[0]]] }
}

export function featuresToGeoJSON(features: UserFeature[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      properties: {
        id: f.id,
        kind: f.kind,
        name: f.name,
        notes: f.notes,
        color: f.color,
        symbol: f.symbol ?? '',
      },
      geometry: featureGeometry(f),
    })),
  }
}

/** "1.24 km" for lines, "515 ha" for areas, coordinates for pins. */
export function featureStat(f: UserFeature): string {
  if (f.kind === 'pin') {
    const [lng, lat] = f.coordinates as Position
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
  }
  const pts = f.coordinates as Position[]
  return f.kind === 'line'
    ? formatDistance(pathLengthMeters(pts))
    : formatArea(ringAreaSqMeters(pts))
}
