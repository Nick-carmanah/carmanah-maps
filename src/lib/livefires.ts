import type { FeatureCollection } from 'geojson'

// BC Wildfire Service public feature services (CORS-enabled, no key needed).
const BASE = 'https://services6.arcgis.com/ubm4tcTYICKBpist/ArcGIS/rest/services'

export interface LiveFires {
  fetchedAt: number
  points: FeatureCollection
  perimeters: FeatureCollection
}

async function queryLayer(service: string): Promise<FeatureCollection> {
  const params = new URLSearchParams({
    where: "FIRE_STATUS <> 'Out'",
    outFields: '*',
    outSR: '4326',
    geometryPrecision: '5',
    f: 'geojson',
  })
  const res = await fetch(`${BASE}/${service}/FeatureServer/0/query?${params}`)
  if (!res.ok) {
    throw new Error(`BC Wildfire Service returned HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchLiveFires(): Promise<LiveFires> {
  const [points, perimeters] = await Promise.all([
    queryLayer('BCWS_ActiveFires_PublicView'),
    queryLayer('BCWS_FirePerimeters_PublicView'),
  ])
  return { fetchedAt: Date.now(), points, perimeters }
}

/** "Out of Control" → red, etc. Mirrors BCWS map conventions. */
export const STATUS_COLORS: Record<string, string> = {
  'Out of Control': '#ef4444',
  'Being Held': '#f97316',
  'Under Control': '#22c55e',
  New: '#a855f7',
}

export const STATUS_FALLBACK_COLOR = '#eab308'

export function formatAge(fetchedAt: number): string {
  const mins = Math.round((Date.now() - fetchedAt) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}
