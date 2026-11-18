import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import MapView from './map/MapView'
import LayerPanel from './components/LayerPanel'
import LayerTree from './components/LayerTree'
import LayerSheet from './components/LayerSheet'
import ExportSheet from './components/ExportSheet'
import QrScanner from './components/QrScanner'
import SendAreaSheet from './components/SendAreaSheet'
import { printableLayers } from './map/print-render'
import FeatureSheet, { type PhotoThumb } from './components/FeatureSheet'
import UnitsSettings from './components/UnitsSettings'
import MapsLibrary from './components/MapsLibrary'
import { ImportChip, PagePicker } from './components/PagePicker'
import { buildExport, shareOrDownload, type ExportOptions } from './lib/export'
import { DEFAULT_LAYERS, featuresToGeoJSON, type UserFeature } from './lib/features'
import { fetchImportFromUrl, parseImportedFile } from './lib/importers'
import {
  childLayers,
  DEFAULT_LAYER_COLOR,
  hiddenLayerIds,
  newLayer,
  subtreeIds,
  type ImportResult,
  type Layer,
} from './lib/layers'
import { commitImport, deleteLayersAndFeatures, loadMyData } from './lib/mydata'
import { symbolPng } from './lib/symbols'
import { boundsOf } from './lib/geo'
import { fetchLiveFires, type LiveFires } from './lib/livefires'
import { pathLengthMeters, ringAreaSqMeters } from './lib/measure'
import {
  formatAltitude,
  formatArea,
  formatBearing,
  formatDistance,
  formatPace,
  formatSpeed,
} from './lib/units'
import { useUnitSettings } from './hooks/useUnitSettings'
import {
  formatDuration,
  trackSegmentStarts,
  trackStats,
  useTrackRecorder,
} from './hooks/useTrackRecorder'
import { useGpsTools } from './hooks/useGpsTools'
import { conventionActive, buildConventionName, getProfile, saveProfile } from './lib/naming'
import { readMapsContext } from './lib/storage/owner'
import { EMBEDDED } from './lib/embedded'
import { navTargetPosition, useNavigation } from './hooks/useNavigation'
import { useGeofences } from './hooks/useGeofences'
import { useMapsLibrary } from './hooks/useMapsLibrary'
import {
  deleteFeature,
  deletePhoto,
  deletePhotosForFeature,
  getCached,
  listPhotos,
  requestPersistentStorage,
  saveFeature,
  saveLayer,
  savePhoto,
  setCached,
  writeBatch,
} from './lib/store'
import type { Position } from 'geojson'
import type { LngLatBoundsLike } from 'maplibre-gl'

const LIVE_CACHE_KEY = 'livefires'
const LIVE_ENABLED_KEY = 'carmanah-live-enabled'
const LIVE_STALE_MS = 15 * 60 * 1000

interface Toast {
  message: string
  isError: boolean
}

export default function App() {
  const [scanning, setScanning] = useState(false)
  const [measuring, setMeasuring] = useState(false)
  const [liveEnabled, setLiveEnabled] = useState(
    () => localStorage.getItem(LIVE_ENABLED_KEY) === '1',
  )
  const [liveData, setLiveData] = useState<LiveFires | null>(null)
  const [liveRefreshing, setLiveRefreshing] = useState(false)
  const [livePerimeters, setLivePerimeters] = useState(
    () => localStorage.getItem('carmanah-live-perims') !== '0',
  )
  const [userFeatures, setUserFeatures] = useState<UserFeature[]>([])
  const userFeaturesRef = useRef<UserFeature[]>([])
  userFeaturesRef.current = userFeatures
  const [layers, setLayers] = useState<Layer[]>([])
  const layersRef = useRef<Layer[]>([])
  layersRef.current = layers
  const hiddenLayers = useMemo(() => hiddenLayerIds(layers), [layers])
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null)
  const [exportLayerIds, setExportLayerIds] = useState<string[] | null>(null)
  const [exporting, setExporting] = useState(false)
  const [pinMode, setPinMode] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const track = useTrackRecorder((m, e) => showToastRef.current(m, e))
  const showToastRef = useRef<(m: string, e?: boolean) => void>(() => {})
  const maps = useMapsLibrary((m, e) => showToastRef.current(m, e))
  const [mapsOpen, setMapsOpen] = useState(false)
  const [navTargetId, setNavTargetId] = useState<string | null>(null)
  const [photos, setPhotos] = useState<PhotoThumb[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profile, setProfile] = useState(getProfile)
  // Every number on screen follows these; re-render when one changes.
  useUnitSettings()
  const [gridOn, setGridOn] = useState(() => localStorage.getItem('carmanah-grid') === '1')
  const [toolsOpen, setToolsOpen] = useState(false)
  const [sendAreaOpen, setSendAreaOpen] = useState(false)
  const [mainMap, setMainMap] = useState<MlMap | null>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  const [basemap, setBasemap] = useState<'streets' | 'satellite'>(
    () => (localStorage.getItem('carmanah-basemap') as 'streets' | 'satellite') || 'streets',
  )
  const [searchNonce, setSearchNonce] = useState(0)
  const navTarget = userFeatures.find((f) => f.id === navTargetId) ?? null
  const nav = useNavigation(navTarget, (m, e) => showToastRef.current(m, e))
  useGeofences(userFeatures, (m) => showToastRef.current(`⚠️ ${m}`, true))
  const [toast, setToast] = useState<Toast | null>(null)
  const sendAreaLayers = useMemo(
    () =>
      sendAreaOpen
        ? printableLayers({
            layers,
            features: userFeatures,
            liveFires: liveEnabled ? liveData : null,
            showLivePerimeters: livePerimeters,
          })
        : null,
    [sendAreaOpen, layers, userFeatures, liveEnabled, liveData, livePerimeters],
  )
  const [focusRequest, setFocusRequest] = useState<{
    id: string
    nonce: number
    bounds?: LngLatBoundsLike | null
  } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    requestPersistentStorage()
    // Layers + features (the first run moves old data into layers).
    loadMyData()
      .then((data) => {
        setLayers(data.layers)
        setUserFeatures(data.features)
        // Deep link: maps.carmanahwildfire.com?kml=<url> imports on open, so a
        // fire QR scanned with the phone's native camera can land directly here.
        const kmlParam = new URLSearchParams(location.search).get('kml')
        if (kmlParam) {
          history.replaceState(null, '', location.pathname)
          if (data.layers.some((l) => l.source?.url === kmlParam)) return
          showToast('Downloading map…')
          fetchImportFromUrl(kmlParam)
            .then((result) => handleImport(result))
            .catch((err) => showToast((err as Error).message, true))
        }
      })
      .catch((err) => showToast(`Could not load your saved data: ${(err as Error).message}`, true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showToast = useCallback((message: string, isError = false) => {
    clearTimeout(toastTimer.current)
    setToast({ message, isError })
    toastTimer.current = setTimeout(() => setToast(null), isError ? 6000 : 3500)
  }, [])
  showToastRef.current = showToast

  const refreshLiveFires = useCallback(async () => {
    setLiveRefreshing(true)
    try {
      const data = await fetchLiveFires()
      setLiveData(data)
      await setCached(LIVE_CACHE_KEY, data)
      const active = data.points.features.length
      showToast(`Live fires updated — ${active} active fires in BC`)
    } catch {
      showToast('Could not reach BC Wildfire Service — showing last saved data', true)
    } finally {
      setLiveRefreshing(false)
    }
  }, [showToast])

  // Restore cached live-fire data; refresh if the layer is on and data is stale.
  useEffect(() => {
    getCached<LiveFires>(LIVE_CACHE_KEY).then((cached) => {
      if (cached) setLiveData(cached)
      if (
        liveEnabled &&
        navigator.onLine &&
        (!cached || Date.now() - cached.fetchedAt > LIVE_STALE_MS)
      ) {
        refreshLiveFires()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleLivePerimeters = useCallback(() => {
    setLivePerimeters((prev) => {
      localStorage.setItem('carmanah-live-perims', prev ? '0' : '1')
      return !prev
    })
  }, [])

  const toggleLive = useCallback(() => {
    setLiveEnabled((prev) => {
      const next = !prev
      localStorage.setItem(LIVE_ENABLED_KEY, next ? '1' : '0')
      if (next && !liveData && navigator.onLine) refreshLiveFires()
      return next
    })
  }, [liveData, refreshLiveFires])

  const focusOverlay = useCallback((id: string) => {
    setFocusRequest({ id, nonce: Date.now() })
  }, [])

  /** Fit the map to everything in a layer and its sublayers. */
  const focusLayer = useCallback((id: string) => {
    const ids = subtreeIds(layersRef.current, id)
    const feats = userFeaturesRef.current.filter((f) => ids.has(f.layerId))
    const bounds = feats.length ? boundsOf(featuresToGeoJSON(feats)) : null
    if (bounds) setFocusRequest({ id, nonce: Date.now(), bounds })
  }, [])

  /** Save an import (layers, features, photos, icons) and show it. */
  const handleImport = useCallback(
    async (result: ImportResult) => {
      // New top-level layers go below the existing ones.
      let order = Math.max(-1, ...childLayers(layersRef.current, undefined).map((l) => l.order)) + 1
      for (const l of result.layers) if (!l.parentId) l.order = order++
      await commitImport(result)
      setLayers((prev) => [...prev, ...result.layers])
      setUserFeatures((prev) => [...prev, ...result.features])
      const feats = result.features
      const bounds = feats.length ? boundsOf(featuresToGeoJSON(feats)) : null
      if (bounds) setFocusRequest({ id: result.layers[0]?.id ?? '', nonce: Date.now(), bounds })
      const extras = [
        result.photos.length && `${result.photos.length} photo${result.photos.length === 1 ? '' : 's'}`,
        result.layers.length > 1 && `${result.layers.length} layers`,
      ].filter(Boolean)
      const warn = result.warnings.length ? ` (${result.warnings.join('; ')})` : ''
      showToast(
        `Added "${result.name}": ${feats.length} feature${feats.length === 1 ? '' : 's'}` +
          (extras.length ? `, ${extras.join(', ')}` : '') +
          ` — saved for offline use${warn}`,
        result.warnings.length > 0,
      )
    },
    [showToast],
  )

  /** Show a library map (if hidden) and fly to it. */
  const showMap = useCallback(
    (id: string) => {
      if (maps.maps.find((m) => m.id === id)?.visible === false) maps.updateMap(id, { visible: true })
      focusOverlay(id)
    },
    [maps, focusOverlay],
  )

  const handlePdfImport = useCallback(
    async (file: File) => {
      const added = await maps.importPdf(file)
      if (added.length) focusOverlay(added[added.length - 1].id)
    },
    [maps, focusOverlay],
  )

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return
      for (const file of Array.from(files)) {
        try {
          if (file.name.toLowerCase().endsWith('.pdf')) {
            await handlePdfImport(file)
          } else {
            await handleImport(await parseImportedFile(file))
          }
        } catch (err) {
          showToast(`${file.name}: ${(err as Error).message}`, true)
        }
      }
    },
    [handleImport, handlePdfImport, showToast],
  )

  const handleQrResult = useCallback(
    async (text: string) => {
      setScanning(false)
      if (!/^https?:\/\//i.test(text)) {
        showToast(`QR code doesn't contain a link (got: ${text.slice(0, 60)})`, true)
        return
      }
      showToast('Downloading map…')
      try {
        await handleImport(await fetchImportFromUrl(text))
      } catch (err) {
        showToast((err as Error).message, true)
      }
    },
    [handleImport, showToast],
  )

  // ---- Layers ----

  /** Id of the user's own top-level layer with this name (never an imported
   * one, so imports stay as they arrived); creates it if needed. */
  const ensureLayer = useCallback((name: string): string => {
    const existing = layersRef.current.find((l) => !l.parentId && !l.source && l.name === name)
    if (existing) return existing.id
    const roots = childLayers(layersRef.current, undefined)
    const layer = newLayer(name, { order: Math.max(-1, ...roots.map((l) => l.order)) + 1 })
    layersRef.current = [...layersRef.current, layer]
    setLayers(layersRef.current)
    saveLayer(layer)
    return layer.id
  }, [])

  const handleLayerChange = useCallback((layer: Layer) => {
    setLayers((prev) => prev.map((l) => (l.id === layer.id ? layer : l)))
    saveLayer(layer)
  }, [])

  const handleToggleLayer = useCallback(
    (id: string) => {
      const layer = layersRef.current.find((l) => l.id === id)
      if (layer) handleLayerChange({ ...layer, visible: !layer.visible, updatedAt: Date.now() })
    },
    [handleLayerChange],
  )

  const handleNewLayer = useCallback(() => {
    let n = 1
    while (layersRef.current.some((l) => l.name === `Layer ${n}`)) n++
    setEditingLayerId(ensureLayer(`Layer ${n}`))
  }, [ensureLayer])

  const handleRenameField = useCallback((layerId: string, from: string, to: string) => {
    const layer = layersRef.current.find((l) => l.id === layerId)
    if (!layer) return
    const next = {
      ...layer,
      schema: layer.schema.map((f) => (f.name === from ? { ...f, name: to } : f)),
      updatedAt: Date.now(),
    }
    const changed: UserFeature[] = []
    setUserFeatures((prev) =>
      prev.map((f) => {
        if (f.layerId !== layerId || !f.attributes?.some((a) => a.k === from)) return f
        const g = {
          ...f,
          attributes: f.attributes.map((a) => (a.k === from ? { k: to, v: a.v } : a)),
          updatedAt: Date.now(),
        }
        changed.push(g)
        return g
      }),
    )
    setLayers((prev) => prev.map((l) => (l.id === layerId ? next : l)))
    writeBatch({ layers: [next], features: changed })
  }, [])

  const handleDeleteLayer = useCallback(
    async (id: string) => {
      const ids = subtreeIds(layersRef.current, id)
      const featureIds = userFeaturesRef.current.filter((f) => ids.has(f.layerId)).map((f) => f.id)
      await deleteLayersAndFeatures([...ids], featureIds)
      const gone = new Set(featureIds)
      setLayers((prev) => prev.filter((l) => !ids.has(l.id)))
      setUserFeatures((prev) => prev.filter((f) => !gone.has(f.id)))
      setEditingLayerId(null)
      setEditingId((cur) => (cur && gone.has(cur) ? null : cur))
      setNavTargetId((cur) => (cur && gone.has(cur) ? null : cur))
    },
    [],
  )

  // ---- User features (pins, drawn lines/areas) ----

  const createFeature = useCallback(
    async (
      kind: UserFeature['kind'],
      coordinates: Position | Position[],
      notes = '',
      opts: {
        label?: string
        color?: string
        layer?: string
        /** An existing layer to use instead of `layer` (by name). */
        layerId?: string | null
        times?: number[]
        segmentStarts?: number[]
        attributes?: { k: string; v: string }[]
      } = {},
    ) => {
      const layerId =
        opts.layerId && layersRef.current.some((l) => l.id === opts.layerId)
          ? opts.layerId
          : ensureLayer(opts.layer ?? DEFAULT_LAYERS[kind])
      const layer = layersRef.current.find((l) => l.id === layerId)
      const label = opts.label ?? { pin: 'Pin', line: 'Line', area: 'Area' }[kind]
      // Workshop naming convention (What_When_Where_Who) once a profile is set.
      let name: string
      if (conventionActive()) {
        const base = buildConventionName(label)
        const clashes = userFeatures.filter((f) => f.name.startsWith(base)).length
        name = clashes ? `${base}_${clashes + 1}` : base
      } else {
        name = `${label} ${userFeatures.filter((f) => f.name.startsWith(label)).length + 1}`
      }
      const feature: UserFeature = {
        id: crypto.randomUUID(),
        kind,
        name,
        notes,
        color: opts.color ?? layer?.style.color ?? DEFAULT_LAYER_COLOR,
        coordinates,
        layerId,
        ...(kind !== 'pin' && layer?.style.width !== undefined ? { width: layer.style.width } : {}),
        ...(kind === 'pin' && layer?.style.symbol ? { symbol: layer.style.symbol } : {}),
        times: opts.times,
        ...(opts.segmentStarts?.length ? { segmentStarts: opts.segmentStarts } : {}),
        ...(opts.attributes?.length ? { attributes: opts.attributes } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await saveFeature(feature)
      setUserFeatures((prev) => [...prev, feature])
      setEditingId(feature.id)
      return feature
    },
    [userFeatures, ensureLayer],
  )

  const handleDropPin = useCallback(
    (position: Position) => {
      setPinMode(false)
      createFeature('pin', position)
    },
    [createFeature],
  )

  const handleSaveMeasure = useCallback(
    (kind: 'line' | 'area', points: Position[]) => {
      setMeasuring(false)
      const stat =
        kind === 'line'
          ? formatDistance(pathLengthMeters(points))
          : formatArea(ringAreaSqMeters(points))
      createFeature(kind, points, stat)
    },
    [createFeature],
  )

  const handleSaveTrack = useCallback(
    (as: 'line' | 'area') => {
      const positions = track.points.map((p) => p.position)
      if (as === 'area' && positions.length < 3) {
        showToast('Need at least 3 points to make an area', true)
        return
      }
      const stats = trackStats(track.points)
      // A snapshot in the units chosen at save time (notes are the crew's text).
      const notes = [
        formatDistance(stats.distanceM),
        formatDuration(stats.durationMs),
        `avg ${formatSpeed(stats.avgSpeedKmh / 3.6)}`,
        formatPace(stats.durationMs, stats.distanceM),
        stats.elevGainM != null ? `+${formatAltitude(stats.elevGainM)} gain` : null,
        as === 'area' ? formatArea(ringAreaSqMeters(positions)) : null,
      ]
        .filter(Boolean)
        .join(' · ')
      createFeature(as, positions, notes, {
        label: 'Track',
        color: '#38bdf8',
        layer: as === 'area' ? 'Areas' : 'Tracks',
        times: as === 'line' ? track.points.map((p) => p.time) : undefined,
        // Pauses stay gaps in the saved track.
        segmentStarts: as === 'line' ? trackSegmentStarts(track.points) : undefined,
      })
      track.discard()
    },
    [track, createFeature, showToast],
  )

  const gpsTools = useGpsTools({
    map: mainMap,
    layers,
    features: userFeatures,
    ensureLayer,
    createPin: (position, notes, opts) => createFeature('pin', position, notes, opts),
    onPlotted: (features) => {
      setUserFeatures((prev) => [...prev, ...features])
      const bounds = boundsOf(featuresToGeoJSON(features))
      if (bounds) setFocusRequest({ id: features[0].id, nonce: Date.now(), bounds })
    },
    notify: showToast,
    onBeforeTool: () => {
      setPinMode(false)
      setMeasuring(false)
    },
  })

  // The live track as the map draws it: positions, and where it resumed.
  const liveTrack = useMemo(
    () => ({
      positions: track.points.map((p) => p.position),
      breaks: trackSegmentStarts(track.points),
    }),
    [track.points],
  )

  const handleFeatureChange = useCallback((feature: UserFeature) => {
    setUserFeatures((prev) => prev.map((f) => (f.id === feature.id ? feature : f)))
    saveFeature(feature)
  }, [])

  const handleFeatureDelete = useCallback(async (id: string) => {
    await deleteFeature(id)
    await deletePhotosForFeature(id)
    setUserFeatures((prev) => prev.filter((f) => f.id !== id))
    setEditingId(null)
  }, [])

  // Load photo thumbnails when the edit sheet opens; revoke URLs on close.
  useEffect(() => {
    if (!editingId) {
      setPhotos([])
      return
    }
    let urls: string[] = []
    listPhotos(editingId).then((stored) => {
      urls = stored.map((p) => URL.createObjectURL(p.blob))
      setPhotos(stored.map((p, i) => ({ id: p.id, url: urls[i] })))
    })
    return () => urls.forEach((u) => URL.revokeObjectURL(u))
  }, [editingId])

  const handleAddPhotos = useCallback(
    async (files: FileList) => {
      if (!editingId) return
      for (const file of Array.from(files)) {
        const photo = {
          id: crypto.randomUUID(),
          featureId: editingId,
          blob: file,
          createdAt: Date.now(),
        }
        await savePhoto(photo)
        setPhotos((prev) => [...prev, { id: photo.id, url: URL.createObjectURL(file) }])
      }
    },
    [editingId],
  )

  const handleDeletePhoto = useCallback(async (id: string) => {
    await deletePhoto(id)
    setPhotos((prev) => prev.filter((p) => p.id !== id))
  }, [])

  const handleExport = useCallback(
    async (opts: ExportOptions) => {
      setExporting(true)
      try {
        const chosen = new Set(opts.layerIds)
        const scoped = userFeaturesRef.current.filter((f) => chosen.has(f.layerId))
        const photos = new Map<string, Blob[]>()
        if (opts.format === 'kmz' && opts.includePhotos) {
          for (const f of scoped) {
            const stored = await listPhotos(f.id)
            if (stored.length) photos.set(f.id, stored.map((p) => p.blob))
          }
        }
        const file = await buildExport(
          { layers: layersRef.current, features: userFeaturesRef.current, photos, symbolPng },
          opts,
        )
        setExportLayerIds(null)
        const how = await shareOrDownload(file.filename, file.mime, file.content)
        if (how !== 'cancelled') {
          showToast(how === 'shared' ? `Shared ${opts.docName}` : `Downloaded ${file.filename}`)
        }
      } catch (err) {
        showToast(`Export failed: ${(err as Error).message}`, true)
      } finally {
        setExporting(false)
      }
    },
    [showToast],
  )

  /** One-tap share of a layer (and its sublayers) as KMZ with photos. */
  const handleShareLayer = useCallback(
    (id: string) => {
      const layer = layersRef.current.find((l) => l.id === id)
      if (!layer) return
      handleExport({
        format: 'kmz',
        layerIds: [...subtreeIds(layersRef.current, id)],
        includePhotos: true,
        tracksAsLines: false,
        docName: layer.name,
      })
    },
    [handleExport],
  )

  const handleToggleGrid = useCallback(() => {
    setGridOn((prev) => {
      localStorage.setItem('carmanah-grid', prev ? '0' : '1')
      return !prev
    })
  }, [])

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        handleFiles(e.dataTransfer.files)
      }}
    >
      <header className="topbar">
        {/* In the crew app this page has no browser chrome, so it links back. */}
        {EMBEDDED && (
          <a className="btn home-link" href="/" aria-label="Back to the crew app">
            ‹ Home
          </a>
        )}
        <h1>
          <span className="flame">🔥</span>Carmanah Maps
        </h1>
        <button className="btn primary" onClick={() => setScanning(true)}>
          Scan fire QR
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".kml,.kmz,.gpx,.zip,.shp,.csv,.geojson,.json,.pdf"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={pdfInputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </header>

      <div className="map-container">
        <MapView
          mapLayers={maps.layers}
          focusRequest={focusRequest}
          measureMode={measuring}
          onExitMeasure={() => setMeasuring(false)}
          onSaveMeasure={handleSaveMeasure}
          liveFires={liveEnabled ? liveData : null}
          showLivePerimeters={livePerimeters}
          userFeatures={userFeatures}
          hiddenLayerIds={hiddenLayers}
          showGrid={gridOn}
          trackPoints={liveTrack.positions}
          trackBreaks={liveTrack.breaks}
          navLine={
            nav.position && navTarget ? [nav.position, navTargetPosition(navTarget)] : null
          }
          pinMode={pinMode}
          onDropPin={handleDropPin}
          onEditFeature={(id) => {
            setEditingLayerId(null)
            setEditingId(id)
          }}
          onNotify={showToast}
          onMapReady={setMainMap}
          basemap={basemap}
          openSearchNonce={searchNonce}
        />

        <button
          className="fab fab-left"
          onClick={() => setToolsOpen(true)}
          aria-label="Tools"
          title="Tools"
        >
          🛠
        </button>
        <button
          className="fab fab-right"
          onClick={() => setLayersOpen(true)}
          aria-label="Layers"
          title="Layers"
        >
          🗂
        </button>

        {layersOpen && (
          <div className="sheet-wrap">
            <div className="sheet-backdrop" onClick={() => setLayersOpen(false)} />
            <LayerPanel
              mapsCount={maps.maps.length}
              onOpenMaps={() => {
                setLayersOpen(false)
                setMapsOpen(true)
              }}
              liveEnabled={liveEnabled}
              liveFetchedAt={liveData?.fetchedAt ?? null}
              liveRefreshing={liveRefreshing}
              onToggleLive={toggleLive}
              onRefreshLive={refreshLiveFires}
              livePerimetersEnabled={livePerimeters}
              onToggleLivePerimeters={toggleLivePerimeters}
              gridOn={gridOn}
              onToggleGrid={handleToggleGrid}
              basemap={basemap}
              onSetBasemap={(b) => {
                setBasemap(b)
                localStorage.setItem('carmanah-basemap', b)
              }}
              onClose={() => setLayersOpen(false)}
              hasMyData={layers.length > 0}
              myData={
                layers.length > 0 && (
                  <LayerTree
                    layers={layers}
                    features={userFeatures}
                    hiddenLayerIds={hiddenLayers}
                    onToggleLayer={handleToggleLayer}
                    onEditLayer={(id) => {
                      setLayersOpen(false)
                      setEditingId(null)
                      setEditingLayerId(id)
                    }}
                    onShareLayer={handleShareLayer}
                    onFocusLayer={(id) => {
                      setLayersOpen(false)
                      focusLayer(id)
                    }}
                    onEditFeature={(id) => {
                      setLayersOpen(false)
                      setEditingLayerId(null)
                      setEditingId(id)
                    }}
                    onFocusFeature={(id) => {
                      setLayersOpen(false)
                      focusOverlay(id)
                    }}
                    onNewLayer={() => {
                      setLayersOpen(false)
                      setEditingId(null)
                      handleNewLayer()
                    }}
                    onExport={() => {
                      setLayersOpen(false)
                      setExportLayerIds(layers.filter((l) => !hiddenLayers.has(l.id)).map((l) => l.id))
                    }}
                  />
                )
              }
            />
          </div>
        )}

        {sendAreaOpen && sendAreaLayers && (
          <SendAreaSheet
            map={mainMap}
            layers={sendAreaLayers}
            basemap={basemap}
            onClose={() => setSendAreaOpen(false)}
            onNotify={showToast}
          />
        )}

        {mapsOpen && (
          <div className="sheet-wrap">
            <div className="sheet-backdrop" onClick={() => setMapsOpen(false)} />
            <MapsLibrary
              maps={maps.maps}
              currentFolder={maps.defaultFolder}
              storageBackend={maps.storageBackend}
              onClose={() => setMapsOpen(false)}
              onImport={() => pdfInputRef.current?.click()}
              onUpdate={maps.updateMap}
              onRemove={maps.removeMap}
              onZoomTo={(id) => {
                setMapsOpen(false)
                showMap(id)
              }}
              readOriginal={maps.readOriginal}
              onShare={maps.shareFile}
              onSharpen={maps.sharpen}
            />
          </div>
        )}

        {toolsOpen && (
          <div className="sheet-wrap">
            <div className="sheet-backdrop" onClick={() => setToolsOpen(false)} />
            <div className="tool-sheet">
              {(
                [
                  {
                    icon: '📍',
                    label: 'Drop a pin',
                    action: () => {
                      setMeasuring(false)
                      setPinMode(true)
                    },
                  },
                  {
                    icon: '📐',
                    label: 'Draw and measure',
                    action: () => {
                      setPinMode(false)
                      setMeasuring(true)
                    },
                  },
                  {
                    icon: track.phase === 'recording' || track.phase === 'paused' ? '⏹' : '⏺',
                    label:
                      track.phase === 'recording' || track.phase === 'paused'
                        ? 'Stop GPS track'
                        : 'Record GPS track',
                    action: () => {
                      if (track.phase === 'recording' || track.phase === 'paused') track.stop()
                      else if (track.phase === 'idle') {
                        setPinMode(false)
                        setMeasuring(false)
                        track.start()
                      }
                    },
                  },
                  {
                    icon: '🧭',
                    label: 'Find by coordinates or name',
                    action: () => setSearchNonce((n) => n + 1),
                  },
                  ...gpsTools.tools,
                  {
                    icon: '📂',
                    label: 'Import KML/KMZ, GPX, CSV, shapefile or GeoPDF',
                    action: () => fileInputRef.current?.click(),
                  },
                  {
                    icon: '🗺',
                    label: 'Send this area as a map',
                    action: () => {
                      setPinMode(false)
                      setMeasuring(false)
                      setSendAreaOpen(true)
                    },
                  },
                  {
                    icon: '⚙️',
                    label: 'Profile and settings',
                    action: () => setSettingsOpen(true),
                  },
                ] as const
              ).map((tool) => (
                <button
                  key={tool.label}
                  className="tool-row"
                  onClick={() => {
                    setToolsOpen(false)
                    setSendAreaOpen(false)
                    tool.action()
                  }}
                >
                  <span className="tool-icon">{tool.icon}</span>
                  {tool.label}
                </button>
              ))}
              <button className="btn sheet-close-btn" onClick={() => setToolsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>

      {scanning && (
        <QrScanner
          onResult={handleQrResult}
          onClose={() => setScanning(false)}
          onError={(m) => showToast(m, true)}
        />
      )}

      {track.phase !== 'idle' &&
        (() => {
          const stats = trackStats(track.points)
          return (
            <div className="track-chip">
              <span className="readout">
                {track.phase === 'recording' && <span className="rec-dot" />}
                {track.phase === 'paused' && 'Paused · '}
                {formatDistance(stats.distanceM)} · {formatDuration(stats.durationMs)}
                {stats.avgSpeedKmh > 0 && ` · ${formatSpeed(stats.avgSpeedKmh / 3.6)}`}
                {track.phase === 'review' &&
                  formatPace(stats.durationMs, stats.distanceM) &&
                  ` · ${formatPace(stats.durationMs, stats.distanceM)}`}
                {stats.elevGainM != null && ` · +${formatAltitude(stats.elevGainM)}`}
              </span>
              {track.phase === 'recording' && (
                <button className="btn" onClick={track.pause}>
                  ⏸ Pause
                </button>
              )}
              {track.phase === 'paused' && (
                <button className="btn" onClick={track.resume}>
                  ▶ Resume
                </button>
              )}
              {(track.phase === 'recording' || track.phase === 'paused') && (
                <button className="btn" onClick={track.stop}>
                  ⏹ Stop
                </button>
              )}
              {track.phase === 'review' && (
                <>
                  <button className="btn" onClick={() => handleSaveTrack('line')}>
                    Save track
                  </button>
                  <button
                    className="btn"
                    disabled={track.points.length < 3}
                    onClick={() => handleSaveTrack('area')}
                  >
                    Save as area
                  </button>
                  <button className="btn" onClick={track.discard}>
                    Discard
                  </button>
                </>
              )}
            </div>
          )
        })()}

      {editingId &&
        (() => {
          const feature = userFeatures.find((f) => f.id === editingId)
          return feature ? (
            <FeatureSheet
              feature={feature}
              layers={layers}
              onEnsureLayer={ensureLayer}
              photos={photos}
              onAddPhotos={handleAddPhotos}
              onDeletePhoto={handleDeletePhoto}
              onChange={handleFeatureChange}
              onDelete={handleFeatureDelete}
              onNavigate={(id) => {
                setEditingId(null)
                setNavTargetId(id)
              }}
              onClose={() => setEditingId(null)}
            />
          ) : null
        })()}

      {editingLayerId &&
        (() => {
          const layer = layers.find((l) => l.id === editingLayerId)
          if (!layer) return null
          const ids = subtreeIds(layers, layer.id)
          return (
            <LayerSheet
              layer={layer}
              layers={layers}
              featureCount={userFeatures.filter((f) => ids.has(f.layerId)).length}
              onChange={handleLayerChange}
              onRenameField={handleRenameField}
              onDelete={handleDeleteLayer}
              onClose={() => setEditingLayerId(null)}
            />
          )
        })()}

      {exportLayerIds && (
        <ExportSheet
          layers={layers}
          features={userFeatures}
          initialLayerIds={exportLayerIds}
          busy={exporting}
          onExport={handleExport}
          onClose={() => setExportLayerIds(null)}
        />
      )}

      {pinMode && (
        <div className="pin-chip">
          <span>Tap the map to drop a pin</span>
          <button className="btn" onClick={() => setPinMode(false)}>
            Cancel
          </button>
        </div>
      )}

      {navTarget && (
        <div className="nav-chip">
          <span
            className="nav-arrow"
            style={{ transform: `rotate(${(nav.bearing ?? 0) - 90}deg)` }}
            aria-hidden
          >
            ➤
          </span>
          <span className="readout">
            {navTarget.name}
            {nav.distanceM != null ? (
              <>
                {' · '}
                {formatDistance(nav.distanceM)} · {formatBearing(nav.bearing ?? 0, nav.position)}
                {nav.etaS != null && ` · ETA ${formatDuration(nav.etaS * 1000)}`}
                {nav.speedMps != null && ` · ${formatSpeed(nav.speedMps)}`}
              </>
            ) : (
              ' · waiting for GPS…'
            )}
          </span>
          <button className="btn" onClick={() => setNavTargetId(null)}>
            End
          </button>
        </div>
      )}

      {settingsOpen && (
        <div className="feature-sheet settings-sheet">
          <div className="sheet-header">
            <span className="kind-icon">⚙</span>
            <span className="sheet-title">Profile and settings</span>
            <button className="btn" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </div>
          <div className="sheet-scroll">
            <div className="settings-fields">
              <label>
                Callsign
                <input
                  value={profile.callsign}
                  placeholder="e.g. 2P14"
                  onChange={(e) => {
                    const next = { ...profile, callsign: e.target.value.trim() }
                    setProfile(next)
                    saveProfile(next)
                  }}
                />
              </label>
              <label>
                Fire number
                <input
                  value={profile.fireNumber}
                  placeholder="e.g. K61067"
                  onChange={(e) => {
                    const next = { ...profile, fireNumber: e.target.value.trim() }
                    setProfile(next)
                    saveProfile(next)
                  }}
                />
              </label>
            </div>
            <HandOffHint />
            <div className="settings-hint">
              {conventionActive()
                ? `New features will be auto-named like: ${buildConventionName('Edge')}`
                : 'Set a callsign and/or fire number to auto-name features the BCWS way (What_When_Where_Who).'}
            </div>
            <UnitsSettings />
          </div>
        </div>
      )}

      {maps.pendingPick && (
        <PagePicker request={maps.pendingPick.request} onDone={maps.pendingPick.resolve} />
      )}
      {maps.importStatus && !maps.pendingPick && <ImportChip status={maps.importStatus} />}

      {gpsTools.view}

      {toast && <div className={`toast${toast.isError ? ' error' : ''}`}>{toast.message}</div>}
    </div>
  )
}

/** In the crew app: the call sign and fire number it handed over, which names use
 * instead of the fields above (src/lib/naming.ts, namingProfile). */
function HandOffHint() {
  const { callSign, fireNumber } = readMapsContext()
  if (!callSign && !fireNumber) return null
  const parts = [callSign && `call sign ${callSign}`, fireNumber && `fire ${fireNumber}`].filter(Boolean)
  return (
    <div className="settings-hint">
      From the crew app: {parts.join(', ')}. Names use these over the fields above.
    </div>
  )
}
