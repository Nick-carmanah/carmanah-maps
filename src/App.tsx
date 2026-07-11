import { useCallback, useEffect, useRef, useState } from 'react'
import MapView from './map/MapView'
import LayerPanel from './components/LayerPanel'
import QrScanner from './components/QrScanner'
import FeatureSheet, { type PhotoThumb } from './components/FeatureSheet'
import { featuresToCsv, featuresToGpx, featuresToKml, shareOrDownload } from './lib/export'
import { FEATURE_COLORS, type UserFeature } from './lib/features'
import { fetchKmlFromUrl, parseImportedFile, type ParsedKml } from './lib/kml'
import { fetchLiveFires, type LiveFires } from './lib/livefires'
import { formatArea, formatDistance, pathLengthMeters, ringAreaSqMeters } from './lib/measure'
import { formatDuration, trackStats, useTrackRecorder } from './hooks/useTrackRecorder'
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
      opts: { label?: string; color?: string } = {},
    ) => {
      const label = opts.label ?? { pin: 'Pin', line: 'Line', area: 'Area' }[kind]
      const count = userFeatures.filter((f) => f.name.startsWith(label)).length + 1
      const feature: UserFeature = {
        id: crypto.randomUUID(),
        kind,
        name: `${label} ${count}`,
        notes,
        color: opts.color ?? FEATURE_COLORS[0],
        coordinates,
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
        `avg ${stats.avgSpeedKmh.toFixed(1)} km/h`,
        stats.elevGainM != null ? `+${Math.round(stats.elevGainM)} m gain` : null,
        as === 'area' ? formatArea(ringAreaSqMeters(positions)) : null,
      ]
        .filter(Boolean)
        .join(' · ')
      createFeature(as, positions, notes, { label: 'Track', color: '#38bdf8' })
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
    async (format: 'kml' | 'gpx' | 'csv') => {
      if (!userFeatures.length) {
        showToast('Nothing to export yet — drop a pin or draw something first', true)
        return
      }
      const stamp = new Date().toISOString().slice(0, 10)
      const exports = {
        kml: [featuresToKml(userFeatures), 'application/vnd.google-earth.kml+xml'],
        gpx: [featuresToGpx(userFeatures), 'application/gpx+xml'],
        csv: [featuresToCsv(userFeatures), 'text/csv'],
      } as const
      const [content, mime] = exports[format]
      const result = await shareOrDownload(`carmanah-maps-${stamp}.${format}`, mime, content)
      showToast(result === 'shared' ? 'Shared' : `Downloaded .${format} file`)
    },
    [userFeatures, showToast],
  )

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
        <button
          className={`btn${track.phase === 'recording' ? ' active recording' : ''}`}
          onClick={() => {
            if (track.phase === 'recording') track.stop()
            else if (track.phase === 'idle') {
              setPinMode(false)
              setMeasuring(false)
              track.start()
            }
          }}
          title="Record a GPS track"
        >
          {track.phase === 'recording' ? '⏹ Stop' : '⏺ Track'}
        </button>
        <button
          className={`btn${pinMode ? ' active' : ''}`}
          onClick={() => {
            setMeasuring(false)
            setPinMode((p) => !p)
          }}
          title="Tap the map to drop a pin"
        >
          📍 Pin
        </button>
        <button
          className={`btn${measuring ? ' active' : ''}`}
          onClick={() => {
            setPinMode(false)
            setMeasuring((m) => !m)
          }}
        >
          Measure
        </button>
        <button
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          title="Import KML, KMZ, GPX, or zipped shapefile"
        >
          Import
        </button>
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
          trackPoints={track.points.map((p) => p.position)}
          navLine={
            nav.position && navTarget ? [nav.position, navTargetPosition(navTarget)] : null
          }
          pinMode={pinMode}
          onDropPin={handleDropPin}
          onEditFeature={setEditingId}
          onNotify={showToast}
        />
        <LayerPanel
          overlays={overlays}
          hiddenIds={hiddenIds}
          onToggle={handleToggle}
          onRemove={handleRemove}
          onFocus={focusOverlay}
          liveEnabled={liveEnabled}
          liveFetchedAt={liveData?.fetchedAt ?? null}
          liveRefreshing={liveRefreshing}
          onToggleLive={toggleLive}
          onRefreshLive={refreshLiveFires}
          livePerimetersEnabled={livePerimeters}
          onToggleLivePerimeters={toggleLivePerimeters}
          userFeatures={userFeatures}
          onEditFeature={setEditingId}
          onFocusFeature={focusOverlay}
          onExport={handleExport}
        />
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
                {stats.avgSpeedKmh > 0 && ` · ${stats.avgSpeedKmh.toFixed(1)} km/h`}
                {stats.elevGainM != null && ` · +${Math.round(stats.elevGainM)} m`}
              </span>
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

      {toast && <div className={`toast${toast.isError ? ' error' : ''}`}>{toast.message}</div>}
    </div>
  )
}
