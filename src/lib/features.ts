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
  createdAt: number
  updatedAt: number
}

export const FEATURE_COLORS = [
  '#e11d1d', // red
  '#f97316', // orange
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
      properties: { id: f.id, kind: f.kind, name: f.name, notes: f.notes, color: f.color },
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
