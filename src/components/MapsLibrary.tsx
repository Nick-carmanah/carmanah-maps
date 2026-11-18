import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Position } from 'geojson'
import { formatBytes } from '../lib/library/library'
import { UNSORTED, type LibraryMap } from '../lib/library/types'
import { mapDistances, roughDistance, sortByDistance, type MapDistance } from '../lib/library/nearby'
import { readMapsSort, saveMapsSort, type MapChoice, type MapsSort } from '../lib/library/viewer'
import { lastFix, subscribeFix } from '../lib/position'
import { formatDistance } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'
import type { FileStore } from '../lib/storage/files'
import { EMBEDDED } from '../lib/embedded'
import { packRegistry } from '../lib/packs/registry'
import { formatMB } from '../lib/packs/format'
import './MapsLibrary.css'

type Patch = Partial<Omit<LibraryMap, 'id'>>
type Basemap = 'streets' | 'satellite'

interface MyMapsProps {
  ownerId: string
  maps: LibraryMap[]
  /** The fire this phone is on: its folder is listed first and new maps go there. */
  currentFolder: string
  storageBackend: FileStore['backend'] | null
  /** What's open now (highlighted). */
  current: MapChoice
  basemap: Basemap
  /** Satellite is online only (#19): without signal the base map shows streets. */
  satelliteOk: boolean
  onSetBasemap: (b: Basemap) => void
  onOpen: (choice: MapChoice) => void
  onImportFiles: () => void
  onScanQr: () => void
  onImportUrl: (url: string) => void
  onUpdate: (id: string, patch: Patch, persist?: boolean) => void
  onRemove: (id: string) => Promise<void>
  readOriginal: (map: LibraryMap) => Promise<File | null>
  onShare: (file: File) => void
  /** Re-draw an older single-image map as sharp tiles from its original. */
  onSharpen: (map: LibraryMap) => void
  /** Open the base map with the Offline maps sheet (fire packs, docs/fire-packs.md). */
  onOfflineAreas: () => void
}

const folderLabel = (folder: string) => folder || UNSORTED

/**
 * My Maps, Avenza's opening screen: the base map, then the person's maps by
 * fire. Tap one to view it on its own. Maps that contain your GPS position say
 * so; the others show how far away they are, and can be sorted nearest first.
 */
export default function MyMaps({
  ownerId,
  maps,
  currentFolder,
  storageBackend,
  current,
  basemap,
  satelliteOk,
  onSetBasemap,
  onOpen,
  onImportFiles,
  onScanQr,
  onImportUrl,
  onUpdate,
  onRemove,
  readOriginal,
  onShare,
  onSharpen,
  onOfflineAreas,
}: MyMapsProps) {
  const [filter, setFilter] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [sort, setSortState] = useState<MapsSort>(() => readMapsSort(ownerId))
  const thumbs = useThumbnailUrls(maps)
  const gps = useNearbyPosition(sort === 'nearest')
  useUnitSettings() // distances follow the units setting

  const distances = useMemo(() => mapDistances(maps, gps.position), [maps, gps.position])

  const setSort = (next: MapsSort) => {
    setSortState(next)
    saveMapsSort(ownerId, next)
    if (next === 'nearest') gps.locate()
  }

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle
      ? maps.filter((m) => `${m.name} ${m.folder} ${m.source?.fileName ?? ''}`.toLowerCase().includes(needle))
      : maps
  }, [maps, filter])

  const folders = useMemo(() => {
    const byFolder = new Map<string, LibraryMap[]>()
    for (const m of visible) {
      const list = byFolder.get(m.folder) ?? []
      list.push(m)
      byFolder.set(m.folder, list)
    }
    // Current fire first, then A–Z, Unsorted last.
    return [...byFolder.entries()].sort(([a], [b]) => {
      const rank = (f: string) => (f === currentFolder && f ? 0 : f ? 1 : 2)
      return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })
    })
  }, [visible, currentFolder])

  const nearest = useMemo(
    () => (sort === 'nearest' ? sortByDistance(visible, distances) : []),
    [sort, visible, distances],
  )

  const folderNames = useMemo(() => {
    const names = new Set(maps.map((m) => m.folder).filter(Boolean))
    if (currentFolder) names.add(currentFolder)
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }, [maps, currentFolder])

  // Pages of one PDF share its original: count it once.
  const totalBytes =
    maps.reduce((sum, m) => sum + m.storedBytes, 0) +
    [...new Map(maps.flatMap((m) => (m.originalPath ? [[m.originalPath, m.source?.fileSize ?? 0]] : []))).values()]
      .reduce((sum, n) => sum + n, 0)

  const toggleFolder = useCallback((folder: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }, [])

  const openMap = useCallback((id: string) => onOpen({ kind: 'map', id }), [onOpen])
  const currentId = current.kind === 'map' ? current.id : null

  const row = (m: LibraryMap, showFolder = false) => (
    <MapRow
      key={m.id}
      map={m}
      thumbUrl={thumbs.get(m.id)}
      open={openId === m.id}
      isCurrent={m.id === currentId}
      distance={distances.get(m.id)}
      folder={showFolder ? folderLabel(m.folder) : undefined}
      folderNames={folderNames}
      onOpenMap={openMap}
      onToggleActions={setOpenId}
      onUpdate={onUpdate}
      onRemove={onRemove}
      readOriginal={readOriginal}
      onShare={onShare}
      onSharpen={onSharpen}
    />
  )

  return (
    <div className="my-maps" role="main" aria-label="My Maps">
      <header className="my-maps-header">
        {/* In the crew app this page has no browser chrome, so it links back. */}
        {EMBEDDED && (
          <a className="btn home-link" href="/" aria-label="Back to the crew app">
            ‹ Home
          </a>
        )}
        <h1>My Maps</h1>
        <button
          className="btn primary my-maps-add"
          onClick={() => setImportOpen((o) => !o)}
          aria-expanded={importOpen}
          aria-label="Import a map"
        >
          +
        </button>
      </header>

      {importOpen && (
        <ImportMenu
          onClose={() => setImportOpen(false)}
          onFiles={() => {
            setImportOpen(false)
            onImportFiles()
          }}
          onScanQr={() => {
            setImportOpen(false)
            onScanQr()
          }}
          onUrl={(url) => {
            setImportOpen(false)
            onImportUrl(url)
          }}
        />
      )}

      <div className="my-maps-scroll">
        <BaseMapRow
          basemap={basemap}
          satelliteOk={satelliteOk}
          isCurrent={current.kind === 'base'}
          onOpen={() => onOpen({ kind: 'base' })}
          onSetBasemap={onSetBasemap}
          onOfflineAreas={onOfflineAreas}
        />

        {maps.length > 0 && (
          <div className="my-maps-tools">
            <div className="seg" role="group" aria-label="Sort maps">
              <button className={sort === 'folders' ? 'selected' : ''} onClick={() => setSort('folders')}>
                By fire
              </button>
              <button className={sort === 'nearest' ? 'selected' : ''} onClick={() => setSort('nearest')}>
                Nearest
              </button>
            </div>
            {!gps.position && (
              <button className="btn small" onClick={gps.locate} disabled={gps.locating}>
                {gps.locating ? 'Finding you…' : '📍 Where am I?'}
              </button>
            )}
            {gps.position && <span className="my-maps-gps">📍 GPS on</span>}
          </div>
        )}
        {gps.error && sort === 'nearest' && !gps.position && <div className="maps-note">{gps.error}</div>}

        {maps.length > 6 && (
          <div className="maps-filter">
            <input
              type="search"
              value={filter}
              placeholder="Find a map or fire"
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        )}

        {maps.length === 0 && (
          <div className="empty">
            No maps yet. Tap <strong>+</strong> to import a GeoPDF (from Avenza, BCWS or any GIS). It's saved on this
            phone for offline use, sorted by fire.
          </div>
        )}

        {sort === 'nearest'
          ? nearest.map((m) => row(m, true))
          : folders.map(([folder, list]) => (
              <section key={folder || '\u0000'} className="maps-folder">
                <button className="maps-folder-header" onClick={() => toggleFolder(folder)}>
                  <span className="maps-caret" aria-hidden>
                    {collapsed.has(folder) ? '▸' : '▾'}
                  </span>
                  <span className="maps-folder-name">{folderLabel(folder)}</span>
                  {folder && folder === currentFolder && <span className="maps-badge">this fire</span>}
                  <span className="maps-count">{list.length}</span>
                </button>
                {!collapsed.has(folder) && list.map((m) => row(m))}
              </section>
            ))}

        {maps.length > 0 && (
          <div className="maps-note my-maps-storage">
            {formatBytes(totalBytes)} on this {storageBackend === 'native' ? 'phone' : 'device'}
            {storageBackend !== 'native' &&
              ' · The browser can clear website storage when space runs low, so keep your original files.'}
          </div>
        )}
      </div>
    </div>
  )
}

/** The plain base map, always first (Avenza lists its base map the same way). */
function BaseMapRow({
  basemap,
  satelliteOk,
  isCurrent,
  onOpen,
  onSetBasemap,
  onOfflineAreas,
}: {
  basemap: Basemap
  satelliteOk: boolean
  isCurrent: boolean
  onOpen: () => void
  onSetBasemap: (b: Basemap) => void
  onOfflineAreas: () => void
}) {
  // The offline areas (fire packs) saved on this phone, as Avenza lists a base map's downloads.
  const offline = useSyncExternalStore(
    (fn) => packRegistry.subscribe(fn),
    () => {
      const n = packRegistry.packs.length
      const bytes = packRegistry.packs.reduce((s, p) => s + p.bytes, 0)
      const partial = packRegistry.jobs.length
      return n ? `${n} saved · ${formatMB(bytes)}${partial ? ` · ${partial} unfinished` : ''}` : partial ? `${partial} unfinished` : 'None saved yet'
    },
  )
  useEffect(() => void packRegistry.load(), [])
  return (
    <div className={`map-row base-row${isCurrent ? ' current' : ''}`}>
      <div className="map-row-main">
        <button className={`map-thumb base-thumb ${basemap}`} onClick={onOpen} aria-label="Open the base map">
          <span aria-hidden>{basemap === 'satellite' ? '🛰' : '🌍'}</span>
        </button>
        <button className="map-text" onClick={onOpen}>
          <span className="map-name">
            Base map {isCurrent && <span className="maps-badge">open</span>}
          </span>
          <span className="map-meta">
            {basemap === 'satellite' && !satelliteOk
              ? 'Satellite needs signal: showing streets'
              : 'Anywhere · your saved offline areas work without signal'}
          </span>
        </button>
        <div className="seg seg-small" role="group" aria-label="Base map style">
          {(['streets', 'satellite'] as const).map((b) => (
            <button key={b} className={basemap === b ? 'selected' : ''} onClick={() => onSetBasemap(b)}>
              {b === 'streets' ? 'Streets' : 'Satellite'}
            </button>
          ))}
        </div>
      </div>
      <button className="base-offline" onClick={onOfflineAreas}>
        <span>
          ⬇ Offline areas <span className="map-meta">{offline}</span>
        </span>
        <span aria-hidden>›</span>
      </button>
    </div>
  )
}

/** "+": the ways a map gets onto the phone. */
function ImportMenu({
  onClose,
  onFiles,
  onScanQr,
  onUrl,
}: {
  onClose: () => void
  onFiles: () => void
  onScanQr: () => void
  onUrl: (url: string) => void
}) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [url, setUrl] = useState('')
  const valid = /^https?:\/\/\S+$/i.test(url.trim())
  return (
    <>
      <div className="import-menu-backdrop" onClick={onClose} />
      <div className="import-menu" role="menu" aria-label="Import a map">
        <button className="tool-row" role="menuitem" onClick={onFiles}>
          <span className="tool-icon">📂</span>
          <span>
            Files
            <small>GeoPDF, KML/KMZ, GPX, CSV, shapefile</small>
          </span>
        </button>
        <button className="tool-row" role="menuitem" onClick={onScanQr}>
          <span className="tool-icon">▦</span>
          <span>
            Scan a QR code
            <small>A fire's map or KML link</small>
          </span>
        </button>
        <button className="tool-row" role="menuitem" onClick={() => setLinkOpen((o) => !o)} aria-expanded={linkOpen}>
          <span className="tool-icon">🔗</span>
          <span>
            From a link
            <small>Paste a web address (needs signal)</small>
          </span>
        </button>
        {linkOpen && (
          <form
            className="map-form import-link"
            onSubmit={(e) => {
              e.preventDefault()
              if (valid) onUrl(url.trim())
            }}
          >
            <input
              type="url"
              inputMode="url"
              autoFocus
              value={url}
              placeholder="https://…/map.pdf or .kmz"
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Map link"
            />
            <button className="btn small primary" type="submit" disabled={!valid}>
              Import
            </button>
          </form>
        )}
      </div>
    </>
  )
}

/**
 * The GPS position for "you are here" and distances. It starts by itself when
 * the phone already allows location (or inside the crew app, which asks at
 * install); otherwise only when asked, so opening the website doesn't pop a
 * permission prompt before anyone has done anything.
 */
function useNearbyPosition(wanted: boolean) {
  const [on, setOn] = useState(false)
  const [position, setPosition] = useState<Position | null>(() => {
    const fix = lastFix()
    return fix ? [fix.lng, fix.lat] : null
  })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (EMBEDDED || wanted) {
      setOn(true)
      return
    }
    let live = true
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((status) => live && status.state === 'granted' && setOn(true))
      .catch(() => {})
    return () => {
      live = false
    }
    // Only the first time: a later "Nearest" calls locate().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!on) return
    return subscribeFix(
      (fix) => {
        setPosition([fix.lng, fix.lat])
        setError(null)
      },
      setError,
    )
  }, [on])

  return {
    position,
    error,
    locating: on && !position && !error,
    locate: useCallback(() => setOn(true), []),
  }
}

/** The open map, at the top of the Layers sheet: how it's shown, and the way back to My Maps. */
export function CurrentMapSection({
  map,
  basemapAround,
  onBasemapAround,
  onUpdate,
  onChangeMap,
}: {
  /** The open custom map, or null for the base map. */
  map: LibraryMap | null
  basemapAround: boolean
  onBasemapAround: (on: boolean) => void
  onUpdate: (id: string, patch: Patch, persist?: boolean) => void
  onChangeMap: () => void
}) {
  const thumbs = useThumbnailUrls(useMemo(() => (map ? [map] : []), [map]))
  const thumb = map ? thumbs.get(map.id) : undefined
  return (
    <div className="current-map">
      <button className="layer-row current-map-row" onClick={onChangeMap}>
        <span className="map-thumb small" aria-hidden>
          {thumb ? <img src={thumb} alt="" /> : map ? '🗺' : '🌍'}
        </span>
        <span className="name">
          {map ? map.name : 'Base map'}
          <div className="meta">{map ? 'This map · tap to change' : 'No custom map open · tap for My Maps'}</div>
        </span>
        <span className="current-map-change">My Maps ›</span>
      </button>
      {map && (
        <>
          <label className="layer-row">
            <input type="checkbox" checked={basemapAround} onChange={(e) => onBasemapAround(e.target.checked)} />
            <span className="name">
              Show base map around this map
              <div className="meta">Off: plain grey outside the map's edge</div>
            </span>
          </label>
          <label className="layer-row map-opacity">
            <span>Opacity</span>
            <input
              type="range"
              min={10}
              max={100}
              step={1}
              value={Math.round(map.opacity * 100)}
              onChange={(e) => onUpdate(map.id, { opacity: Number(e.target.value) / 100 }, false)}
              onPointerUp={(e) => onUpdate(map.id, { opacity: Number(e.currentTarget.value) / 100 })}
              onKeyUp={(e) => onUpdate(map.id, { opacity: Number(e.currentTarget.value) / 100 })}
              onBlur={(e) => onUpdate(map.id, { opacity: Number(e.currentTarget.value) / 100 })}
              aria-label="Map opacity"
            />
            <span className="map-opacity-value">{Math.round(map.opacity * 100)}%</span>
          </label>
        </>
      )}
    </div>
  )
}

/** Object URLs for thumbnails, made once per thumbnail and revoked when gone. */
function useThumbnailUrls(maps: LibraryMap[]): Map<string, string> {
  const cache = useRef(new Map<string, { blob: Blob; url: string }>())
  const [urls, setUrls] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    const seen = new Set<string>()
    for (const m of maps) {
      if (!m.thumb) continue
      seen.add(m.id)
      const entry = cache.current.get(m.id)
      if (entry?.blob === m.thumb) continue
      if (entry) URL.revokeObjectURL(entry.url)
      cache.current.set(m.id, { blob: m.thumb, url: URL.createObjectURL(m.thumb) })
    }
    for (const [id, entry] of cache.current) {
      if (seen.has(id)) continue
      URL.revokeObjectURL(entry.url)
      cache.current.delete(id)
    }
    setUrls(new Map([...cache.current].map(([id, e]) => [id, e.url])))
  }, [maps])
  useEffect(() => {
    const entries = cache.current
    return () => {
      entries.forEach((e) => URL.revokeObjectURL(e.url))
      entries.clear()
    }
  }, [])
  return urls
}

function mapBytes(m: LibraryMap): number {
  return m.storedBytes + (m.source?.fileSize ?? 0)
}

const formatDate = (t: number) =>
  new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

interface MapRowProps {
  map: LibraryMap
  thumbUrl?: string
  open: boolean
  isCurrent: boolean
  distance?: MapDistance
  /** Shown in the meta line when the list isn't grouped by folder. */
  folder?: string
  folderNames: string[]
  onOpenMap: (id: string) => void
  onToggleActions: (id: string | null) => void
  onUpdate: (id: string, patch: Patch, persist?: boolean) => void
  onRemove: (id: string) => Promise<void>
  readOriginal: (map: LibraryMap) => Promise<File | null>
  onShare: (file: File) => void
  onSharpen: (map: LibraryMap) => void
}

type Panel = 'actions' | 'info' | 'rename' | 'move'

const MapRow = memo(function MapRow({
  map,
  thumbUrl,
  open,
  isCurrent,
  distance,
  folder,
  folderNames,
  onOpenMap,
  onToggleActions,
  onUpdate,
  onRemove,
  readOriginal,
  onShare,
  onSharpen,
}: MapRowProps) {
  const [panel, setPanel] = useState<Panel>('actions')
  const [original, setOriginal] = useState<File | null | 'loading'>(null)
  const canShare = Boolean(map.originalPath)

  // Read the original as soon as the actions open, so "Share original" can
  // open the share sheet straight from the tap (it must, on iPhone).
  useEffect(() => {
    if (!open) {
      setPanel('actions')
      return
    }
    if (!canShare) return
    let live = true
    setOriginal('loading')
    readOriginal(map)
      .then((file) => live && setOriginal(file))
      .catch(() => live && setOriginal(null))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canShare, map.originalPath])

  const legacy = !map.originalPath
  return (
    <div className={`map-row${open ? ' open' : ''}${isCurrent ? ' current' : ''}${distance?.inside ? ' here' : ''}`}>
      <div className="map-row-main">
        <button className="map-thumb" onClick={() => onOpenMap(map.id)} aria-label={`Open ${map.name}`}>
          {thumbUrl ? <img src={thumbUrl} alt="" loading="lazy" decoding="async" /> : <span aria-hidden>🗺</span>}
          {distance?.inside && (
            <span className="map-here-pin" aria-hidden>
              📍
            </span>
          )}
        </button>
        <button className="map-text" onClick={() => onOpenMap(map.id)}>
          <span className="map-name">
            {map.name} {isCurrent && <span className="maps-badge">open</span>}
          </span>
          {distance && (
            <span className={`map-distance${distance.inside ? ' inside' : ''}`}>
              {distance.inside ? 'You are here' : `${roughDistance(formatDistance(distance.metres))} away`}
            </span>
          )}
          <span className="map-meta">
            {folder !== undefined && `${folder} · `}
            {formatDate(map.addedAt)} · {formatBytes(mapBytes(map))}
            {map.source && map.source.pageCount > 1 && ` · p${map.source.pageIndex + 1}`}
          </span>
          {legacy && <span className="map-legacy">Re-import to share or sharpen</span>}
          {!legacy && map.raster.kind === 'image' && <span className="map-legacy">Blurry up close · Sharpen in ⋯</span>}
        </button>
        <button
          className="map-more"
          onClick={() => onToggleActions(open ? null : map.id)}
          aria-expanded={open}
          aria-label={`More for ${map.name}`}
        >
          ⋯
        </button>
      </div>

      {open && (
        <div className="map-actions">
          {panel === 'actions' && (
            <div className="map-action-grid">
              <button className="btn small primary" onClick={() => onOpenMap(map.id)}>
                Open
              </button>
              <button
                className="btn small"
                disabled={!canShare || original === 'loading' || original === null}
                onClick={() => original && original !== 'loading' && onShare(original)}
                title={
                  canShare
                    ? 'Send the original PDF (AirDrop, Quick Share, Avenza…)'
                    : 'This map was saved before originals were kept. Re-import it to share it.'
                }
              >
                {original === 'loading' ? 'Preparing…' : 'Share original'}
              </button>
              {map.raster.kind === 'image' && canShare && (
                <button className="btn small" onClick={() => onSharpen(map)}>
                  Sharpen
                </button>
              )}
              <button className="btn small" onClick={() => setPanel('info')}>
                Info
              </button>
              <button className="btn small" onClick={() => setPanel('rename')}>
                Rename
              </button>
              <button className="btn small" onClick={() => setPanel('move')}>
                Move to folder
              </button>
              <button
                className="btn small danger"
                onClick={() => {
                  if (confirm(`Delete "${map.name}" from this device? This can't be undone.`)) {
                    onRemove(map.id)
                  }
                }}
              >
                Delete
              </button>
            </div>
          )}
          {canShare && original === null && panel === 'actions' && (
            <div className="map-warning">The original file is missing from this device. Re-import it to share it.</div>
          )}

          {panel === 'rename' && (
            <RenameForm
              name={map.name}
              onSave={(name) => {
                onUpdate(map.id, { name })
                setPanel('actions')
              }}
              onCancel={() => setPanel('actions')}
            />
          )}

          {panel === 'move' && (
            <MoveForm
              folder={map.folder}
              folderNames={folderNames}
              onSave={(folder) => {
                onUpdate(map.id, { folder })
                setPanel('actions')
              }}
              onCancel={() => setPanel('actions')}
            />
          )}

          {panel === 'info' && <MapInfo map={map} onBack={() => setPanel('actions')} />}
        </div>
      )}
    </div>
  )
})

function RenameForm({ name, onSave, onCancel }: { name: string; onSave: (n: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(name)
  return (
    <form
      className="map-form"
      onSubmit={(e) => {
        e.preventDefault()
        const next = value.trim()
        if (next) onSave(next.slice(0, 120))
      }}
    >
      <input value={value} autoFocus onChange={(e) => setValue(e.target.value)} aria-label="Map name" />
      <button className="btn small primary" type="submit" disabled={!value.trim()}>
        Save
      </button>
      <button className="btn small" type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}

const NEW_FOLDER = '\u0000new'

function MoveForm({
  folder,
  folderNames,
  onSave,
  onCancel,
}: {
  folder: string
  folderNames: string[]
  onSave: (f: string) => void
  onCancel: () => void
}) {
  const [choice, setChoice] = useState(folder)
  const [newName, setNewName] = useState('')
  const target = choice === NEW_FOLDER ? newName.trim().slice(0, 60) : choice
  return (
    <form
      className="map-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (choice !== NEW_FOLDER || target) onSave(target)
      }}
    >
      <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Folder">
        {folderNames.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
        <option value="">{UNSORTED}</option>
        <option value={NEW_FOLDER}>New folder…</option>
      </select>
      {choice === NEW_FOLDER && (
        <input
          value={newName}
          autoFocus
          placeholder="Fire number, e.g. K61067"
          onChange={(e) => setNewName(e.target.value)}
          aria-label="New folder name"
        />
      )}
      <button className="btn small primary" type="submit" disabled={choice === NEW_FOLDER && !target}>
        Move
      </button>
      <button className="btn small" type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  )
}

/** Great-circle distance in metres. */
function haversine([lon1, lat1]: number[], [lon2, lat2]: number[]): number {
  const r = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}

/** Map scale from the frame's width on paper and on the ground, rounded like a printed scale. */
function approxScale(map: LibraryMap): string | null {
  if (!map.source) return null
  const [xMin, , xMax] = map.source.bboxPt
  const paperM = ((xMax - xMin) / 72) * 0.0254
  const groundM = haversine(map.corners[0], map.corners[1])
  if (!(paperM > 0) || !(groundM > 0)) return null
  const scale = groundM / paperM
  const magnitude = 10 ** Math.floor(Math.log10(scale) - 1)
  return `≈ 1:${(Math.round(scale / magnitude) * magnitude).toLocaleString()}`
}

const fmtCorner = ([lon, lat]: number[]) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`

function MapInfo({ map, onBack }: { map: LibraryMap; onBack: () => void }) {
  const s = map.source
  const rows: [string, ReactNode][] = []
  if (s) {
    rows.push(['File', s.fileName])
    rows.push(['Original size', formatBytes(s.fileSize)])
    rows.push([
      'Page',
      `${s.pageIndex + 1} of ${s.pageCount}${s.frameCount > 1 ? ` · map frame ${s.frameIndex + 1} of ${s.frameCount}` : ''}`,
    ])
    rows.push(['Paper', `${(s.pageSizePt[0] / 72).toFixed(1)} × ${(s.pageSizePt[1] / 72).toFixed(1)} in`])
  } else {
    rows.push(['Original', 'Not kept (saved before the Maps library). Re-import the PDF to share or sharpen it.'])
  }
  const scale = approxScale(map)
  if (scale) rows.push(['Scale', scale])
  rows.push(['Folder', folderLabel(map.folder)])
  rows.push(['Added', new Date(map.addedAt).toLocaleString()])
  if (map.raster.kind === 'tiles') {
    rows.push([
      'Detail',
      `≈ ${map.raster.dpi} DPI · zoom ${map.raster.minzoom}–${map.raster.maxzoom} · ${map.raster.tileCount} tiles`,
    ])
  } else if (map.raster.kind === 'image') {
    rows.push(['Drawn at', `${map.raster.width} × ${map.raster.height} px (one image; Sharpen for detail)`])
  }
  rows.push(['Stored', formatBytes(map.storedBytes) + (s ? ' (plus the original)' : '')])
  const labels = ['Top left', 'Top right', 'Bottom right', 'Bottom left']
  map.corners.forEach((c, i) => rows.push([labels[i], fmtCorner(c)]))
  const proj = s?.projection
  if (proj?.name || proj?.epsg) {
    rows.push(['Projection', [proj.name, proj.epsg ? `EPSG:${proj.epsg}` : null].filter(Boolean).join(' · ')])
  } else if (s) {
    rows.push(['Projection', 'Not stated in the file'])
  }
  return (
    <div className="map-info">
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {proj?.wkt && (
        <details>
          <summary>Projection WKT</summary>
          <code>{proj.wkt}</code>
        </details>
      )}
      {map.drawErrors?.length ? (
        <div className="map-warning">Parts of this map didn't draw: {map.drawErrors.join('; ')}</div>
      ) : null}
      <button className="btn small" onClick={onBack}>
        Back
      </button>
    </div>
  )
}
