import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MlMap, GeoJSONSource } from 'maplibre-gl'
import type { FeatureCollection, Position } from 'geojson'
import {
  ACCURACY_LIMITS_M,
  averageAttributes,
  averageFixes,
  DEFAULT_MAX_ACCURACY_M,
  sameStopRule,
  STOP_RULES,
  stopReached,
  stopRuleLabel,
  type AverageFix,
  type AverageResult,
  type StopRule,
} from '../lib/gps-average'
import { formatCoord } from '../lib/coords'
import { DEFAULT_LAYERS } from '../lib/features'
import { layerTree, type Layer } from '../lib/layers'
import { formatDuration } from '../lib/track'
import { formatDistance } from '../lib/units'
import { subscribeFix, type GpsFix } from '../lib/position'
import { useUnitSettings } from '../hooks/useUnitSettings'
import { useNow } from '../hooks/useGpsFix'
import './GpsTools.css'

export interface AveragedPlacemark {
  position: Position
  notes: string
  attributes: { k: string; v: string }[]
  /** Chosen layer id; null = the default placemark layer. */
  layerId: string | null
}

interface Settings {
  rule: StopRule
  maxAccuracyM: number
  layerId?: string
}

const KEY = 'carmanah-gps-average'

function loadSettings(): Settings {
  const fallback: Settings = { rule: STOP_RULES[2], maxAccuracyM: DEFAULT_MAX_ACCURACY_M }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null
    if (!raw) return fallback
    const rule = STOP_RULES.find((r) => raw.rule && sameStopRule(r, raw.rule)) ?? fallback.rule
    const maxAccuracyM = ACCURACY_LIMITS_M.includes(raw.maxAccuracyM as number)
      ? (raw.maxAccuracyM as number)
      : fallback.maxAccuracyM
    return { rule, maxAccuracyM, layerId: typeof raw.layerId === 'string' ? raw.layerId : undefined }
  } catch {
    return fallback
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Storage unavailable: the choice holds for this session.
  }
}

export function averageNotes(r: AverageResult): string {
  return [
    `Averaged from ${r.count} GPS fix${r.count === 1 ? '' : 'es'}`,
    r.startTime != null && r.endTime != null && r.endTime > r.startTime
      ? `over ${formatDuration(r.endTime - r.startTime)}`
      : null,
    r.spreadM != null ? `spread ±${formatDistance(r.spreadM)}` : null,
    r.meanAccuracyM != null ? `mean accuracy ±${formatDistance(r.meanAccuracyM)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

type Phase = 'ready' | 'running' | 'done'

/**
 * Plot GPS average: collect fixes until the stop rule (manual, a timer or a
 * number of fixes), discarding poor ones, then save one placemark at the
 * average. The fixes are drawn on the map while it runs.
 */
export default function GpsAverageSheet({
  map,
  layers,
  onSave,
  onClose,
}: {
  map: MlMap | null
  layers: Layer[]
  onSave: (placemark: AveragedPlacemark) => void
  onClose: () => void
}) {
  const units = useUnitSettings()
  const [settings, setSettings] = useState(loadSettings)
  const update = (patch: Partial<Settings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })

  const [phase, setPhase] = useState<Phase>('ready')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const [fixes, setFixes] = useState<AverageFix[]>([])
  const [current, setCurrent] = useState<GpsFix | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState(0)
  const [endedAt, setEndedAt] = useState(0)
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null)
  const centredRef = useRef(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const now = useNow(phase === 'running', 250)

  // Listen while the sheet is open, so "accuracy now" shows before starting.
  useEffect(
    () =>
      subscribeFix(
        (f) => {
          setCurrent(f)
          setError(null)
          if (phaseRef.current !== 'running') return
          setFixes((prev) => {
            const last = prev[prev.length - 1]
            if (last && last.time === f.time && last.lng === f.lng && last.lat === f.lat) return prev
            return [...prev, { lng: f.lng, lat: f.lat, accuracy: f.accuracy, altitude: f.altitude, time: f.time }]
          })
        },
        setError,
      ),
    [],
  )

  const result = useMemo(
    () => averageFixes(fixes, { maxAccuracyM: settings.maxAccuracyM }),
    [fixes, settings.maxAccuracyM],
  )
  const elapsed = phase === 'ready' ? 0 : (phase === 'running' ? now : endedAt) - startedAt

  const releaseWakeLock = () => {
    wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
  }
  useEffect(() => releaseWakeLock, [])

  const start = () => {
    setFixes([])
    setStartedAt(Date.now())
    setEndedAt(0)
    centredRef.current = false
    phaseRef.current = 'running'
    setPhase('running')
    // GPS in a browser stops when the screen sleeps.
    navigator.wakeLock?.request('screen').then(
      (lock) => {
        wakeLockRef.current = lock
      },
      () => {},
    )
  }
  const finish = () => {
    phaseRef.current = 'done'
    setPhase('done')
    setEndedAt(Date.now())
    releaseWakeLock()
  }

  useEffect(() => {
    if (phase === 'running' && stopReached(settings.rule, result.count, now - startedAt)) finish()
  }, [phase, settings.rule, result.count, now, startedAt])

  // Bring the averaging spot into view, above this sheet, at its first fix.
  useEffect(() => {
    if (!map || !result.position || centredRef.current) return
    centredRef.current = true
    const [lng, lat] = result.position
    const sheetH = sheetRef.current?.offsetHeight ?? 0
    const box = map.getContainer()
    const p = map.project([lng, lat])
    const visible =
      p.x >= 0 && p.x <= box.clientWidth && p.y >= 0 && p.y <= box.clientHeight - sheetH - 20
    if (!visible) {
      // offset (not padding): padding would stay on the map and move the
      // crosshair readout off the crosshair.
      map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 18), offset: [0, -sheetH / 2] })
    }
  }, [map, result.position])

  useFixesOverlay(map, fixes, result)

  // Layer choice: the saved one if it still exists, else where a dropped pin goes.
  const tree = layerTree(layers)
  const defaultLayer = layers.find((l) => !l.parentId && !l.source && l.name === DEFAULT_LAYERS.pin)
  const layerId =
    settings.layerId && layers.some((l) => l.id === settings.layerId)
      ? settings.layerId
      : (defaultLayer?.id ?? '')

  const save = () => {
    if (!result.position) return
    onSave({
      position: result.position,
      notes: averageNotes(result),
      attributes: averageAttributes(result, settings.maxAccuracyM),
      layerId: layerId || null,
    })
  }

  const rule = settings.rule
  const progress =
    rule.kind === 'seconds'
      ? Math.min(1, elapsed / (rule.value * 1000))
      : rule.kind === 'fixes'
        ? Math.min(1, result.count / rule.value)
        : null
  const accNow = current?.accuracy != null ? `±${formatDistance(current.accuracy)}` : '—'
  const discarded = result.inaccurate + result.outliers

  let status: string
  if (phase === 'ready') {
    status = current
      ? `GPS ready · accuracy now ${accNow}`
      : error
        ? `GPS: ${error}`
        : 'Waiting for GPS…'
  } else if (phase === 'running') {
    status =
      `Averaging… ${result.count}${rule.kind === 'fixes' ? ` of ${rule.value}` : ''} fix${result.count === 1 ? '' : 'es'}` +
      ` · ${formatDuration(elapsed)}${rule.kind === 'seconds' ? ` of ${formatDuration(rule.value * 1000)}` : ''}`
  } else {
    status = result.count
      ? `Done · ${result.count} fix${result.count === 1 ? '' : 'es'} averaged`
      : `No fix was within ${formatDistance(settings.maxAccuracyM)}: raise the limit or try again`
  }

  return (
    <div ref={sheetRef} className="feature-sheet gps-sheet" role="dialog" aria-label="Plot GPS average">
      <div className="sheet-header">
        <span className="kind-icon">🎯</span>
        <span className="sheet-title">Plot GPS average</span>
        <button className="btn" onClick={onClose}>
          {phase === 'running' ? 'Cancel' : 'Close'}
        </button>
      </div>
      <div className="sheet-scroll">
        <div className={`gps-status${phase === 'done' && !result.count ? ' error' : ''}`}>{status}</div>
        {progress != null && phase !== 'ready' && (
          <div className="gps-progress" aria-hidden>
            <span style={{ width: `${progress * 100}%` }} />
          </div>
        )}

        {phase !== 'ready' && (
          <>
            <dl className="gps-grid">
              <div>
                <dt>Fixes used</dt>
                <dd>
                  {result.count}
                  {discarded > 0 && <small> ({discarded} discarded)</small>}
                </dd>
              </div>
              <div>
                <dt>Accuracy now</dt>
                <dd>{accNow}</dd>
              </div>
              <div>
                <dt>Mean accuracy</dt>
                <dd>{result.meanAccuracyM != null ? `±${formatDistance(result.meanAccuracyM)}` : '—'}</dd>
              </div>
              <div>
                <dt>Spread (RMS)</dt>
                <dd>{result.spreadM != null ? `±${formatDistance(result.spreadM)}` : '—'}</dd>
              </div>
            </dl>
            {result.position && (
              <div className="gps-position">
                <span className="gps-format">Average</span>
                <span className="gps-coords">{formatCoord(result.position, units.coords)}</span>
              </div>
            )}
            {discarded > 0 && (
              <div className="settings-hint">
                {result.inaccurate > 0 &&
                  `${result.inaccurate} worse than ${formatDistance(settings.maxAccuracyM)}`}
                {result.inaccurate > 0 && result.outliers > 0 && ' · '}
                {result.outliers > 0 && `${result.outliers} far from the rest`}
              </div>
            )}
          </>
        )}

        <div className="gps-setting">
          <span>Stop</span>
          <div className="gps-chips">
            {STOP_RULES.map((r) => (
              <button
                key={stopRuleLabel(r)}
                className={`btn small${sameStopRule(r, rule) ? ' active' : ''}`}
                onClick={() => update({ rule: r })}
              >
                {stopRuleLabel(r)}
              </button>
            ))}
          </div>
        </div>
        <label className="gps-setting">
          <span>Discard fixes worse than</span>
          <select
            value={settings.maxAccuracyM}
            onChange={(e) => update({ maxAccuracyM: Number(e.target.value) })}
          >
            {ACCURACY_LIMITS_M.map((m) => (
              <option key={m} value={m}>
                {formatDistance(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="gps-setting">
          <span>Save to layer</span>
          <select value={layerId} onChange={(e) => update({ layerId: e.target.value || undefined })}>
            {!defaultLayer && <option value="">{DEFAULT_LAYERS.pin} (new)</option>}
            {tree.map(({ layer, depth }) => (
              <option key={layer.id} value={layer.id}>
                {'  '.repeat(depth)}
                {layer.name}
              </option>
            ))}
          </select>
        </label>

        <div className="gps-actions">
          {phase === 'ready' && (
            <button className="btn primary" onClick={start}>
              Start averaging
            </button>
          )}
          {phase === 'running' && (
            <button className="btn primary" onClick={finish}>
              {rule.kind === 'manual' ? 'Stop' : 'Stop now'}
            </button>
          )}
          {phase === 'done' && (
            <>
              <button className="btn primary" disabled={!result.position} onClick={save}>
                Save placemark
              </button>
              <button className="btn" onClick={start}>
                Average again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const SOURCE = 'gps-average'
const LAYERS = ['gps-average-fixes', 'gps-average-mean']

/** Draw the fixes (kept / discarded) and the average on the map. */
function useFixesOverlay(map: MlMap | null, fixes: AverageFix[], result: AverageResult) {
  useEffect(() => {
    if (!map) return
    const data: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        ...fixes.map((f, i) => ({
          type: 'Feature' as const,
          properties: { status: result.status[i] },
          geometry: { type: 'Point' as const, coordinates: [f.lng, f.lat] },
        })),
        ...(result.position
          ? [
              {
                type: 'Feature' as const,
                properties: { status: 'average' },
                geometry: { type: 'Point' as const, coordinates: result.position },
              },
            ]
          : []),
      ],
    }
    try {
      const source = map.getSource(SOURCE) as GeoJSONSource | undefined
      if (source) {
        source.setData(data)
        return
      }
      map.addSource(SOURCE, { type: 'geojson', data })
      map.addLayer({
        id: LAYERS[0],
        type: 'circle',
        source: SOURCE,
        filter: ['!=', ['get', 'status'], 'average'],
        paint: {
          'circle-radius': 4,
          'circle-color': [
            'match',
            ['get', 'status'],
            'kept',
            '#38bdf8',
            'outlier',
            '#f87171',
            '#9ca3af',
          ],
          'circle-opacity': 0.85,
          'circle-stroke-color': '#0c4a6e',
          'circle-stroke-width': 1,
        },
      })
      map.addLayer({
        id: LAYERS[1],
        type: 'circle',
        source: SOURCE,
        filter: ['==', ['get', 'status'], 'average'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#f97316',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 3,
        },
      })
    } catch {
      // Style still loading: the next fix tries again.
    }
  }, [map, fixes, result])

  useEffect(
    () => () => {
      if (!map) return
      try {
        for (const id of LAYERS) if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(SOURCE)) map.removeSource(SOURCE)
      } catch {
        // Map already gone.
      }
    },
    [map],
  )
}
