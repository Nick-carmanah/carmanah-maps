import { useEffect, useRef, useState } from 'react'
import maplibregl, { Map as MlMap, Popup, type LngLatBoundsLike } from 'maplibre-gl'
import type { FeatureCollection, Position } from 'geojson'
import { getIcon } from '../lib/store'
import type { MapLayer } from '../hooks/useMapsLibrary'
import { bearingDeg, boundsOf, boundsOfPositions } from '../lib/geo'
import { pathLengthMeters, ringAreaSqMeters } from '../lib/measure'
import {
  formatArea,
  formatBearing,
  formatDistance,
  getUnitSettings,
  setUnitSettings,
} from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'
import { UnitScaleControl } from './scale'
import { STATUS_COLORS, STATUS_FALLBACK_COLOR, type LiveFires } from '../lib/livefires'
import {
  DEFAULT_FILL_OPACITY,
  DEFAULT_LINE_WIDTH,
  FIRE_SYMBOLS,
  featuresToGeoJSON,
  renderSymbolImage,
  type UserFeature,
} from '../lib/features'
import { ICON_PREFIX } from '../lib/symbols'
import { fenceShapes } from '../lib/fences'
import { splitSegments } from '../lib/track'
import { buildGrid, gridSystemFor } from '../lib/grid'
import { NWCG_SYMBOLS, nwcgIconUrl } from '../lib/nwcg'
import { COORD_FORMATS, FORMAT_LABELS, formatCoord, parseCoordinate } from '../lib/coords'
import {
  AVG_TILE_KB,
  downloadMapPack,
  estimateTileCount,
  MAX_TILES,
} from '../lib/mappacks'
import { BASEMAP_LAYER_IDS, MAP_STYLE } from './basemap'
import { EMBEDDED } from '../lib/embedded'
import { satelliteSignal } from '../lib/satellite-signal'

interface MapViewProps {
  /** Imported maps from the Maps library (GeoPDFs), oldest first. */
  mapLayers: MapLayer[]
  /** Map or feature id the map should fly to, or explicit bounds (a
   * layer's extent). Changes trigger a fit. Opening a map fits it at once
   * (`instant`) and as close as its detail allows (`maxZoom`). */
  focusRequest: {
    id: string
    nonce: number
    bounds?: LngLatBoundsLike | null
    maxZoom?: number
    instant?: boolean
  } | null
  measureMode: boolean
  onExitMeasure: () => void
  /** Save the current measurement sketch as a persistent line/area. */
  onSaveMeasure: (kind: 'line' | 'area', points: Position[]) => void
  /** Live BCWS fire data to display, or null when the layer is off. */
  liveFires: LiveFires | null
  /** Show/hide the BCWS perimeter polygons (points stay visible). */
  showLivePerimeters: boolean
  userFeatures: UserFeature[]
  /** Ids of layers not drawn (hidden themselves or under a hidden parent). */
  hiddenLayerIds: Set<string>
  /** UTM grid overlay on/off. */
  showGrid: boolean
  /** Live GPS track being recorded (empty when not recording). */
  trackPoints: Position[]
  /** Where the live track resumed after a pause (indexes into trackPoints):
   * a gap is left there, not a straight line. */
  trackBreaks?: number[]
  /** Guidance line from current position to nav target, or null. */
  navLine: [Position, Position] | null
  /** When true, the next map tap drops a pin. */
  pinMode: boolean
  onDropPin: (position: Position) => void
  onEditFeature: (id: string) => void
  onNotify: (message: string, isError?: boolean) => void
  /** Hands out the map instance once it exists (null after it's removed). */
  onMapReady?: (map: MlMap | null) => void
  /** The basemap to draw: streets whenever satellite has no signal, and
   * 'none' while a custom map is open on its own (a plain background around it). */
  basemap: Basemap
  /** Bump to open the coordinate search input (from the tools sheet). */
  openSearchNonce: number
}

export default function MapView({
  mapLayers,
  focusRequest,
  measureMode,
  onExitMeasure,
  onSaveMeasure,
  liveFires,
  showLivePerimeters,
  userFeatures,
  hiddenLayerIds,
  showGrid,
  trackPoints,
  trackBreaks,
  navLine,
  pinMode,
  onDropPin,
  onEditFeature,
  onNotify,
  onMapReady,
  basemap,
  openSearchNonce,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const loadedRef = useRef(false)
  const mapLayersRef = useRef<MapLayer[]>(mapLayers)
  mapLayersRef.current = mapLayers
  const measureModeRef = useRef(measureMode)
  measureModeRef.current = measureMode
  const [measurePoints, setMeasurePoints] = useState<Position[]>([])
  const liveFiresRef = useRef<LiveFires | null>(liveFires)
  liveFiresRef.current = liveFires
  const showLivePerimetersRef = useRef(showLivePerimeters)
  showLivePerimetersRef.current = showLivePerimeters
  const scaleRef = useRef<UnitScaleControl | null>(null)
  // Unit settings (Tools → Profile and settings); readouts re-render on change.
  const units = useUnitSettings()
  const coordFmt = units.coords

  // Keep the scale bar in the chosen units.
  useEffect(() => {
    scaleRef.current?.setUnit(units.distance)
  }, [units.distance])
  const userFeaturesRef = useRef<UserFeature[]>(userFeatures)
  userFeaturesRef.current = userFeatures
  const hiddenLayerIdsRef = useRef(hiddenLayerIds)
  hiddenLayerIdsRef.current = hiddenLayerIds
  const showGridRef = useRef(showGrid)
  showGridRef.current = showGrid
  const basemapRef = useRef(basemap)
  basemapRef.current = basemap
  const pinModeRef = useRef(pinMode)
  pinModeRef.current = pinMode
  const onDropPinRef = useRef(onDropPin)
  onDropPinRef.current = onDropPin
  const onEditFeatureRef = useRef(onEditFeature)
  onEditFeatureRef.current = onEditFeature
  const onMapReadyRef = useRef(onMapReady)
  onMapReadyRef.current = onMapReady
  const [packProgress, setPackProgress] = useState<{ done: number; total: number } | null>(
    null,
  )
  // Two-step confirm: first tap shows the size estimate, second tap downloads.
  const [packEstimate, setPackEstimate] = useState<number | null>(null)
  const estimateTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Basemap (streets ↔ satellite) — chosen in the layers sheet.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    showBasemap(map, basemap)
  }, [basemap])

  // Tools sheet → "Find by coordinates" opens the search pill.
  useEffect(() => {
    if (openSearchNonce > 0) setSearchOpen(true)
  }, [openSearchNonce])

  // Coordinate readout & universal search. The format is the Coordinates
  // unit setting (DDM default — the BCWS field standard).
  const [center, setCenter] = useState<Position>([-123.37, 48.43])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchResults, setSearchResults] = useState<
    { name: string; detail: string; position: Position }[]
  >([])

  const cycleFormat = () => {
    const next = COORD_FORMATS[(COORD_FORMATS.indexOf(coordFmt) + 1) % COORD_FORMATS.length]
    setUnitSettings({ coords: next })
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
      if (hiddenLayerIdsRef.current.has(f.layerId)) continue
      if (f.name.toLowerCase().includes(q)) {
        results.push({
          name: f.name,
          detail: `My Data · ${f.kind}`,
          position: f.kind === 'pin' ? (f.coordinates as Position) : (f.coordinates as Position[])[0],
        })
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
      onNotify(
        'No matches — try coordinates (DD, DDM, DMS, UTM, MGRS, BC Albers) or a feature name',
        true,
      )
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
    onMapReadyRef.current?.(map)
    // Dev console access (harmless in prod, handy for debugging in the field too)
    ;(window as unknown as Record<string, unknown>).__map = map
    map.on('error', (e) => {
      // A satellite tile that didn't load: several in a row mean no signal,
      // and the map shows streets instead of blank tiles.
      if ((e as { sourceId?: string }).sourceId === 'satellite' && 'tile' in e) {
        satelliteSignal.tileFailed()
        return
      }
      console.error('[map error]', e.error?.message ?? e)
    })
    map.on('sourcedata', (e) => {
      if (e.sourceId === 'satellite' && e.tile) satelliteSignal.tileLoaded()
    })

    // NWCG icons and icons restored from imported KMZ files load lazily the
    // first time a feature references one.
    map.on('styleimagemissing', async (e) => {
      if (e.id.startsWith(`sym-${ICON_PREFIX}`)) {
        const asset = await getIcon(e.id.slice(`sym-${ICON_PREFIX}`.length))
        if (!asset || map.hasImage(e.id)) return
        try {
          const bitmap = await createImageBitmap(asset.blob)
          // Show imported icons at about 28 px, whatever size they were saved at.
          const pixelRatio = Math.max(1, Math.max(bitmap.width, bitmap.height) / 28)
          if (!map.hasImage(e.id)) map.addImage(e.id, bitmap, { pixelRatio })
        } catch {
          // unreadable image — the pin shows without an icon
        }
        return
      }
      if (!e.id.startsWith('sym-nwcg-')) return
      const spec = NWCG_SYMBOLS.find((s) => `sym-${s.key}` === e.id)
      if (!spec) return
      try {
        const img = await map.loadImage(nwcgIconUrl(spec.file))
        if (!map.hasImage(e.id)) map.addImage(e.id, img.data, { pixelRatio: 2 })
      } catch {
        // icon missing — feature falls back to unstyled symbol
      }
    })

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
    const scale = new UnitScaleControl(getUnitSettings().distance)
    scaleRef.current = scale
    map.addControl(scale, 'bottom-left')

    // Center readout for the coordinate pill: throttled while moving, then
    // exact once the map stops — the last throttled update can trail the
    // final position by metres, and crews read locations off the crosshair.
    const updateCenter = () => {
      const c = map.getCenter()
      setCenter([c.lng, c.lat])
    }
    let lastCenterUpdate = 0
    map.on('move', () => {
      const now = performance.now()
      if (now - lastCenterUpdate < 150) return
      lastCenterUpdate = now
      updateCenter()
    })
    map.on('moveend', updateCenter)

    // UTM grid follows the view.
    map.on('moveend', () => updateGrid(map, showGridRef.current))

    map.on('load', () => {
      loadedRef.current = true
      syncMapLayers(map, mapLayersRef.current)
      addGridLayers(map)
      addLiveFireLayers(map)
      addUserFeatureLayers(map)
      addFenceLayers(map)
      addTrackLayers(map)
      addNavLayers(map)
      addCoordMarkerLayer(map)
      addMeasureLayers(map)
      setLiveFireData(map, liveFiresRef.current)
      if (!showLivePerimetersRef.current) {
        map.setLayoutProperty('live-perim-fill', 'visibility', 'none')
        map.setLayoutProperty('live-perim-line', 'visibility', 'none')
      }
      if (basemapRef.current !== 'streets') showBasemap(map, basemapRef.current)
      setUserFeatureData(map, userFeaturesRef.current, hiddenLayerIdsRef.current)
      ;(map.getSource('fences') as maplibregl.GeoJSONSource | undefined)?.setData(
        fenceShapes(
          userFeaturesRef.current.filter((f) => !hiddenLayerIdsRef.current.has(f.layerId)),
        ),
      )
      updateGrid(map, showGridRef.current)
    })

    // Tap priority: measuring > dropping a pin > editing a My Data feature
    // (drawn or imported) > info popups for live fires.
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
            (f.layer.id.startsWith('live-') || f.layer.id.startsWith('uf-')) &&
            !f.layer.id.endsWith('-label'),
        )
      if (!rendered) return
      if (rendered.layer.id.startsWith('uf-')) {
        onEditFeatureRef.current(String(rendered.properties?.id))
        return
      }
      const { name, description } = liveFirePopupContent(rendered.properties ?? {})
      const html = `<div style="max-width:240px;color:#111">
        ${name ? `<strong>${escapeHtml(String(name))}</strong>` : ''}
        ${description ? `<div style="margin-top:4px;font-size:12px">${escapeHtml(String(description)).slice(0, 500)}</div>` : ''}
      </div>`
      new Popup({ closeButton: true }).setLngLat(e.lngLat).setHTML(html).addTo(map)
    })

    return () => {
      loadedRef.current = false
      onMapReadyRef.current?.(null)
      map.remove()
      mapRef.current = null
      scaleRef.current = null
    }
  }, [])

  // Imported maps: add, remove, show/hide and fade as the library changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    syncMapLayers(map, mapLayers)
  }, [mapLayers])

  // Fly to a map, a feature, or explicit bounds on request.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focusRequest) return
    const feature = userFeaturesRef.current.find((f) => f.id === focusRequest.id)
    const raster = mapLayersRef.current.find((r) => r.id === focusRequest.id)
    const bounds =
      focusRequest.bounds ??
      (raster
        ? boundsOfPositions(raster.corners)
        : feature
          ? boundsOf(featuresToGeoJSON([feature]))
          : null)
    if (bounds) {
      map.fitBounds(bounds, {
        padding: focusRequest.instant ? 24 : 60,
        maxZoom: focusRequest.maxZoom ?? 14,
        duration: focusRequest.instant ? 0 : 800,
      })
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

  // Toggle BCWS perimeter polygons independently of the fire points.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const visibility = showLivePerimeters ? 'visible' : 'none'
    for (const layerId of ['live-perim-fill', 'live-perim-line']) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', visibility)
    }
  }, [showLivePerimeters, liveFires])

  // Push user features (and their armed geofence outlines) to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    setUserFeatureData(map, userFeatures, hiddenLayerIds)
    const fences = map.getSource('fences') as maplibregl.GeoJSONSource | undefined
    fences?.setData(fenceShapes(userFeatures.filter((f) => !hiddenLayerIds.has(f.layerId))))
  }, [userFeatures, hiddenLayerIds])

  // Grid toggle, and UTM ↔ BC Albers grid with the coordinate setting.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    updateGrid(map, showGrid)
  }, [showGrid, coordFmt])

  // Push the in-progress GPS track to the map.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    const source = map.getSource('track') as maplibregl.GeoJSONSource | undefined
    const parts = splitSegments(trackPoints, trackBreaks).filter((p) => p.length >= 2)
    source?.setData(
      parts.length
        ? {
            type: 'Feature',
            properties: {},
            geometry: { type: 'MultiLineString', coordinates: parts },
          }
        : EMPTY_FC,
    )
  }, [trackPoints, trackBreaks])

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
  // Two points: also the bearing from the first to the second.
  const measureBearing =
    measurePoints.length === 2
      ? ` · ${formatBearing(bearingDeg(measurePoints[0], measurePoints[1]), measurePoints[0])}`
      : ''

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
      {/* Saved areas are served offline by the website's service worker. The
          crew app has none of ours, so there they'd download and never be
          used: offline areas come to it with native packs (plan Phase 0.3). */}
      {!EMBEDDED && (
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
      )}
      {measureMode && (
        <div className="measure-chip">
          <span className="readout">
            {measurePoints.length < 2
              ? 'Tap the map to measure'
              : `${formatDistance(distanceM)}${measureBearing}${measurePoints.length >= 3 ? ` · ${formatArea(areaM2)}` : ''}`}
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
    sizeHa != null &&
      `Size: ${getUnitSettings().area === 'ha' ? `${sizeHa} ha` : formatArea(Number(sizeHa) * 10_000)}`,
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
    paint: {
      'fill-color': ['coalesce', ['get', 'fill'], ['get', 'color']],
      'fill-opacity': ['coalesce', ['get', 'fillOpacity'], DEFAULT_FILL_OPACITY],
    },
  })
  map.addLayer({
    id: 'uf-line',
    type: 'line',
    source: 'user-features',
    filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]],
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['coalesce', ['get', 'width'], DEFAULT_LINE_WIDTH],
    },
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

function setUserFeatureData(map: MlMap, features: UserFeature[], hiddenLayerIds: Set<string>) {
  const source = map.getSource('user-features') as maplibregl.GeoJSONSource | undefined
  source?.setData(featuresToGeoJSON(features.filter((f) => !hiddenLayerIds.has(f.layerId))))
}

type Basemap = 'streets' | 'satellite' | 'none'

/** Plain light grey around a custom map shown on its own, as Avenza does. */
const NO_BASEMAP_COLOR = '#d6d6d1'
let streetsBackground: unknown

function showBasemap(map: MlMap, basemap: Basemap) {
  const streets = basemap === 'streets' ? 'visible' : 'none'
  for (const id of BASEMAP_LAYER_IDS) map.setLayoutProperty(id, 'visibility', streets)
  map.setLayoutProperty('satellite', 'visibility', basemap === 'satellite' ? 'visible' : 'none')
  map.setLayoutProperty('hillshade', 'visibility', basemap === 'none' ? 'none' : 'visible')
  // The style's background layer stays on as the plain ground under a custom map.
  const background = BASEMAP_LAYER_IDS[0]
  streetsBackground ??= map.getPaintProperty(background, 'background-color')
  if (basemap === 'none') {
    map.setLayoutProperty(background, 'visibility', 'visible')
    map.setPaintProperty(background, 'background-color', NO_BASEMAP_COLOR)
  } else {
    map.setPaintProperty(background, 'background-color', streetsBackground)
  }
}

/** Imported maps (GeoPDFs) render below everything else — a data underlay
 * the user's own markup and live layers sit on top of — but above the
 * basemap/terrain, so they go before the first layer this module adds after
 * the base style ('grid-lines' if present). Only visible maps are on the map
 * at all, so dozens of saved maps cost nothing until shown. */
function syncMapLayers(map: MlMap, layers: MapLayer[]) {
  const shown = layers.filter((l) => l.visible && (l.tiles || l.imageUrl))
  const wanted = new Set(shown.map((l) => `raster-${l.id}`))
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith('raster-') && !wanted.has(layer.id)) {
      map.removeLayer(layer.id)
      map.removeSource(layer.id)
    }
  }
  // Top-most first, so each map can go straight under the one above it and
  // the stacking order (newest on top) survives hiding and showing.
  let above = map.getLayer('grid-lines') ? 'grid-lines' : undefined
  for (const l of [...shown].reverse()) {
    const id = `raster-${l.id}`
    // A map re-drawn as tiles (Sharpen) swaps its image source for a tile source.
    if (map.getSource(id) && map.getSource(id)!.type !== (l.tiles ? 'raster' : 'image')) {
      map.removeLayer(id)
      map.removeSource(id)
    }
    if (!map.getSource(id)) {
      if (l.tiles) {
        // Sharp tiles (PMTiles in the phone's storage, see tile-protocol.ts).
        map.addSource(id, {
          type: 'raster',
          tiles: [l.tiles.url],
          tileSize: 512,
          minzoom: l.tiles.minzoom,
          maxzoom: l.tiles.maxzoom,
          bounds: l.tiles.bounds,
        })
      } else {
        const coordinates = l.corners.map(([lng, lat]) => [lng, lat]) as [
          [number, number],
          [number, number],
          [number, number],
          [number, number],
        ]
        map.addSource(id, { type: 'image', url: l.imageUrl!, coordinates })
      }
      map.addLayer(
        {
          id,
          type: 'raster',
          source: id,
          paint: { 'raster-opacity': l.opacity, 'raster-fade-duration': 0 },
        },
        above,
      )
    } else if (map.getPaintProperty(id, 'raster-opacity') !== l.opacity) {
      map.setPaintProperty(id, 'raster-opacity', l.opacity)
    }
    above = id
  }
}

function addGridLayers(map: MlMap) {
  map.addSource('grid', { type: 'geojson', data: EMPTY_FC })
  map.addSource('grid-labels', { type: 'geojson', data: EMPTY_FC })
  map.addLayer({
    id: 'grid-lines',
    type: 'line',
    source: 'grid',
    paint: { 'line-color': '#374151', 'line-width': 0.8, 'line-opacity': 0.55 },
  })
  map.addLayer({
    id: 'grid-refs',
    type: 'symbol',
    source: 'grid-labels',
    layout: {
      'text-field': ['get', 'ref'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#374151',
      'text-opacity': 0.75,
      'text-halo-color': '#ffffff',
      'text-halo-width': 1,
    },
  })
}

function updateGrid(map: MlMap, show: boolean) {
  const lines = map.getSource('grid') as maplibregl.GeoJSONSource | undefined
  const labels = map.getSource('grid-labels') as maplibregl.GeoJSONSource | undefined
  if (!lines || !labels) return
  if (!show) {
    lines.setData(EMPTY_FC)
    labels.setData(EMPTY_FC)
    return
  }
  const grid = buildGrid(map.getBounds(), map.getZoom(), gridSystemFor(getUnitSettings().coords))
  lines.setData(grid.lines)
  labels.setData(grid.labels)
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
