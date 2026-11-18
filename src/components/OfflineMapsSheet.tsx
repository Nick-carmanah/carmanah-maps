import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import type { FeatureCollection, Position } from 'geojson'
import './OfflineMapsSheet.css'
import type { LiveFires } from '../lib/livefires'
import type { UserFeature } from '../lib/features'
import { areaBbox, bboxRing, ringsFromGeoJSON, ringsHectares, type Bbox, type LonLat, type PackArea } from '../lib/packs/area'
import { loadCatalog, resolveUrl, sourceFor, PACKS_URL, type LoadedCatalog } from '../lib/packs/catalog'
import { OFM_MAX_TILES, planCut, planSmall, planWhole, type PlannedDownload } from '../lib/packs/download'
import { packDownloads, type SmallSources } from '../lib/packs/manager'
import { packRegistry } from '../lib/packs/registry'
import { formatArea } from '../lib/units'

/**
 * Offline maps: the packs saved on this phone, and "Download this fire":
 * a live BCWS fire's perimeter, one of the person's areas, or the map view,
 * plus a buffer. The size is worked out before anything downloads.
 */

interface Props {
  map: MlMap | null
  liveFires: LiveFires | null
  userFeatures: UserFeature[]
  native: boolean
  small: SmallSources
  onClose: () => void
  onNotify: (message: string, isError?: boolean) => void
}

type Choice = 'fire' | 'area' | 'view'

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'cut'; planned: PlannedDownload; partial: boolean }
  | { state: 'small'; tiles: number; estimate: number }
  | { state: 'error'; message: string }

const BUFFERS = [0, 2, 5, 10]

export const formatMB = (bytes: number) => (bytes < 1e6 ? `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e6).toFixed(bytes < 1e8 ? 1 : 0)} MB`)
const formatDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Live fires with a perimeter, nearest to the map centre first. */
function firesWithPerimeters(live: LiveFires | null, center: LonLat | null) {
  if (!live) return []
  const names = new Map<string, string>()
  for (const f of live.points.features) {
    const p = f.properties ?? {}
    if (p.FIRE_NUMBER && p.INCIDENT_NAME) names.set(String(p.FIRE_NUMBER), String(p.INCIDENT_NAME))
  }
  const byFire = new Map<string, FeatureCollection>()
  for (const f of live.perimeters.features) {
    const num = String(f.properties?.FIRE_NUMBER ?? '')
    if (!num) continue
    const fc = byFire.get(num) ?? { type: 'FeatureCollection', features: [] }
    fc.features.push(f)
    byFire.set(num, fc)
  }
  const out = [...byFire.entries()].map(([fireNumber, fc]) => {
    const rings = ringsFromGeoJSON(fc)
    const bbox = areaBbox({ rings, bufferM: 0 })
    const mid: LonLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
    const dist = center ? Math.hypot((mid[0] - center[0]) * Math.cos((center[1] * Math.PI) / 180), mid[1] - center[1]) : 0
    const name = names.get(fireNumber)
    return { fireNumber, rings, name: name ? `${name} (${fireNumber})` : `Fire ${fireNumber}`, hectares: ringsHectares(rings), dist }
  })
  return out.filter((f) => f.rings.length).sort((a, b) => a.dist - b.dist)
}

export default function OfflineMapsSheet({ map, liveFires, userFeatures, native, small, onClose, onNotify }: Props) {
  const [choice, setChoice] = useState<Choice>('fire')
  const [fireNumber, setFireNumber] = useState<string | null>(null)
  const [areaId, setAreaId] = useState<string | null>(null)
  const [bufferKm, setBufferKm] = useState(5)
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [catalog, setCatalog] = useState<LoadedCatalog | null | 'error'>(null)
  const [supported, setSupported] = useState<boolean | null>(null)

  // Re-render when packs or downloads change.
  const version = useSyncExternalStore(
    (fn) => {
      const a = packRegistry.subscribe(fn)
      const b = packDownloads.subscribe(fn)
      return () => {
        a()
        b()
      }
    },
    () => `${packRegistry.packs.length}/${packRegistry.jobs.length}/${[...packDownloads.active.values()].map((d) => `${d.id}:${d.progress.done}:${d.progress.waiting}`).join()}`,
  )

  useEffect(() => {
    void packRegistry.store().then((s) => setSupported(!!s))
    if (PACKS_URL) {
      loadCatalog()
        .then((c) => setCatalog(c))
        .catch(() => setCatalog('error'))
    }
  }, [])

  const center = useMemo<LonLat | null>(() => {
    const c = map?.getCenter()
    return c ? [c.lng, c.lat] : null
  }, [map])
  const fires = useMemo(() => firesWithPerimeters(liveFires, center), [liveFires, center])
  const areas = useMemo(() => userFeatures.filter((f) => f.kind === 'area' && (f.coordinates as Position[]).length >= 3), [userFeatures])

  useEffect(() => {
    if (!fireNumber && fires[0]) setFireNumber(fires[0].fireNumber)
  }, [fires, fireNumber])
  useEffect(() => {
    if (!areaId && areas[0]) setAreaId(areas[0].id)
  }, [areas, areaId])
  // Any change of area or buffer needs a new size check.
  useEffect(() => setCheck({ state: 'idle' }), [choice, fireNumber, areaId, bufferKm])

  /** The area chosen, as a pack request (without its id). */
  const request = (): { name: string; fireNumber?: string; area: PackArea } | null => {
    const bufferM = bufferKm * 1000
    if (choice === 'fire') {
      const f = fires.find((x) => x.fireNumber === fireNumber)
      return f ? { name: f.name, fireNumber: f.fireNumber, area: { rings: f.rings, bufferM } } : null
    }
    if (choice === 'area') {
      const f = areas.find((x) => x.id === areaId)
      if (!f) return null
      const ring = (f.coordinates as Position[]).map(([x, y]) => [x, y] as LonLat)
      return { name: f.name || 'My area', area: { rings: [ring], bufferM } }
    }
    const b = map?.getBounds()
    if (!b) return null
    const bbox: Bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
    const mid = `${((bbox[1] + bbox[3]) / 2).toFixed(3)}, ${((bbox[0] + bbox[2]) / 2).toFixed(3)}`
    return { name: `Map view ${mid}`, area: { rings: [bboxRing(bbox)], bufferM } }
  }

  const checkSize = async () => {
    const r = request()
    if (!r) return
    setCheck({ state: 'checking' })
    try {
      const id = await packDownloads.freeId(r.fireNumber ?? r.name)
      const loaded = catalog && catalog !== 'error' ? catalog : null
      const bbox = areaBbox(r.area)
      const b = loaded && sourceFor(loaded.catalog.sources.basemap, bbox)
      const t = loaded && sourceFor(loaded.catalog.sources.terrain, bbox)
      if (loaded && b && t) {
        const planned = await planCut(
          { id, ...r },
          { url: resolveUrl(b.url, loaded.url), build: b.build },
          { url: resolveUrl(t.url, loaded.url), version: t.version },
        )
        const inside = (s: { bounds: Bbox }) => bbox[0] >= s.bounds[0] && bbox[1] >= s.bounds[1] && bbox[2] <= s.bounds[2] && bbox[3] <= s.bounds[3]
        setCheck({ state: 'cut', planned, partial: !inside(b) })
        return
      }
      const tiles = planSmall(r.area)
      if (tiles.basemap.length > OFM_MAX_TILES) {
        setCheck({
          state: 'error',
          message: PACKS_URL
            ? `This area isn't in the hosted offline maps yet, and it's too big to save straight from the map server (${tiles.basemap.length.toLocaleString()} tiles; the limit is ${OFM_MAX_TILES.toLocaleString()}). Choose a smaller area.`
            : `Too big to save without hosted offline maps (${tiles.basemap.length.toLocaleString()} tiles; the limit is ${OFM_MAX_TILES.toLocaleString()}). Zoom in or choose a smaller area.`,
        })
        return
      }
      // Measured: ~6 kB per vector tile as served, ~40 kB per terrain tile.
      setCheck({ state: 'small', tiles: tiles.basemap.length + tiles.terrain.length, estimate: tiles.basemap.length * 6000 + tiles.terrain.length * 40000 })
    } catch (err) {
      setCheck({ state: 'error', message: `Couldn't work out the size: ${(err as Error).message}. Check the signal and try again.` })
    }
  }

  const download = async () => {
    const r = request()
    if (!r) return
    try {
      if (check.state === 'cut') {
        void packDownloads.start(check.planned)
      } else if (check.state === 'small') {
        const id = await packDownloads.freeId(r.fireNumber ?? r.name)
        void packDownloads.startSmall({ id, ...r }, small)
      }
      setCheck({ state: 'idle' })
      onNotify(`Downloading ${r.name}. It carries on if you close this.`)
    } catch (err) {
      onNotify((err as Error).message, true)
    }
  }

  const downloadReady = async (url: string, name: string) => {
    try {
      const planned = await planWhole(url)
      if (packRegistry.packs.some((p) => p.id === planned.job.id)) {
        onNotify(`${name} is already saved`)
        return
      }
      void packDownloads.start(planned)
      onNotify(`Downloading ${name}`)
    } catch (err) {
      onNotify(`Couldn't start ${name}: ${(err as Error).message}`, true)
    }
  }

  const remove = async (id: string, name: string, bytes: number) => {
    if (!window.confirm(`Delete the offline map "${name}" (${formatMB(bytes)}) from this ${native ? 'phone' : 'browser'}?`)) return
    await packDownloads.remove(id)
    onNotify(`Deleted ${name}`)
  }

  const showOnMap = (bbox: Bbox) => {
    map?.fitBounds([bbox[0], bbox[1], bbox[2], bbox[3]], { padding: 30, duration: 600 })
    onClose()
  }

  // Rows: finished packs, then partial downloads (running or not).
  void version
  const rows = [
    ...packRegistry.packs.map((p) => ({ id: p.id, name: p.name, done: true as const, bytes: p.bytes, created: p.created, bbox: p.bbox, job: null })),
    ...packRegistry.jobs.map((j) => ({ id: j.id, name: j.name, done: false as const, bytes: j.bytesTotal, created: '', bbox: null, job: j })),
    ...[...packDownloads.active.values()]
      .filter((a) => !packRegistry.jobs.some((j) => j.id === a.id) && !packRegistry.packs.some((p) => p.id === a.id))
      .map((a) => ({ id: a.id, name: a.name, done: false as const, bytes: a.progress.total, created: '', bbox: null, job: null })),
  ]
  const totalBytes = rows.reduce((s, r) => s + (r.done ? r.bytes : (packRegistry.sizes.get(r.id) ?? 0)), 0)
  const fire = fires.find((f) => f.fireNumber === fireNumber)
  const readyPacks = catalog && catalog !== 'error' ? catalog.catalog.packs : []

  return (
    <div className="sheet-wrap">
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="offline-sheet" role="dialog" aria-label="Offline maps">
        <div className="offline-head">
          <h2>Offline maps</h2>
          <button className="btn small" onClick={onClose}>
            Done
          </button>
        </div>

        {supported === false && (
          <p className="offline-note warn">
            This browser can’t keep offline maps. Use the Carmanah app, or Chrome, Firefox or Safari 26 and later.
          </p>
        )}

        {rows.length > 0 && (
          <section>
            <h3>
              Saved here <span className="muted">{formatMB(totalBytes)}</span>
            </h3>
            <ul className="pack-list">
              {rows.map((r) => {
                const active = packDownloads.active.get(r.id)
                const pct = active && active.progress.total ? Math.floor((100 * active.progress.done) / active.progress.total) : 0
                return (
                  <li key={r.id} className="pack-row">
                    <div className="pack-main">
                      <div className="pack-name">{r.name}</div>
                      <div className="pack-meta">
                        {r.done && `${formatMB(r.bytes)} · ${formatDate(r.created)}`}
                        {!r.done && active && (active.progress.waiting ? `Waiting for signal… ${pct}%` : `Downloading ${pct}% of ${formatMB(active.progress.total)}`)}
                        {!r.done && !active && r.job?.state === 'failed' && <span className="warn">Stopped: {r.job.error}</span>}
                        {!r.done && !active && r.job?.state !== 'failed' && `Paused · ${formatMB(packRegistry.sizes.get(r.id) ?? 0)} of ${formatMB(r.bytes)}`}
                      </div>
                      {!r.done && active && (
                        <div className="pack-bar">
                          <div style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                    <div className="pack-actions">
                      {r.done && r.bbox && (
                        <button className="btn small" onClick={() => showOnMap(r.bbox!)}>
                          Show
                        </button>
                      )}
                      {!r.done && active && (
                        <button className="btn small" onClick={() => packDownloads.pause(r.id)}>
                          Pause
                        </button>
                      )}
                      {!r.done && !active && (
                        <button className="btn small" onClick={() => void packDownloads.resume(r.id, small)}>
                          {r.job?.state === 'failed' ? 'Retry' : 'Resume'}
                        </button>
                      )}
                      <button className="btn small danger" aria-label={`Delete ${r.name}`} onClick={() => void remove(r.id, r.name, r.bytes)}>
                        Delete
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {supported !== false && (
          <section>
            <h3>Download an area</h3>
            <div className="seg" role="tablist">
              {(
                [
                  ['fire', 'A fire'],
                  ['area', 'My area'],
                  ['view', 'This view'],
                ] as [Choice, string][]
              ).map(([c, label]) => (
                <button key={c} role="tab" aria-selected={choice === c} className={`btn small${choice === c ? ' active' : ''}`} onClick={() => setChoice(c)}>
                  {label}
                </button>
              ))}
            </div>

            {choice === 'fire' &&
              (fires.length ? (
                <select className="offline-select" value={fireNumber ?? ''} onChange={(e) => setFireNumber(e.target.value)} aria-label="Fire">
                  {fires.map((f) => (
                    <option key={f.fireNumber} value={f.fireNumber}>
                      {f.name} · {formatArea(f.hectares * 10_000)}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="offline-note">
                  {liveFires ? 'No active fire perimeters right now.' : 'Turn on Live fires (Layers) to choose a fire perimeter.'}
                </p>
              ))}
            {choice === 'area' &&
              (areas.length ? (
                <select className="offline-select" value={areaId ?? ''} onChange={(e) => setAreaId(e.target.value)} aria-label="Area">
                  {areas.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name || 'Unnamed area'}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="offline-note">No areas in My Data yet. Draw one, or import a perimeter (KML, KMZ, shapefile).</p>
              ))}
            {choice === 'view' && <p className="offline-note">Everything on screen now.</p>}

            <div className="seg" aria-label="Buffer">
              <span className="muted">Plus</span>
              {BUFFERS.map((km) => (
                <button key={km} className={`btn small${bufferKm === km ? ' active' : ''}`} onClick={() => setBufferKm(km)}>
                  {km} km
                </button>
              ))}
            </div>

            {check.state === 'idle' && (
              <button className="btn primary wide" disabled={!request()} onClick={() => void checkSize()}>
                Check size
              </button>
            )}
            {check.state === 'checking' && <p className="offline-note">Working out the size…</p>}
            {check.state === 'error' && <p className="offline-note warn">{check.message}</p>}
            {(check.state === 'cut' || check.state === 'small') && (
              <div className="offline-confirm">
                <div>
                  {choice === 'fire' && fire ? `${fire.name}, ${formatArea(fire.hectares * 10_000)}` : request()?.name}
                  {bufferKm > 0 && ` + ${bufferKm} km`}
                </div>
                <div className="offline-size">
                  {check.state === 'cut'
                    ? `${formatMB(check.planned.job.bytesTotal)} · ${check.planned.job.files.reduce((s, f) => s + f.tiles, 0).toLocaleString()} tiles`
                    : `About ${formatMB(check.estimate)} · ${check.tiles.toLocaleString()} tiles from the map server`}
                </div>
                {check.state === 'cut' && check.partial && <div className="muted">Part of this area is outside the hosted maps; that part will need signal.</div>}
                <button className="btn primary wide" onClick={() => void download()}>
                  Download
                </button>
              </div>
            )}
          </section>
        )}

        {readyPacks.length > 0 && (
          <section>
            <h3>Ready-made</h3>
            <ul className="pack-list">
              {readyPacks.map((p) => (
                <li key={p.id} className="pack-row">
                  <div className="pack-main">
                    <div className="pack-name">{p.name}</div>
                    <div className="pack-meta">
                      {formatMB(p.bytes)} · {formatDate(p.created)}
                    </div>
                  </div>
                  <div className="pack-actions">
                    {packRegistry.packs.some((x) => x.id === p.id) ? (
                      <span className="muted">Saved</span>
                    ) : (
                      <button className="btn small" onClick={() => void downloadReady(resolveUrl(p.url, (catalog as LoadedCatalog).url), p.name)}>
                        Download
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="offline-note">
          {native
            ? 'Saved on this phone for everyone who signs in on it. Basemap and terrain only; satellite needs signal.'
            : 'Saved in this browser. It may clear them if the phone runs short of space: the Carmanah app keeps them safely. Basemap and terrain only; satellite needs signal.'}
          {catalog === 'error' && ' Hosted offline maps can’t be reached right now, so only small areas can be saved.'}
        </p>
      </div>
    </div>
  )
}
