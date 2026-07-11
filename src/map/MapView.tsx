import { useEffect, useRef } from 'react'
import maplibregl, { Map as MlMap, Popup } from 'maplibre-gl'
import type { Overlay } from '../lib/store'
import { boundsOf } from '../lib/geo'

// Free, cache-friendly sources: OSM raster basemap + AWS open elevation tiles
// (terrarium encoding) for 3D terrain and hillshade.
const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© OpenStreetMap contributors',
    },
    terrain: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Terrain: Mapzen/AWS Open Data',
    },
  },
  layers: [
    { id: 'osm', type: 'raster', source: 'osm' },
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'terrain',
      paint: { 'hillshade-exaggeration': 0.35 },
    },
  ],
}

const DEFAULT_STROKE = '#e11d1d'
const DEFAULT_FILL = '#e11d1d'

interface MapViewProps {
  overlays: Overlay[]
  hiddenIds: Set<string>
  /** Overlay id the map should fly to (changes trigger a fit). */
  focusRequest: { id: string; nonce: number } | null
}

export default function MapView({ overlays, hiddenIds, focusRequest }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const loadedRef = useRef(false)
  const overlaysRef = useRef<Overlay[]>(overlays)
  overlaysRef.current = overlays

  useEffect(() => {
    if (!containerRef.current) return
    const map = new MlMap({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [-123.37, 48.43], // Victoria, BC — replaced by geolocation when granted
      zoom: 6,
      maxPitch: 70,
      attributionControl: { compact: true },
    })
    mapRef.current = map
    // Dev console access (harmless in prod, handy for debugging in the field too)
    ;(window as unknown as Record<string, unknown>).__map = map
    map.on('error', (e) => console.error('[map error]', e.error?.message ?? e))

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
    map.addControl(
      new maplibregl.TerrainControl({ source: 'terrain', exaggeration: 1.3 }),
      'top-right',
    )
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      'top-right',
    )
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

    map.on('load', () => {
      loadedRef.current = true
      syncOverlays(map, overlaysRef.current)
    })

    // Feature popup: tap a fire perimeter / point to see its KML name & description.
    map.on('click', (e) => {
      const rendered = map
        .queryRenderedFeatures(e.point)
        .find((f) => f.layer.id.startsWith('ov-'))
      if (!rendered) return
      const { name, description } = rendered.properties ?? {}
      if (!name && !description) return
      const html = `<div style="max-width:240px;color:#111">
        ${name ? `<strong>${escapeHtml(String(name))}</strong>` : ''}
        ${description ? `<div style="margin-top:4px;font-size:12px">${escapeHtml(String(description)).slice(0, 500)}</div>` : ''}
      </div>`
      new Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map)
    })

    return () => {
      loadedRef.current = false
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Add/remove overlay sources & layers when the overlay list changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    syncOverlays(map, overlays)
  }, [overlays])

  // Toggle visibility.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    for (const overlay of overlays) {
      const visible = hiddenIds.has(overlay.id) ? 'none' : 'visible'
      for (const suffix of ['fill', 'line', 'point', 'label']) {
        const layerId = `ov-${overlay.id}-${suffix}`
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, 'visibility', visible)
        }
      }
    }
  }, [overlays, hiddenIds])

  // Fly to an overlay on request.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusRequest) return
    const overlay = overlaysRef.current.find((o) => o.id === focusRequest.id)
    if (!overlay) return
    const bounds = boundsOf(overlay.geojson)
    if (bounds) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 800 })
    }
  }, [focusRequest])

  return <div ref={containerRef} className="map-view" />
}

function syncOverlays(map: MlMap, overlays: Overlay[]) {
  const wantedSources = new Set(overlays.map((o) => `ov-${o.id}`))

  // Remove layers/sources for deleted overlays.
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith('ov-')) {
      const sourceId = layer.id.replace(/-(fill|line|point|label)$/, '')
      if (!wantedSources.has(sourceId)) map.removeLayer(layer.id)
    }
  }
  for (const sourceId of Object.keys(map.getStyle().sources ?? {})) {
    if (sourceId.startsWith('ov-') && !wantedSources.has(sourceId)) {
      map.removeSource(sourceId)
    }
  }

  for (const overlay of overlays) {
    const sourceId = `ov-${overlay.id}`
    if (map.getSource(sourceId)) continue

    map.addSource(sourceId, { type: 'geojson', data: overlay.geojson })

    // togeojson carries KML styles through as simplestyle props (stroke, fill…).
    map.addLayer({
      id: `${sourceId}-fill`,
      type: 'fill',
      source: sourceId,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': ['coalesce', ['get', 'fill'], DEFAULT_FILL],
        'fill-opacity': ['coalesce', ['get', 'fill-opacity'], 0.25],
      },
    })
    map.addLayer({
      id: `${sourceId}-line`,
      type: 'line',
      source: sourceId,
      filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]],
      paint: {
        'line-color': ['coalesce', ['get', 'stroke'], DEFAULT_STROKE],
        'line-width': ['coalesce', ['get', 'stroke-width'], 2],
        'line-opacity': ['coalesce', ['get', 'stroke-opacity'], 1],
      },
    })
    map.addLayer({
      id: `${sourceId}-point`,
      type: 'circle',
      source: sourceId,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 6,
        'circle-color': ['coalesce', ['get', 'marker-color'], DEFAULT_STROKE],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    })
    map.addLayer({
      id: `${sourceId}-label`,
      type: 'symbol',
      source: sourceId,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ''],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1.5,
      },
    })
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
