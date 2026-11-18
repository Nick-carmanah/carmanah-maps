import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatBytes } from '../lib/library/library'
import { UNSORTED, type LibraryMap } from '../lib/library/types'
import type { FileStore } from '../lib/storage/files'
import './MapsLibrary.css'

type Patch = Partial<Omit<LibraryMap, 'id'>>

interface MapsLibraryProps {
  maps: LibraryMap[]
  /** The fire this phone is on: its folder is listed first and new maps go there. */
  currentFolder: string
  storageBackend: FileStore['backend'] | null
  onClose: () => void
  onImport: () => void
  onUpdate: (id: string, patch: Patch, persist?: boolean) => void
  onRemove: (id: string) => Promise<void>
  onZoomTo: (id: string) => void
  readOriginal: (map: LibraryMap) => Promise<File | null>
  onShare: (file: File) => void
}

const folderLabel = (folder: string) => folder || UNSORTED

/** The Maps library: imported maps by fire, with Avenza's per-map actions. */
export default function MapsLibrary({
  maps,
  currentFolder,
  storageBackend,
  onClose,
  onImport,
  onUpdate,
  onRemove,
  onZoomTo,
  readOriginal,
  onShare,
}: MapsLibraryProps) {
  const [filter, setFilter] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const thumbs = useThumbnailUrls(maps)

  const folders = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const byFolder = new Map<string, LibraryMap[]>()
    for (const m of maps) {
      if (needle && !`${m.name} ${m.folder} ${m.source?.fileName ?? ''}`.toLowerCase().includes(needle)) continue
      const list = byFolder.get(m.folder) ?? []
      list.push(m)
      byFolder.set(m.folder, list)
    }
    // Current fire first, then A–Z, Unsorted last.
    return [...byFolder.entries()].sort(([a], [b]) => {
      const rank = (f: string) => (f === currentFolder && f ? 0 : f ? 1 : 2)
      return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true })
    })
  }, [maps, filter, currentFolder])

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

  return (
    <div className="layer-panel maps-library" role="dialog" aria-label="Maps">
      <div className="panel-header">
        <span>Maps{maps.length ? ` (${maps.length})` : ''}</span>
        <span className="maps-header-actions">
          <button className="btn small primary" onClick={onImport}>
            + Import
          </button>
          <button className="panel-close" onClick={onClose} aria-label="Close maps">
            ✕
          </button>
        </span>
      </div>

      {maps.length > 0 && (
        <div className="maps-note">
          {formatBytes(totalBytes)} on this {storageBackend === 'native' ? 'phone' : 'device'}
          {storageBackend !== 'native' &&
            ' · The browser can clear website storage when space runs low, so keep your original files.'}
        </div>
      )}

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
          No maps yet. Import a GeoPDF (from Avenza, BCWS or any GIS) and it will be saved here for offline use,
          sorted by fire.
        </div>
      )}

      {folders.map(([folder, list]) => (
        <section key={folder || '\u0000'} className="maps-folder">
          <button className="maps-folder-header" onClick={() => toggleFolder(folder)}>
            <span className="maps-caret" aria-hidden>
              {collapsed.has(folder) ? '▸' : '▾'}
            </span>
            <span className="maps-folder-name">{folderLabel(folder)}</span>
            {folder && folder === currentFolder && <span className="maps-badge">this fire</span>}
            <span className="maps-count">{list.length}</span>
          </button>
          {!collapsed.has(folder) &&
            list.map((m) => (
              <MapRow
                key={m.id}
                map={m}
                thumbUrl={thumbs.get(m.id)}
                open={openId === m.id}
                folderNames={folderNames}
                onOpen={setOpenId}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onZoomTo={onZoomTo}
                readOriginal={readOriginal}
                onShare={onShare}
              />
            ))}
        </section>
      ))}
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
  folderNames: string[]
  onOpen: (id: string | null) => void
  onUpdate: (id: string, patch: Patch, persist?: boolean) => void
  onRemove: (id: string) => Promise<void>
  onZoomTo: (id: string) => void
  readOriginal: (map: LibraryMap) => Promise<File | null>
  onShare: (file: File) => void
}

type Panel = 'actions' | 'info' | 'rename' | 'move'

const MapRow = memo(function MapRow({
  map,
  thumbUrl,
  open,
  folderNames,
  onOpen,
  onUpdate,
  onRemove,
  onZoomTo,
  readOriginal,
  onShare,
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
    <div className={`map-row${open ? ' open' : ''}`}>
      <div className="map-row-main">
        <button
          className="map-thumb"
          onClick={() => onZoomTo(map.id)}
          title="Zoom to map"
          aria-label={`Zoom to ${map.name}`}
        >
          {thumbUrl ? <img src={thumbUrl} alt="" loading="lazy" decoding="async" /> : <span aria-hidden>🗺</span>}
        </button>
        <button className="map-text" onClick={() => onOpen(open ? null : map.id)} aria-expanded={open}>
          <span className="map-name">{map.name}</span>
          <span className="map-meta">
            {formatDate(map.addedAt)} · {formatBytes(mapBytes(map))}
            {map.source && map.source.pageCount > 1 && ` · p${map.source.pageIndex + 1}`}
          </span>
          {legacy && <span className="map-legacy">Re-import to share or sharpen</span>}
        </button>
        <label className="map-visible" title={map.visible ? 'Hide map' : 'Show map'}>
          <input
            type="checkbox"
            checked={map.visible}
            onChange={() => onUpdate(map.id, { visible: !map.visible })}
            aria-label={map.visible ? `Hide ${map.name}` : `Show ${map.name}`}
          />
        </label>
      </div>

      {open && (
        <div className="map-actions">
          <label className="map-opacity">
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
            />
            <span className="map-opacity-value">{Math.round(map.opacity * 100)}%</span>
          </label>

          {panel === 'actions' && (
            <div className="map-action-grid">
              <button className="btn small" onClick={() => onZoomTo(map.id)}>
                Zoom to
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
  if (map.raster.kind === 'image') rows.push(['Drawn at', `${map.raster.width} × ${map.raster.height} px`])
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
