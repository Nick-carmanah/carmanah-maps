import { useCallback, useEffect, useRef, useState } from 'react'
import MapView from './map/MapView'
import LayerPanel from './components/LayerPanel'
import QrScanner from './components/QrScanner'
import FeatureSheet, { type PhotoThumb } from './components/FeatureSheet'
import {
  featuresToCsv,
  featuresToGpx,
  featuresToKml,
  featuresToKmz,
  shareOrDownload,
} from './lib/export'
import { FEATURE_COLORS, featureLayer, type UserFeature } from './lib/features'
import type { ExportFormat } from './components/LayerPanel'
import { fetchKmlFromUrl, parseImportedFile, type ParsedKml } from './lib/kml'
import { fetchLiveFires, type LiveFires } from './lib/livefires'
import {
  formatArea,
  formatDistance,
  formatSpeed,
  getUnits,
  pathLengthMeters,
  ringAreaSqMeters,
  setUnits,
  type Units,
} from './lib/measure'
import { formatDuration, trackStats, useTrackRecorder } from './hooks/useTrackRecorder'
import { conventionActive, buildConventionName, getProfile, saveProfile } from './lib/naming'
import { navTargetPosition, useNavigation } from './hooks/useNavigation'
import { useGeofences } from './hooks/useGeofences'
import {
  deleteFeature,
  deleteOverlay,
  deletePhoto,
  deletePhotosForFeature,
  getCached,
  listFeatures,
  listOverlays,
  listPhotos,
  requestPersistentStorage,
  saveFeature,
  saveOverlay,
  savePhoto,
  setCached,
  type Overlay,
} from './lib/store'
import type { Position } from 'geojson'

const LIVE_CACHE_KEY = 'livefires'
const LIVE_ENABLED_KEY = 'carmanah-live-enabled'
const LIVE_STALE_MS = 15 * 60 * 1000

interface Toast {
  message: string
  isError: boolean
}

export default function App() {
  const [overlays, setOverlays] = useState<Overlay[]>([])
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
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
  const [pinMode, setPinMode] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const track = useTrackRecorder((m, e) => showToastRef.current(m, e))
  const showToastRef = useRef<(m: string, e?: boolean) => void>(() => {})
  const [navTargetId, setNavTargetId] = useState<string | null>(null)
  const [photos, setPhotos] = useState<PhotoThumb[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profile, setProfile] = useState(getProfile)
  const [units, setUnitsState] = useState<Units>(getUnits)
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set())
  const [gridOn, setGridOn] = useState(() => localStorage.getItem('carmanah-grid') === '1')
  const [toolsOpen, setToolsOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [basemap, setBasemap] = useState<'streets' | 'satellite'>(
    () => (localStorage.getItem('carmanah-basemap') as 'streets' | 'satellite') || 'streets',
  )
  const [searchNonce, setSearchNonce] = useState(0)
  const navTarget = userFeatures.find((f) => f.id === navTargetId) ?? null
  const nav = useNavigation(navTarget, (m, e) => showToastRef.current(m, e))
  useGeofences(userFeatures, (m) => showToastRef.current(`⚠️ ${m}`, true))
  const [toast, setToast] = useState<Toast | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    requestPersistentStorage()
    listFeatures().then(setUserFeatures)
    listOverlays().then((stored) => {
      setOverlays(stored)
      // Deep link: maps.carmanahwildfire.com?kml=<url> imports on open, so a
      // fire QR scanned with the phone's native camera can land directly here.
      const kmlParam = new URLSearchParams(location.search).get('kml')
      if (kmlParam) {
        history.replaceState(null, '', location.pathname)
        if (stored.some((o) => o.sourceUrl === kmlParam)) return
        showToast('Downloading map…')
        fetchKmlFromUrl(kmlParam)
          .then((parsed) => addOverlay(parsed, kmlParam))
          .catch((err) => showToast((err as Error).message, true))
      }
    })
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

  const addOverlay = useCallback(
    async (parsed: ParsedKml, sourceUrl?: string) => {
      const overlay: Overlay = {
        id: crypto.randomUUID(),
        name: parsed.name,
        addedAt: Date.now(),
        sourceUrl,
        geojson: parsed.geojson,
      }
      await saveOverlay(overlay)
      setOverlays((prev) => [overlay, ...prev])
      focusOverlay(overlay.id)
      showToast(`Added "${overlay.name}" — saved for offline use`)
    },
    [focusOverlay, showToast],
  )

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return
      for (const file of Array.from(files)) {
        try {
          await addOverlay(await parseImportedFile(file))
        } catch (err) {
          showToast(`${file.name}: ${(err as Error).message}`, true)
        }
      }
    },
    [addOverlay, showToast],
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
        await addOverlay(await fetchKmlFromUrl(text), text)
      } catch (err) {
        showToast((err as Error).message, true)
      }
    },
    [addOverlay, showToast],
  )

  const handleRemove = useCallback(async (id: string) => {
    await deleteOverlay(id)
    setOverlays((prev) => prev.filter((o) => o.id !== id))
  }, [])

  // ---- User features (pins, drawn lines/areas) ----

  const createFeature = useCallback(
    async (
      kind: UserFeature['kind'],
      coordinates: Position | Position[],
      notes = '',
      opts: { label?: string; color?: string; layer?: string; times?: number[] } = {},
    ) => {
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
        color: opts.color ?? FEATURE_COLORS[0],
        coordinates,
        layer: opts.layer,
        times: opts.times,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await saveFeature(feature)
      setUserFeatures((prev) => [...prev, feature])
      setEditingId(feature.id)
      return feature
    },
    [userFeatures],
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
      const notes = [
        formatDistance(stats.distanceM),
        formatDuration(stats.durationMs),
        `avg ${formatSpeed(stats.avgSpeedKmh)}`,
        stats.elevGainM != null ? `+${Math.round(stats.elevGainM)} m gain` : null,
        as === 'area' ? formatArea(ringAreaSqMeters(positions)) : null,
      ]
        .filter(Boolean)
        .join(' · ')
      createFeature(as, positions, notes, {
        label: 'Track',
        color: '#38bdf8',
        layer: as === 'area' ? 'Areas' : 'Tracks',
        times: as === 'line' ? track.points.map((p) => p.time) : undefined,
      })
      track.discard()
    },
    [track, createFeature, showToast],
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
    async (format: ExportFormat, layer?: string) => {
      const scoped = layer
        ? userFeatures.filter((f) => featureLayer(f) === layer)
        : userFeatures
      if (!scoped.length) {
        showToast('Nothing to export yet — drop a pin or draw something first', true)
        return
      }
      const stamp = new Date().toISOString().slice(0, 10)
      const slug = layer ? `-${layer.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : ''
      const filename = `carmanah-maps${slug}-${stamp}.${format}`
      const docName = layer ?? 'Carmanah Maps export'
      let content: string | Blob
      let mime: string
      if (format === 'kmz') {
        // Photos travel with the share.
        const photosByFeature = new Map<string, Blob[]>()
        for (const f of scoped) {
          const stored = await listPhotos(f.id)
          if (stored.length) photosByFeature.set(f.id, stored.map((p) => p.blob))
        }
        content = await featuresToKmz(scoped, photosByFeature, docName)
        mime = 'application/vnd.google-earth.kmz'
      } else if (format === 'kml') {
        content = featuresToKml(scoped, docName)
        mime = 'application/vnd.google-earth.kml+xml'
      } else if (format === 'gpx') {
        content = featuresToGpx(scoped)
        mime = 'application/gpx+xml'
      } else {
        content = featuresToCsv(scoped)
        mime = 'text/csv'
      }
      const result = await shareOrDownload(filename, mime, content)
      showToast(
        result === 'shared'
          ? `Shared ${layer ?? 'all data'}`
          : `Downloaded ${filename}`,
      )
    },
    [userFeatures, showToast],
  )

  const handleToggleLayer = useCallback((name: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const handleToggleGrid = useCallback(() => {
    setGridOn((prev) => {
      localStorage.setItem('carmanah-grid', prev ? '0' : '1')
      return !prev
    })
  }, [])

  const handleToggle = useCallback((id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
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
        <h1>
          <span className="flame">🔥</span>Carmanah Maps
        </h1>
        <button className="btn primary" onClick={() => setScanning(true)}>
          Scan fire QR
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".kml,.kmz,.gpx,.zip,.shp"
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
          overlays={overlays}
          hiddenIds={hiddenIds}
          focusRequest={focusRequest}
          measureMode={measuring}
          onExitMeasure={() => setMeasuring(false)}
          onSaveMeasure={handleSaveMeasure}
          liveFires={liveEnabled ? liveData : null}
          showLivePerimeters={livePerimeters}
          userFeatures={userFeatures}
          hiddenLayers={hiddenLayers}
          showGrid={gridOn}
          trackPoints={track.points.map((p) => p.position)}
          navLine={
            nav.position && navTarget ? [nav.position, navTargetPosition(navTarget)] : null
          }
          pinMode={pinMode}
          onDropPin={handleDropPin}
          onEditFeature={setEditingId}
          onNotify={showToast}
          units={units}
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
              overlays={overlays}
              hiddenIds={hiddenIds}
              onToggle={handleToggle}
              onRemove={handleRemove}
              onFocus={(id) => {
                setLayersOpen(false)
                focusOverlay(id)
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
              userFeatures={userFeatures}
              hiddenLayers={hiddenLayers}
              onToggleLayer={handleToggleLayer}
              onEditFeature={(id) => {
                setLayersOpen(false)
                setEditingId(id)
              }}
              onFocusFeature={(id) => {
                setLayersOpen(false)
                focusOverlay(id)
              }}
              onExport={handleExport}
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
                    icon: track.phase === 'recording' ? '⏹' : '⏺',
                    label:
                      track.phase === 'recording' ? 'Stop GPS track' : 'Record GPS track',
                    action: () => {
                      if (track.phase === 'recording') track.stop()
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
                  {
                    icon: '📂',
                    label: 'Import KML, GPX, or shapefile',
                    action: () => fileInputRef.current?.click(),
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
                {formatDistance(stats.distanceM)} · {formatDuration(stats.durationMs)}
                {stats.avgSpeedKmh > 0 && ` · ${formatSpeed(stats.avgSpeedKmh)}`}
                {stats.elevGainM != null && ` · +${Math.round(stats.elevGainM)} m`}
              </span>
              {track.phase === 'recording' && (
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
              layerNames={[...new Set(userFeatures.map(featureLayer))]}
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
                {formatDistance(nav.distanceM)} · {Math.round(nav.bearing ?? 0)}°T
                {nav.etaS != null && ` · ETA ${formatDuration(nav.etaS * 1000)}`}
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
            <span className="sheet-title">Profile</span>
            <button className="btn" onClick={() => setSettingsOpen(false)}>
              Done
            </button>
          </div>
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
          <div className="settings-fields">
            <label>
              Units
              <span className="units-toggle">
                {(['metric', 'imperial'] as const).map((u) => (
                  <button
                    key={u}
                    className={`btn small${units === u ? ' active' : ''}`}
                    onClick={() => {
                      setUnits(u)
                      setUnitsState(u)
                    }}
                  >
                    {u === 'metric' ? 'Metric (m · km · ha)' : 'Imperial (ft · mi · ac)'}
                  </button>
                ))}
              </span>
            </label>
          </div>
          <div className="settings-hint">
            {conventionActive()
              ? `New features will be auto-named like: ${buildConventionName('Edge')}`
              : 'Set a callsign and/or fire number to auto-name features the BCWS way (What_When_Where_Who).'}
          </div>
        </div>
      )}

      {toast && <div className={`toast${toast.isError ? ' error' : ''}`}>{toast.message}</div>}
    </div>
  )
}
