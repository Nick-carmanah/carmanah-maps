import type { Feature, FeatureCollection, Position } from 'geojson'
import { formatCoord } from './coords'
import { pathLengthMeters, ringAreaSqMeters } from './measure'
import { segmentedDurationMs, segmentedLengthM, splitSegments } from './track'
import {
  formatArea,
  formatDistance,
  formatPace,
  formatSpeed,
  getUnitSettings,
} from './units'

/** A map object in My Data: dropped pin, drawn line or area, recorded
 * track, or anything imported (KML/KMZ, GPX, shapefile, CSV). Every feature
 * belongs to one layer (see layers.ts), which owns its schema and default
 * style. Style fields left undefined fall back to the defaults below. */
export interface UserFeature {
  id: string
  kind: 'pin' | 'line' | 'area'
  name: string
  notes: string
  /** Pin colour, or the line/outline colour of a line or area. */
  color: string
  /** Pin: single position. Line/area: vertex list (area ring is unclosed). */
  coordinates: Position | Position[]
  /** Areas only: inner rings (holes, e.g. unburned islands), each unclosed. */
  holes?: Position[][]
  /** Pin symbol: a FIRE_SYMBOLS key, an NWCG key ('nwcg-…'), or an icon
   * imported from a KMZ ('icon-<id>', stored in the icons store).
   * Empty/undefined = plain dot. */
  symbol?: string
  /** Remote icon URL kept from an import (e.g. Avenza's own pin icons) so a
   * re-export shows the same icon there. Never fetched by us. */
  iconHref?: string
  /** Owning layer id (layers.ts). */
  layerId: string
  /** @deprecated Layer *name* from before layers existed. Only the one-time
   * migration (mydata.ts) reads it; it is removed from migrated records. */
  layer?: string
  /** Line/outline width in px (default DEFAULT_LINE_WIDTH). */
  width?: number
  /** Area fill colour (default: the line colour). */
  fill?: string
  /** Area fill opacity 0–1 (default DEFAULT_FILL_OPACITY). */
  fillOpacity?: number
  /** Per-vertex timestamps for recorded tracks (parallel to coordinates). */
  times?: number[]
  /** Lines only: a track that was paused and resumed. Index of the first
   * vertex of each later segment; nothing is drawn or measured across the
   * gap before it (see track.ts). */
  segmentStarts?: number[]
  /** Attribute values, in display order. Values are text; the layer schema
   * (layers.ts) says which are typed fields. Keys not in the schema are
   * per-feature fields. */
  attributes?: { k: string; v: string }[]
  /** Entry/exit alerting. Radius applies to pin and line fences. */
  geofence?: { enabled: boolean; radiusM?: number }
  createdAt: number
  updatedAt: number
}

export const DEFAULT_LINE_WIDTH = 3
export const DEFAULT_FILL_OPACITY = 0.25

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

/** Layer that new features of each kind land in when nothing else applies. */
export const DEFAULT_LAYERS: Record<UserFeature['kind'], string> = {
  pin: 'Placemarks',
  line: 'Lines',
  area: 'Areas',
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
    const coords = f.coordinates as Position[]
    const parts = splitSegments(coords, f.segmentStarts).filter((p) => p.length >= 2)
    return parts.length > 1
      ? { type: 'MultiLineString', coordinates: parts }
      : { type: 'LineString', coordinates: parts[0] ?? coords }
  }
  const close = (ring: Position[]) => [...ring, ring[0]]
  return {
    type: 'Polygon',
    coordinates: [close(f.coordinates as Position[]), ...(f.holes ?? []).map(close)],
  }
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
        width: f.width ?? DEFAULT_LINE_WIDTH,
        fill: f.fill ?? f.color,
        fillOpacity: f.fillOpacity ?? DEFAULT_FILL_OPACITY,
      },
      geometry: featureGeometry(f),
    })),
  }
}

/** "1.24 km" for lines, "515 ha" for areas, coordinates for pins — in the chosen units. */
export function featureStat(f: UserFeature): string {
  if (f.kind === 'pin') return formatCoord(f.coordinates as Position, getUnitSettings().coords)
  const pts = f.coordinates as Position[]
  if (f.kind === 'line') return formatDistance(segmentedLengthM(pts, f.segmentStarts))
  const holes = (f.holes ?? []).reduce((sum, h) => sum + ringAreaSqMeters(h), 0)
  return formatArea(Math.max(0, ringAreaSqMeters(pts) - holes))
}

/** The feature sheet's numbers: featureStat plus perimeter, or a track's time, speed and pace. */
export function featureDetails(f: UserFeature): string[] {
  const out = [featureStat(f)]
  if (f.kind === 'area') {
    const ring = f.coordinates as Position[]
    out.push(`perimeter ${formatDistance(pathLengthMeters([...ring, ring[0]]))}`)
  }
  const times = f.times
  if (f.kind === 'line' && times && times.length >= 2) {
    // Time and distance while recording: pauses (segment gaps) left out.
    const durationMs = segmentedDurationMs(times, f.segmentStarts)
    const meters = segmentedLengthM(f.coordinates as Position[], f.segmentStarts)
    if (durationMs > 0) {
      out.push(`avg ${formatSpeed(meters / (durationMs / 1000))}`)
      const pace = formatPace(durationMs, meters)
      if (pace) out.push(pace)
    }
  }
  const pauses = f.kind === 'line' ? splitSegments(f.coordinates as Position[], f.segmentStarts).length - 1 : 0
  if (pauses > 0) out.push(`paused ${pauses}×`)
  return out
}
