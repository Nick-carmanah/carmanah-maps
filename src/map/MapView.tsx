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
import {
  FIRE_SYMBOLS,
  featuresToGeoJSON,
  renderSymbolImage,
  type UserFeature,
} from '../lib/features'
import { fenceShapes } from '../lib/fences'
import {
  COORD_FORMATS,
  FORMAT_LABELS,
  formatCoord,
  parseCoordinate,
  type CoordFormat,
} from '../lib/coords'
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
    satellite: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery: Esri, Maxar, Earthstar Geographics',
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
    { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
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
  /** Live GPS track being recorded (empty when not recording). */
  trackPoints: Position[]
  /** Guidance line from current position to nav target, or null. */
  navLine: [Position, Position] | null
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
  trackPoints,
  navLine,
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

  // Basemap toggle (streets ↔ satellite)
  const [basemap, setBasemap] = useState<'streets' | 'satellite'>(
    () => (localStorage.getItem('carmanah-basemap') as 'streets' | 'satellite') || 'streets',
  )
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    map.setLayoutProperty('osm', 'visibility', basemap === 'streets' ? 'visible' : 'none')
    map.setLayoutProperty(
      'satellite',
      'visibility',
      basemap === 'satellite' ? 'visible' : 'none',
    )
    localStorage.setItem('carmanah-basemap', basemap)
  }, [basemap])

  // Coordinate readout & universal search
  const [coordFmt, setCoordFmt] = useState<CoordFormat>(
    () => (localStorage.getItem('carmanah-coord-fmt') as CoordFormat) || 'dd',
  )
  const [center, setCenter] = useState<Position>([-123.37, 48.43])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchResults, setSearchResults] = useState<
    { name: string; detail: string; position: Position }[]
  >([])

  const cycleFormat = () => {
    const next = COORD_FORMATS[(COORD_FORMATS.indexOf(coordFmt) + 1) % COORD_FORMATS.length]
    setCoordFmt(next)
    localStorage.setItem('carmanah-coord-fmt', next)
  }

  const flyToResult = (pos: Position) => {
    const map = mapRef.current
    if (!map) return
    const source = map.getSource('coord-marker') as maplibregl.GeoJSONSource | undefined
    source?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: pos },
    })
    map.flyTo({ center: pos as [number, number], zoom: Math.max(map.getZoom(), 13) })
    setSearchOpen(false)
    setSearchText('')
    setSearchResults([])
  }

  const runSearch = () => {
    // Coordinates take priority; otherwise search every feature by name.
    const pos = parseCoordinate(searchText)
    if (pos) {
      flyToResult(pos)
      return
    }
    const q = searchText.trim().toLowerCase()
    if (q.length < 2) {
      onNotify('Type coordinates or at least 2 characters', true)
      return
    }
    const results: { name: string; detail: string; position: Position }[] = []
    for (const f of userFeaturesRef.current) {
      if (f.name.toLowerCase().includes(q)) {
        results.push({
          name: f.name,
          detail: `My Data · ${f.kind}`,
          position: f.kind === 'pin' ? (f.coordinates as Position) : (f.coordinates as Position[])[0],
        })
      }
    }
    for (const overlay of overlaysRef.current) {
      for (const feat of overlay.geojson.features) {
        const name = feat.properties?.name
        if (
          typeof name === 'string' &&
          name.toLowerCase().includes(q) &&
          feat.geometry &&
          'coordinates' in feat.geometry
        ) {
          results.push({
            name,
            detail: overlay.name,
            position: firstPosition(feat.geometry.coordinates),
          })
        }
      }
    }
    for (const feat of liveFiresRef.current?.points.features ?? []) {
      const p = feat.properties ?? {}
      const label = [p.INCIDENT_NAME, p.FIRE_NUMBER, p.GEOGRAPHIC_DESCRIPTION]
        .filter(Boolean)
        .join(' ')
      if (label.toLowerCase().includes(q) && feat.geometry.type === 'Point') {
        results.push({
          name: String(p.INCIDENT_NAME ?? p.FIRE_NUMBER),
          detail: `Live fire · ${p.FIRE_STATUS}`,
          position: feat.geometry.coordinates,
        })
      }
    }
    if (!results.length) {
      onNotify('No matches — try coordinates (DD, DMS, UTM, MGRS) or a feature name', true)
      return
    }
    if (results.length === 1) {
      flyToResult(results[0].position)
      return
    }
    setSearchResults(results.slice(0, 8))
  }

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

    // Throttled center readout for the coordinate pill.
    let lastCenterUpdate = 0
    map.on('move', () => {
      const now = performance.now()
      if (now - lastCenterUpdate < 150) return
      lastCenterUpdate = now
      const c = map.getCenter()
      setCenter([c.lng, c.lat])
    })

    map.on('load', () => {
      loadedRef.current = true
      addLiveFireLayers(map)
      addUserFeatureLayers(map)
      addFenceLayers(map)
      addTrackLayers(map)
      addNavLayers(map)
      addCoordMarkerLayer(map)
      addMeasureLayers(map)
      syncOverlays(map, overlaysRef.current)
      setLiveFireData(map, liveFiresRef.current)
      setUserFeatureData(map, userFeaturesRef.current)
      ;(map.getSource('fences') as maplibregl.GeoJSONSource | undefined)?.setData(
        fenceShapes(userFeaturesRef.current),
      )
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

  // Push user features (and their armed geofence outlines) to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    setUserFeatureData(map, userFeatures)
    const fences = map.getSource('fences') as maplibregl.GeoJSONSource | undefined
    fences?.setData(fenceShapes(userFeatures))
  }, [userFeatures])

  // Push the in-progress GPS track to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const source = map.getSource('track') as maplibregl.GeoJSONSource | undefined
    source?.setData(
      trackPoints.length >= 2
        ? {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: trackPoints },
          }
        : EMPTY_FC,
    )
  }, [trackPoints])

  // Push the navigation guidance line to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const source = map.getSource('nav') as maplibregl.GeoJSONSource | undefined
    source?.setData(
      navLine
        ? {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: navLine },
          }
        : EMPTY_FC,
    )
  }, [navLine])

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
      <div className="coord-pill">
        {searchOpen ? (
          <>
            <input
              autoFocus
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value)
                setSearchResults([])
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch()
                if (e.key === 'Escape') {
                  setSearchOpen(false)
                  setSearchResults([])
                }
              }}
              placeholder="Coordinates or feature name…"
            />
            <button className="pill-btn" onClick={runSearch}>
              Go
            </button>
            <button
              className="pill-btn"
              onClick={() => {
                setSearchOpen(false)
                setSearchResults([])
              }}
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <span className="coord-text" onClick={() => setSearchOpen(true)} title="Search coordinates">
              {formatCoord(center, coordFmt)}
            </span>
            <button className="pill-btn" onClick={cycleFormat} title="Switch coordinate format">
              {FORMAT_LABELS[coordFmt]}
            </button>
          </>
        )}
      </div>
      {searchResults.length > 0 && (
        <div className="search-results">
          {searchResults.map((r, i) => (
            <button key={i} onClick={() => flyToResult(r.position)}>
              <span className="result-name">{r.name}</span>
              <span className="result-detail">{r.detail}</span>
            </button>
          ))}
        </div>
      )}
      <div className="center-crosshair" aria-hidden />
      <button
        className="btn basemap-btn"
        onClick={() => setBasemap((b) => (b === 'streets' ? 'satellite' : 'streets'))}
        title="Toggle satellite imagery"
      >
        {basemap === 'streets' ? '🛰 Satellite' : '🗺 Streets'}
      </button>
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
  // Register the built-in fire-ops symbol set as map images.
  for (const key of Object.keys(FIRE_SYMBOLS)) {
    if (!map.hasImage(`sym-${key}`)) {
      map.addImage(`sym-${key}`, renderSymbolImage(key), { pixelRatio: 2 })
    }
  }

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
  // Plain dot for pins without a symbol…
  map.addLayer({
    id: 'uf-pts',
    type: 'circle',
    source: 'user-features',
    filter: [
      'all',
      ['==', ['geometry-type'], 'Point'],
      ['==', ['coalesce', ['get', 'symbol'], ''], ''],
    ],
    paint: {
      'circle-radius': 7,
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#1a1a1a',
    },
  })
  // …fire-ops symbol icon for pins that have one.
  map.addLayer({
    id: 'uf-sym',
    type: 'symbol',
    source: 'user-features',
    filter: [
      'all',
      ['==', ['geometry-type'], 'Point'],
      ['!=', ['coalesce', ['get', 'symbol'], ''], ''],
    ],
    layout: {
      'icon-image': ['concat', 'sym-', ['get', 'symbol']],
      'icon-size': 1,
      'icon-allow-overlap': true,
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

function addFenceLayers(map: MlMap) {
  map.addSource('fences', { type: 'geojson', data: EMPTY_FC })
  map.addLayer({
    id: 'fence-line',
    type: 'line',
    source: 'fences',
    paint: {
      'line-color': '#fbbf24',
      'line-width': 2,
      'line-dasharray': [3, 2],
      'line-opacity': 0.9,
    },
  })
}

function addTrackLayers(map: MlMap) {
  map.addSource('track', { type: 'geojson', data: EMPTY_FC })
  map.addLayer({
    id: 'track-casing',
    type: 'line',
    source: 'track',
    paint: { 'line-color': '#0c4a6e', 'line-width': 6, 'line-opacity': 0.7 },
  })
  map.addLayer({
    id: 'track-line',
    type: 'line',
    source: 'track',
    paint: { 'line-color': '#38bdf8', 'line-width': 3 },
  })
}

/** First [lng, lat] in any (nested) coordinate array. */
function firstPosition(coords: unknown): Position {
  let c = coords as unknown[]
  while (Array.isArray(c[0])) c = c[0] as unknown[]
  return c as Position
}

function addNavLayers(map: MlMap) {
  map.addSource('nav', { type: 'geojson', data: EMPTY_FC })
  map.addLayer({
    id: 'nav-line',
    type: 'line',
    source: 'nav',
    paint: {
      'line-color': '#4ade80',
      'line-width': 3,
      'line-dasharray': [1.5, 1.5],
    },
  })
}

function addCoordMarkerLayer(map: MlMap) {
  map.addSource('coord-marker', { type: 'geojson', data: EMPTY_FC })
  map.addLayer({
    id: 'coord-marker',
    type: 'circle',
    source: 'coord-marker',
    paint: {
      'circle-radius': 8,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 3,
      'circle-stroke-color': '#fb923c',
    },
  })
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
