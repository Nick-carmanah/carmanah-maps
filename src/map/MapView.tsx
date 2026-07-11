import { useEffect, useRef, useState } from 'react'
import maplibregl, { Map as MlMap, Popup } from 'maplibre-gl'
import type { FeatureCollection, Position } from 'geojson'
import type { Overlay } from '../lib/store'
import { boundsOf } from '../lib/geo'
import {
  formatArea,
  formatDistance,
  pathLengthMeters,
  ringAreaSqMeters,
} from '../lib/measure'
import { STATUS_COLORS, STATUS_FALLBACK_COLOR, type LiveFires } from '../lib/livefires'
import { featuresToGeoJSON, type UserFeature } from '../lib/features'
import {
  AVG_TILE_KB,
  downloadMapPack,
  estimateTileCount,
  MAX_TILES,
} from '../lib/mappacks'

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
  measureMode: boolean
  onExitMeasure: () => void
  /** Save the current measurement sketch as a persistent line/area. */
  onSaveMeasure: (kind: 'line' | 'area', points: Position[]) => void
  /** Live BCWS fire data to display, or null when the layer is off. */
  liveFires: LiveFires | null
  userFeatures: UserFeature[]
  /** When true, the next map tap drops a pin. */
  pinMode: boolean
  onDropPin: (position: Position) => void
  onEditFeature: (id: string) => void
  onNotify: (message: string, isError?: boolean) => void
}

export default function MapView({
  overlays,
  hiddenIds,
  focusRequest,
  measureMode,
  onExitMeasure,
  onSaveMeasure,
  liveFires,
  userFeatures,
  pinMode,
  onDropPin,
  onEditFeature,
  onNotify,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const loadedRef = useRef(false)
  const overlaysRef = useRef<Overlay[]>(overlays)
  overlaysRef.current = overlays
  const measureModeRef = useRef(measureMode)
  measureModeRef.current = measureMode
  const [measurePoints, setMeasurePoints] = useState<Position[]>([])
  const liveFiresRef = useRef<LiveFires | null>(liveFires)
  liveFiresRef.current = liveFires
  const userFeaturesRef = useRef<UserFeature[]>(userFeatures)
  userFeaturesRef.current = userFeatures
  const pinModeRef = useRef(pinMode)
  pinModeRef.current = pinMode
  const onDropPinRef = useRef(onDropPin)
  onDropPinRef.current = onDropPin
  const onEditFeatureRef = useRef(onEditFeature)
  onEditFeatureRef.current = onEditFeature
  const [packProgress, setPackProgress] = useState<{ done: number; total: number } | null>(
    null,
  )
  // Two-step confirm: first tap shows the size estimate, second tap downloads.
  const [packEstimate, setPackEstimate] = useState<number | null>(null)
  const estimateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const saveOffline = async () => {
    const map = mapRef.current
    if (!map || packProgress) return

    if (packEstimate === null) {
      const count = estimateTileCount(map.getBounds())
      if (count > MAX_TILES) {
        onNotify(
          `This view needs ~${count} tiles — zoom in to a fire-sized area first`,
          true,
        )
        return
      }
      setPackEstimate(count)
      clearTimeout(estimateTimer.current)
      estimateTimer.current = setTimeout(() => setPackEstimate(null), 8000)
      return
    }

    clearTimeout(estimateTimer.current)
    setPackEstimate(null)
    setPackProgress({ done: 0, total: 1 })
    try {
      const result = await downloadMapPack(map.getBounds(), (done, total) =>
        setPackProgress({ done, total }),
      )
      onNotify(
        `Area saved offline — ${result.fetched + result.alreadyCached} tiles ready` +
          (result.failed ? ` (${result.failed} failed)` : ''),
        result.failed > 0,
      )
    } catch (err) {
      onNotify((err as Error).message, true)
    } finally {
      setPackProgress(null)
    }
  }

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
      addLiveFireLayers(map)
      addUserFeatureLayers(map)
      addMeasureLayers(map)
      syncOverlays(map, overlaysRef.current)
      setLiveFireData(map, liveFiresRef.current)
      setUserFeatureData(map, userFeaturesRef.current)
    })

    // Tap priority: measuring > dropping a pin > editing your own features >
    // info popups for imported/live features.
    map.on('click', (e) => {
      if (measureModeRef.current) {
        setMeasurePoints((prev) => [...prev, [e.lngLat.lng, e.lngLat.lat]])
        return
      }
      if (pinModeRef.current) {
        onDropPinRef.current([e.lngLat.lng, e.lngLat.lat])
        return
      }
      // Labels have large invisible hit boxes that steal taps — skip them.
      const rendered = map
        .queryRenderedFeatures(e.point)
        .find(
          (f) =>
            (f.layer.id.startsWith('ov-') ||
              f.layer.id.startsWith('live-') ||
              f.layer.id.startsWith('uf-')) &&
            !f.layer.id.endsWith('-label'),
        )
      if (!rendered) return
      if (rendered.layer.id.startsWith('uf-')) {
        onEditFeatureRef.current(String(rendered.properties?.id))
        return
      }
      const { name, description } = rendered.layer.id.startsWith('live-')
        ? liveFirePopupContent(rendered.properties ?? {})
        : (rendered.properties ?? {})
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

  // Fly to an overlay or user feature on request.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusRequest) return
    const overlay = overlaysRef.current.find((o) => o.id === focusRequest.id)
    const feature = userFeaturesRef.current.find((f) => f.id === focusRequest.id)
    const geojson = overlay?.geojson ?? (feature ? featuresToGeoJSON([feature]) : null)
    if (!geojson) return
    const bounds = boundsOf(geojson)
    if (bounds) {
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 800 })
    }
  }, [focusRequest])

  // Measure mode: crosshair cursor, no double-click zoom, clear points on exit.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (measureMode) {
      map.getCanvas().style.cursor = 'crosshair'
      map.doubleClickZoom.disable()
    } else {
      map.getCanvas().style.cursor = ''
      map.doubleClickZoom.enable()
      setMeasurePoints([])
    }
  }, [measureMode])

  // Push measurement geometry to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const source = map.getSource('measure') as maplibregl.GeoJSONSource | undefined
    source?.setData(measureFeatures(measurePoints))
  }, [measurePoints])

  // Push live fire data to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    setLiveFireData(map, liveFires)
  }, [liveFires])

  // Push user features to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    setUserFeatureData(map, userFeatures)
  }, [userFeatures])

  // Pin mode cursor.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (pinMode) map.getCanvas().style.cursor = 'crosshair'
    else if (!measureModeRef.current) map.getCanvas().style.cursor = ''
  }, [pinMode])

  const distanceM = pathLengthMeters(measurePoints)
  const areaM2 = ringAreaSqMeters(measurePoints)

  return (
    <>
      <div ref={containerRef} className="map-view" />
      <button
        className="btn offline-btn"
        onClick={saveOffline}
        disabled={!!packProgress}
        title="Download basemap and terrain tiles for the current view"
      >
        {packProgress
          ? `Saving… ${Math.round((packProgress.done / packProgress.total) * 100)}%`
          : packEstimate !== null
            ? `${packEstimate} tiles · ~${Math.max(1, Math.round((packEstimate * AVG_TILE_KB) / 1024))} MB — tap to confirm`
            : '⬇ Save offline'}
      </button>
      {measureMode && (
        <div className="measure-chip">
          <span className="readout">
            {measurePoints.length < 2
              ? 'Tap the map to measure'
              : `${formatDistance(distanceM)}${measurePoints.length >= 3 ? ` · ${formatArea(areaM2)}` : ''}`}
          </span>
          <button
            className="btn"
            disabled={!measurePoints.length}
            onClick={() => setMeasurePoints((prev) => prev.slice(0, -1))}
          >
            Undo
          </button>
          {measurePoints.length >= 2 && (
            <button className="btn" onClick={() => onSaveMeasure('line', measurePoints)}>
              Save line
            </button>
          )}
          {measurePoints.length >= 3 && (
            <button className="btn" onClick={() => onSaveMeasure('area', measurePoints)}>
              Save area
            </button>
          )}
          <button className="btn" onClick={onExitMeasure}>
            Done
          </button>
        </div>
      )}
    </>
  )
}

function measureFeatures(points: Position[]): FeatureCollection {
  const features: FeatureCollection['features'] = points.map((p) => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: p },
  }))
  if (points.length >= 2) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: points },
    })
  }
  if (points.length >= 3) {
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] },
    })
  }
  return { type: 'FeatureCollection', features }
}

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }

const STATUS_COLOR_EXPR = [
  'match',
  ['get', 'FIRE_STATUS'],
  ...Object.entries(STATUS_COLORS).flat(),
  STATUS_FALLBACK_COLOR,
] as unknown as maplibregl.ExpressionSpecification

function addLiveFireLayers(map: MlMap) {
  map.addSource('live-perimeters', { type: 'geojson', data: EMPTY_FC })
  map.addSource('live-points', { type: 'geojson', data: EMPTY_FC })

  map.addLayer({
    id: 'live-perim-fill',
    type: 'fill',
    source: 'live-perimeters',
    paint: { 'fill-color': STATUS_COLOR_EXPR, 'fill-opacity': 0.18 },
  })
  map.addLayer({
    id: 'live-perim-line',
    type: 'line',
    source: 'live-perimeters',
    paint: { 'line-color': STATUS_COLOR_EXPR, 'line-width': 1.5 },
  })
  map.addLayer({
    id: 'live-pts',
    type: 'circle',
    source: 'live-points',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 10, 6],
      'circle-color': STATUS_COLOR_EXPR,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
    },
  })
  map.addLayer({
    id: 'live-pts-label',
    type: 'symbol',
    source: 'live-points',
    minzoom: 8,
    layout: {
      'text-field': ['get', 'FIRE_NUMBER'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-offset': [0, 1],
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

function setLiveFireData(map: MlMap, data: LiveFires | null) {
  const perims = map.getSource('live-perimeters') as maplibregl.GeoJSONSource | undefined
  const points = map.getSource('live-points') as maplibregl.GeoJSONSource | undefined
  perims?.setData(data?.perimeters ?? EMPTY_FC)
  points?.setData(data?.points ?? EMPTY_FC)
}

function liveFirePopupContent(props: Record<string, unknown>): {
  name: string
  description: string
} {
  const sizeHa = props.CURRENT_SIZE ?? props.FIRE_SIZE_HECTARES
  const parts = [
    props.FIRE_STATUS && `Status: ${props.FIRE_STATUS}`,
    sizeHa != null && `Size: ${sizeHa} ha`,
    props.FIRE_CAUSE && `Cause: ${props.FIRE_CAUSE}`,
    props.GEOGRAPHIC_DESCRIPTION,
  ].filter(Boolean)
  return {
    name: String(props.INCIDENT_NAME ?? props.FIRE_NUMBER ?? 'Fire'),
    description: parts.join(' · '),
  }
}

function addUserFeatureLayers(map: MlMap) {
  map.addSource('user-features', { type: 'geojson', data: EMPTY_FC })
  map.addLayer({
    id: 'uf-fill',
    type: 'fill',
    source: 'user-features',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
  })
  map.addLayer({
    id: 'uf-line',
    type: 'line',
    source: 'user-features',
    filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]],
    paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
  })
  map.addLayer({
    id: 'uf-pts',
    type: 'circle',
    source: 'user-features',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 7,
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#1a1a1a',
    },
  })
  map.addLayer({
    id: 'uf-label',
    type: 'symbol',
    source: 'user-features',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.2],
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

function setUserFeatureData(map: MlMap, features: UserFeature[]) {
  const source = map.getSource('user-features') as maplibregl.GeoJSONSource | undefined
  source?.setData(featuresToGeoJSON(features))
}

function addMeasureLayers(map: MlMap) {
  map.addSource('measure', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  })
  map.addLayer({
    id: 'measure-fill',
    type: 'fill',
    source: 'measure',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#facc15', 'fill-opacity': 0.15 },
  })
  map.addLayer({
    id: 'measure-line',
    type: 'line',
    source: 'measure',
    filter: ['==', ['geometry-type'], 'LineString'],
    paint: { 'line-color': '#facc15', 'line-width': 2.5, 'line-dasharray': [2, 1] },
  })
  map.addLayer({
    id: 'measure-pts',
    type: 'circle',
    source: 'measure',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#facc15',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#1a1a1a',
    },
  })
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

  // Keep imported overlays below the user's own drawings and measurements.
  const beforeId = map.getLayer('uf-fill')
    ? 'uf-fill'
    : map.getLayer('measure-fill')
      ? 'measure-fill'
      : undefined

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
    }, beforeId)
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
    }, beforeId)
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
    }, beforeId)
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
    }, beforeId)
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
