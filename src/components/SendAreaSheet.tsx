import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import './SendAreaSheet.css'
import {
  areaAt,
  groundSizeM,
  lngLatToWorld,
  pageLayout,
  PAGE_SIZES,
  roundScale,
  scaleDenominator,
  worldToLngLat,
  type Dpi,
  type MapArea,
  type Orientation,
  type PageSizeId,
} from '../lib/geopdf-write'
import { checkTiles, type PrintLayers, type TileCheck } from '../map/print-render'
import {
  createAreaMap,
  defaultTitle,
  downloadMapFile,
  SATELLITE_NOTE,
  shareMapFile,
  type AreaMap,
} from '../lib/send-area'

/**
 * "Send this area as a map": a viewfinder box over the map in the page's
 * shape, plus a sheet with the page options. The user moves and zooms the map
 * under the box (and can drag a corner to shrink it), then creates a
 * georeferenced PDF and shares it (AirDrop, Quick Share, Open in Avenza).
 */

interface Props {
  map: MlMap | null
  layers: PrintLayers
  basemap: 'streets' | 'satellite'
  onClose: () => void
  onNotify: (message: string, isError?: boolean) => void
}

type Phase = { name: 'frame' } | { name: 'working'; message: string } | { name: 'done'; result: AreaMap }

const BOX_MARGIN = 20
/** Keep the box below the coordinate readout pill at the top of the map. */
const BOX_TOP = 52
const MIN_BOX_SCALE = 0.25

export default function SendAreaSheet({ map, layers, basemap, onClose, onNotify }: Props) {
  const [size, setSize] = useState<PageSizeId>('letter')
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  const [dpi, setDpi] = useState<Dpi>(150)
  // On by default: printed field maps are read by grid square (helicopter call-ins).
  const [grid, setGrid] = useState(true)
  const [title, setTitle] = useState(() => defaultTitle())
  const [phase, setPhase] = useState<Phase>({ name: 'frame' })
  const [area, setArea] = useState<MapArea | null>(null)
  const [tiles, setTiles] = useState<TileCheck | null>(null)
  const [boxScale, setBoxScale] = useState(1)
  const [region, setRegion] = useState({ w: 0, h: 0 })
  const sheetRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const layout = useMemo(() => pageLayout(size, orientation), [size, orientation])
  const aspect = layout.framePx.w / layout.framePx.h

  // The space the box can use: the map, above the sheet.
  useEffect(() => {
    if (!map) return
    const container = map.getContainer()
    const measure = () =>
      setRegion({
        w: container.clientWidth,
        h: container.clientHeight - (sheetRef.current?.offsetHeight ?? 0),
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    if (sheetRef.current) observer.observe(sheetRef.current)
    return () => observer.disconnect()
  }, [map])

  const liveBox = useMemo(() => {
    const availW = Math.max(40, region.w - 2 * BOX_MARGIN)
    const availH = Math.max(40, region.h - BOX_TOP - BOX_MARGIN)
    const fullW = Math.min(availW, availH * aspect)
    const w = fullW * boxScale
    const h = w / aspect
    return { w, h, cx: region.w / 2, cy: BOX_TOP + availH / 2, fullW }
  }, [region, aspect, boxScale])
  // Hold the box still while a map is being made or shown: the sheet changes
  // height then, and the box should keep showing the area that was sent.
  const heldBox = useRef(liveBox)
  if (phase.name === 'frame') heldBox.current = liveBox
  const box = heldBox.current

  // North up and flat while framing (the page is north-up); put back after.
  useEffect(() => {
    if (!map) return
    map.easeTo({ bearing: 0, pitch: 0, duration: 300 })
    map.dragRotate.disable()
    map.touchZoomRotate.disableRotation()
    map.touchPitch.disable()
    map.keyboard.disableRotation()
    return () => {
      map.dragRotate.enable()
      map.touchZoomRotate.enableRotation()
      map.touchPitch.enable()
      map.keyboard.enableRotation()
    }
  }, [map])

  // The area under the box, at the zoom that fills the page's frame with it.
  const updateArea = useCallback(() => {
    if (!map || box.w <= 0) return
    const container = map.getContainer()
    const zoom = map.getZoom()
    const c = map.getCenter()
    const [mx, my] = lngLatToWorld([c.lng, c.lat], zoom)
    const centre = worldToLngLat(
      mx + box.cx - container.clientWidth / 2,
      my + box.cy - container.clientHeight / 2,
      zoom,
    )
    setArea(areaAt(centre, zoom + Math.log2(layout.framePx.w / box.w), layout.framePx))
  }, [map, box, layout])

  useEffect(() => {
    if (!map) return
    updateArea()
    let frame = 0
    const onMove = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateArea)
    }
    map.on('move', onMove)
    return () => {
      cancelAnimationFrame(frame)
      map.off('move', onMove)
    }
  }, [map, updateArea])

  // Are this area's tiles on the device? Checked once the map settles.
  useEffect(() => {
    if (!area) return
    let stale = false
    const timer = setTimeout(() => {
      checkTiles(area).then((t) => !stale && setTiles(t), () => !stale && setTiles(null))
    }, 350)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [area])

  useEffect(() => () => abortRef.current?.abort(), [])

  const create = async () => {
    if (!area || phase.name === 'working') return
    const controller = new AbortController()
    abortRef.current = controller
    setPhase({ name: 'working', message: 'Checking saved map tiles…' })
    try {
      const fresh = await checkTiles(area)
      setTiles(fresh)
      const blocked = tileStatus(fresh)
      if (blocked?.block) throw new Error(blocked.text)
      const result = await createAreaMap({
        title,
        size,
        orientation,
        dpi,
        area,
        grid,
        layers,
        tiles: fresh,
        signal: controller.signal,
        onProgress: (message) => setPhase({ name: 'working', message }),
      })
      setPhase({ name: 'done', result })
      if (result.failedTiles || result.incomplete) {
        onNotify(
          `Map made, but ${result.failedTiles || 'some'} map tiles didn't load, so parts of it may be blank.`,
          true,
        )
      }
    } catch (err) {
      setPhase({ name: 'frame' })
      if (!controller.signal.aborted) onNotify(`Couldn't make the map: ${(err as Error).message}`, true)
    } finally {
      abortRef.current = null
    }
  }

  const share = async (file: File) => {
    try {
      const how = await shareMapFile(file)
      if (how === 'unsupported') {
        downloadMapFile(file)
        onNotify(`Saved ${file.name}`)
      }
    } catch (err) {
      onNotify(`Couldn't share: ${(err as Error).message}`, true)
    }
  }

  // Corner handles: drag to shrink or grow the box about its centre.
  const onHandleDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const pointerId = e.pointerId
    const rect = (e.currentTarget as HTMLElement).closest('.send-area-overlay')!.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const dx = Math.abs(ev.clientX - rect.left - box.cx) * 2
      const dy = Math.abs(ev.clientY - rect.top - box.cy) * 2
      const scale = Math.max(dx / box.fullW, (dy * aspect) / box.fullW)
      setBoxScale(Math.min(1, Math.max(MIN_BOX_SCALE, scale)))
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const working = phase.name === 'working'
  const ground = area ? groundSizeM(area) : null
  const scale = area ? scaleDenominator(area) : null
  const tileNote = tileStatus(tiles)

  return (
    <>
      <div className="send-area-overlay" style={{ height: region.h > 0 ? region.h : undefined }}>
        {box.w > 0 && (
          <div
            className="send-area-box"
            style={{ width: box.w, height: box.h, left: box.cx - box.w / 2, top: box.cy - box.h / 2 }}
          >
            {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
              <span key={c} className={`send-area-handle ${c}`} onPointerDown={onHandleDown} />
            ))}
          </div>
        )}
      </div>

      <div className="feature-sheet send-area-sheet" ref={sheetRef}>
        <div className="sheet-header">
          <span className="kind-icon">🗺</span>
          <span className="sheet-title">Send this area as a map</span>
          <button className="btn" onClick={onClose} disabled={working}>
            Close
          </button>
        </div>

        {phase.name === 'done' ? (
          <div className="send-area-result">
            <div className="send-area-file">
              <strong>{phase.result.file.name}</strong>
              <span>
                {formatBytes(phase.result.bytes)} · made in {(phase.result.ms / 1000).toFixed(1)} s
              </span>
            </div>
            <div className="sheet-actions">
              <button className="btn primary" onClick={() => share(phase.result.file)}>
                Share…
              </button>
              <button className="btn" onClick={() => downloadMapFile(phase.result.file)}>
                Save to Files
              </button>
              <button className="btn" onClick={() => setPhase({ name: 'frame' })}>
                Make another
              </button>
            </div>
            <div className="settings-hint">
              Share sends it by AirDrop or Quick Share, or opens it in Avenza Maps, which places it on
              the map by itself.
            </div>
          </div>
        ) : (
          <>
            <div className="settings-hint">
              Move and zoom the map to fit the area in the box. Drag a corner to make the box smaller.
            </div>
            <label className="send-area-title">
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={working} />
            </label>
            <div className="send-area-options">
              <Segmented
                value={size}
                disabled={working}
                options={(Object.keys(PAGE_SIZES) as PageSizeId[]).map((id) => [id, PAGE_SIZES[id].label])}
                onChange={setSize}
              />
              <Segmented
                value={orientation}
                disabled={working}
                options={[
                  ['portrait', 'Portrait'],
                  ['landscape', 'Landscape'],
                ]}
                onChange={setOrientation}
              />
              <Segmented
                value={dpi}
                disabled={working}
                options={[
                  [150, '150 DPI'],
                  [300, '300 DPI · sharper'],
                ]}
                onChange={setDpi}
              />
              <label className="send-area-check">
                <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} disabled={working} />
                UTM grid
              </label>
            </div>
            {basemap === 'satellite' && <div className="settings-hint send-area-warn">{SATELLITE_NOTE}</div>}
            <div className="settings-hint">
              {scale && ground
                ? `1:${roundScale(scale).toLocaleString('en-US')} · ${formatGround(ground.w)} × ${formatGround(ground.h)}`
                : 'Waiting for the map…'}
              {tileNote && <span className={tileNote.warn ? 'send-area-warn' : undefined}> · {tileNote.text}</span>}
            </div>
            <div className="sheet-actions">
              {working ? (
                <>
                  <span className="send-area-progress">{phase.message}</span>
                  <button className="btn" onClick={() => abortRef.current?.abort()}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn primary" onClick={create} disabled={!area || tileNote?.block}>
                  {tileNote?.warn ? 'Create map anyway' : 'Create map'}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  )
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  return (
    <span className="send-area-segmented">
      {options.map(([v, label]) => (
        <button
          key={String(v)}
          className={`btn small${v === value ? ' active' : ''}`}
          onClick={() => onChange(v)}
          disabled={disabled}
        >
          {label}
        </button>
      ))}
    </span>
  )
}

/** What to tell the user about tiles; `block` when the map could only come out blank. */
function tileStatus(t: TileCheck | null): { text: string; warn: boolean; block?: boolean } | null {
  if (!t) return null
  if (!t.tilesUrl) {
    return { text: "the basemap isn't saved on this device yet. Open the map once with signal.", warn: true, block: true }
  }
  if (t.missing === null) return null
  if (t.missing > 0) {
    if (t.offline && t.missing >= t.total) {
      return { text: "none of this area is saved offline, so the map would be blank. Save it offline when you have signal.", warn: true, block: true }
    }
    const pct = Math.max(1, Math.round((t.missing / t.total) * 100))
    return t.offline
      ? { text: `about ${pct}% of this area isn't saved offline and will be blank`, warn: true }
      : { text: `${t.missing} map tiles will download`, warn: false }
  }
  if (t.labelsMissing) return { text: "label fonts aren't saved offline, so names may be missing", warn: true }
  if (t.offline) return { text: t.coarser ? 'offline: some detail from coarser saved tiles' : 'offline: all tiles saved', warn: false }
  return null
}

function formatGround(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`
}

function formatBytes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`
}
