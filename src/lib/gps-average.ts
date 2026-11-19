/**
 * Plot GPS average: many GPS fixes → one precise placemark (Avenza Pro's
 * "Plot GPS Average").
 *
 * 1. A fix whose reported accuracy is worse than the limit (default 20 m) is
 *    discarded. So is one with no accuracy at all.
 * 2. With 5 or more fixes left, a fix far from the rest is discarded as an
 *    outlier: more than 3× the median distance from the median position, and
 *    more than 2 m away. (Multipath jumps under trees and cliffs often still
 *    report a good accuracy.) For a normal scatter this discards about 1 fix
 *    in 500.
 * 3. The average is the plain mean of the fixes kept, taken in a local flat
 *    frame (metres east and north), which is exact enough at these distances.
 *
 * Spread is the RMS distance of the kept fixes from the average. Fixes a
 * second apart are strongly correlated, so spread is shown as is; it is not
 * divided by √n into an "error of the mean" that would look better than it is.
 *
 * Pure: no DOM, no GPS, so the sheet and the tests share it.
 */
import type { Position } from 'geojson'
import { metresPerDegree } from './geodesic'

export interface AverageFix {
  lng: number
  lat: number
  /** Reported horizontal accuracy, metres; null if the device gave none. */
  accuracy: number | null
  altitude: number | null
  /** ms since 1970 */
  time: number
}

export const DEFAULT_MAX_ACCURACY_M = 20
/** Limits offered in the sheet (metres). */
export const ACCURACY_LIMITS_M = [5, 10, 20, 50, 100]

export interface AverageOptions {
  /** Discard fixes with a reported accuracy worse than this (metres). */
  maxAccuracyM?: number
  /** Outlier = farther than this × the median distance from the median... */
  outlierFactor?: number
  /** ...and farther than this (metres). */
  outlierFloorM?: number
  /** Only look for outliers with at least this many accurate fixes. */
  minForOutliers?: number
}

export type FixStatus = 'kept' | 'inaccurate' | 'outlier'

export interface AverageResult {
  /** The average, [lng, lat]; null until a fix is kept. */
  position: Position | null
  /** Mean of the kept fixes' altitudes (metres), when they have one. */
  altitude: number | null
  /** Fixes used in the average. */
  count: number
  /** Fixes received. */
  received: number
  /** Discarded for poor (or missing) accuracy. */
  inaccurate: number
  /** Discarded as outliers. */
  outliers: number
  /** Mean reported accuracy of the kept fixes (metres). */
  meanAccuracyM: number | null
  /** RMS distance of the kept fixes from the average (metres); null below 2 fixes. */
  spreadM: number | null
  /** Time of the first and last kept fix. */
  startTime: number | null
  endTime: number | null
  /** One per input fix, in order. */
  status: FixStatus[]
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function averageFixes(fixes: AverageFix[], opts: AverageOptions = {}): AverageResult {
  const maxAcc = opts.maxAccuracyM ?? DEFAULT_MAX_ACCURACY_M
  const factor = opts.outlierFactor ?? 3
  const floor = opts.outlierFloorM ?? 2
  const minForOutliers = opts.minForOutliers ?? 5

  const status: FixStatus[] = fixes.map((f) =>
    f.accuracy != null && Number.isFinite(f.accuracy) && f.accuracy <= maxAcc &&
    Number.isFinite(f.lng) && Number.isFinite(f.lat)
      ? 'kept'
      : 'inaccurate',
  )
  const accurate = fixes.filter((_, i) => status[i] === 'kept')
  const empty: AverageResult = {
    position: null,
    altitude: null,
    count: 0,
    received: fixes.length,
    inaccurate: fixes.length,
    outliers: 0,
    meanAccuracyM: null,
    spreadM: null,
    startTime: null,
    endTime: null,
    status,
  }
  if (!accurate.length) return empty

  // Local frame: metres east/north of the first accurate fix (true there, on WGS84).
  const lng0 = accurate[0].lng
  const lat0 = accurate[0].lat
  const { east: kx, north: ky } = metresPerDegree(lat0)
  const xy = (f: AverageFix) => [(f.lng - lng0) * kx, (f.lat - lat0) * ky]

  if (accurate.length >= minForOutliers) {
    const pts = accurate.map(xy)
    const mx = median(pts.map((p) => p[0]))
    const my = median(pts.map((p) => p[1]))
    const dist = pts.map(([x, y]) => Math.hypot(x - mx, y - my))
    const limit = Math.max(factor * median(dist), floor)
    let k = 0
    for (let i = 0; i < fixes.length; i++) {
      if (status[i] !== 'kept') continue
      if (dist[k++] > limit) status[i] = 'outlier'
    }
  }

  const kept = fixes.filter((_, i) => status[i] === 'kept')
  const pts = kept.map(xy)
  const n = kept.length
  const cx = pts.reduce((s, p) => s + p[0], 0) / n
  const cy = pts.reduce((s, p) => s + p[1], 0) / n
  const spreadM =
    n >= 2 ? Math.sqrt(pts.reduce((s, [x, y]) => s + (x - cx) ** 2 + (y - cy) ** 2, 0) / n) : null
  const alts = kept.map((f) => f.altitude).filter((a): a is number => a != null && Number.isFinite(a))
  const times = kept.map((f) => f.time)
  return {
    position: [lng0 + cx / kx, lat0 + cy / ky],
    altitude: alts.length ? alts.reduce((s, a) => s + a, 0) / alts.length : null,
    count: n,
    received: fixes.length,
    inaccurate: status.filter((s) => s === 'inaccurate').length,
    outliers: status.filter((s) => s === 'outlier').length,
    meanAccuracyM: kept.reduce((s, f) => s + (f.accuracy as number), 0) / n,
    spreadM,
    startTime: Math.min(...times),
    endTime: Math.max(...times),
    status,
  }
}

// ---- When to stop ----

export type StopRule =
  | { kind: 'manual' }
  | { kind: 'seconds'; value: number }
  | { kind: 'fixes'; value: number }

export const STOP_RULES: StopRule[] = [
  { kind: 'manual' },
  { kind: 'seconds', value: 30 },
  { kind: 'seconds', value: 60 },
  { kind: 'fixes', value: 20 },
  { kind: 'fixes', value: 60 },
]

export function stopRuleLabel(rule: StopRule): string {
  if (rule.kind === 'seconds') return `${rule.value} s`
  if (rule.kind === 'fixes') return `${rule.value} fixes`
  return 'Manual'
}

export function sameStopRule(a: StopRule, b: StopRule): boolean {
  return a.kind === b.kind && (a.kind === 'manual' || (a as { value: number }).value === (b as { value: number }).value)
}

/** Has averaging reached its stop rule? A fix count counts kept fixes only. */
export function stopReached(rule: StopRule, keptCount: number, elapsedMs: number): boolean {
  if (rule.kind === 'seconds') return elapsedMs >= rule.value * 1000
  if (rule.kind === 'fixes') return keptCount >= rule.value
  return false
}

// ---- The saved placemark ----

export const AVERAGE_FIELDS = {
  count: 'GPS fixes',
  meanAccuracy: 'Mean accuracy (m)',
  spread: 'Spread (m)',
  discarded: 'Discarded fixes',
  limit: 'Accuracy limit (m)',
  start: 'Start time',
  end: 'End time',
  altitude: 'GPS altitude (m)',
} as const

/** Attributes for the averaged placemark: numbers in metres and ISO times,
 * so they survive export to Avenza and GIS unchanged by unit settings. */
export function averageAttributes(r: AverageResult, maxAccuracyM: number): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [{ k: AVERAGE_FIELDS.count, v: String(r.count) }]
  if (r.meanAccuracyM != null) out.push({ k: AVERAGE_FIELDS.meanAccuracy, v: r.meanAccuracyM.toFixed(1) })
  if (r.spreadM != null) out.push({ k: AVERAGE_FIELDS.spread, v: r.spreadM.toFixed(2) })
  out.push({ k: AVERAGE_FIELDS.discarded, v: String(r.inaccurate + r.outliers) })
  out.push({ k: AVERAGE_FIELDS.limit, v: String(maxAccuracyM) })
  if (r.startTime != null) out.push({ k: AVERAGE_FIELDS.start, v: new Date(r.startTime).toISOString() })
  if (r.endTime != null) out.push({ k: AVERAGE_FIELDS.end, v: new Date(r.endTime).toISOString() })
  if (r.altitude != null) out.push({ k: AVERAGE_FIELDS.altitude, v: r.altitude.toFixed(1) })
  return out
}
