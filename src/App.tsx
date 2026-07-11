import { useCallback, useEffect, useRef, useState } from 'react'
import MapView from './map/MapView'
import LayerPanel from './components/LayerPanel'
import QrScanner from './components/QrScanner'
import { fetchKmlFromUrl, parseKmlOrKmzFile, type ParsedKml } from './lib/kml'
import {
  deleteOverlay,
  listOverlays,
  requestPersistentStorage,
  saveOverlay,
  type Overlay,
} from './lib/store'

interface Toast {
  message: string
  isError: boolean
}

export default function App() {
  const [overlays, setOverlays] = useState<Overlay[]>([])
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    requestPersistentStorage()
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
          await addOverlay(await parseKmlOrKmzFile(file))
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
        <button className="btn" onClick={() => fileInputRef.current?.click()}>
          Import KML
        </button>
        <button className="btn primary" onClick={() => setScanning(true)}>
          Scan fire QR
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".kml,.kmz"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </header>

      <div className="map-container">
        <MapView overlays={overlays} hiddenIds={hiddenIds} focusRequest={focusRequest} />
        <LayerPanel
          overlays={overlays}
          hiddenIds={hiddenIds}
          onToggle={handleToggle}
          onRemove={handleRemove}
          onFocus={focusOverlay}
        />
      </div>

      {scanning && (
        <QrScanner
          onResult={handleQrResult}
          onClose={() => setScanning(false)}
          onError={(m) => showToast(m, true)}
        />
      )}

      {toast && <div className={`toast${toast.isError ? ' error' : ''}`}>{toast.message}</div>}
    </div>
  )
}
