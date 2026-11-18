/**
 * GPS tracks: segments and stats.
 *
 * Pausing a recording leaves a gap: the track is not drawn, measured or timed
 * between the last fix before the pause and the first fix after it. A saved
 * track keeps that as `UserFeature.segmentStarts` (the index of the first
 * vertex of each later segment), which the map, the feature sheet, the
 * exporters (KML gx:MultiTrack, GPX <trkseg>) and the importers all read
 * through the helpers here.
 *
 * Pure: no DOM, no storage, so the recorder, the feature sheet, the exporters
 * and the tests share one definition.
 */
import type { Position } from 'geojson'
import { haversineMeters, pathLengthMeters } from './measure'

/** Sorted, unique indexes strictly inside (0, length). Anything else is
 * dropped, so a stale or hand-edited list can never break a track. */
export function cleanSegmentStarts(starts: readonly number[] | undefined, length: number): number[] {
  if (!starts?.length) return []
  return [...new Set(starts.filter((i) => Number.isInteger(i) && i > 0 && i < length))].sort(
    (a, b) => a - b,
  )
}

/** Split a list at segment starts. Always returns at least one segment. */
export function splitSegments<T>(items: readonly T[], starts?: readonly number[]): T[][] {
  const out: T[][] = []
  let from = 0
  for (const cut of cleanSegmentStarts(starts, items.length)) {
    out.push(items.slice(from, cut))
    from = cut
  }
  out.push(items.slice(from))
  return out
}

/** Segment starts for parts laid end to end (the inverse of splitSegments). */
export function startsOfParts(parts: readonly { length: number }[]): number[] {
  const out: number[] = []
  let n = 0
  for (const part of parts.slice(0, -1)) {
    n += part.length
    out.push(n)
  }
  return out
}

/** Length of a path, leaving out the gaps between segments. */
export function segmentedLengthM(coords: Position[], starts?: readonly number[]): number {
  return splitSegments(coords, starts).reduce((sum, seg) => sum + pathLengthMeters(seg), 0)
}

/** Time spent recording: each segment's first to last fix, pauses left out. */
export function segmentedDurationMs(times: number[], starts?: readonly number[]): number {
  return splitSegments(times, starts).reduce(
    (sum, seg) => sum + (seg.length >= 2 ? seg[seg.length - 1] - seg[0] : 0),
    0,
  )
}

// ---- Recording ----

export interface TrackPoint {
  position: Position
  time: number
  altitude: number | null
  /** Recording was paused after this fix: the next fix starts a new segment. */
  pausedAfter?: boolean
}

/** Ignore GPS jitter below this distance between fixes. */
export const MIN_MOVE_M = 3

/** Add a fix to a recording. Jitter under MIN_MOVE_M is dropped, except for
 * the first fix after a pause, which always starts the new segment. */
export function appendFix(
  points: TrackPoint[],
  position: Position,
  time: number,
  altitude: number | null = null,
): TrackPoint[] {
  const last = points[points.length - 1]
  if (last && !last.pausedAfter && haversineMeters(last.position, position) < MIN_MOVE_M) {
    return points
  }
  return [...points, { position, time, altitude }]
}

/** Pause: mark the last fix so the next one starts a new segment. */
export function markPause(points: TrackPoint[]): TrackPoint[] {
  const last = points[points.length - 1]
  if (!last || last.pausedAfter) return points
  return [...points.slice(0, -1), { ...last, pausedAfter: true }]
}

/** Index of the first point of each later segment. A pause right at the end
 * (nothing recorded after it) is not a gap. */
export function trackSegmentStarts(points: TrackPoint[]): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) if (points[i - 1].pausedAfter) out.push(i)
  return out
}

/** On stop: drop segments with a single fix (nothing to draw), so a saved
 * track is always valid lines. Pause marks are rebuilt to match. */
export function finishTrack(points: TrackPoint[]): TrackPoint[] {
  const segs = splitSegments(points, trackSegmentStarts(points)).filter((s) => s.length >= 2)
  return segs.flatMap((seg, i) =>
    seg.map((p, j) => {
      const { pausedAfter: _paused, ...rest } = p
      void _paused
      return j === seg.length - 1 && i < segs.length - 1 ? { ...rest, pausedAfter: true } : rest
    }),
  )
}

export interface TrackStats {
  /** Distance travelled, gaps left out. */
  distanceM: number
  /** Time recording (first to last fix of each segment), pauses left out. */
  durationMs: number
  avgSpeedKmh: number
  /** Sum of climbs between fixes (gaps left out); null without altitudes. */
  elevGainM: number | null
}

export function trackStats(points: TrackPoint[]): TrackStats {
  let distanceM = 0
  let durationMs = 0
  let elevGainM: number | null = null
  for (const seg of splitSegments(points, trackSegmentStarts(points))) {
    distanceM += pathLengthMeters(seg.map((p) => p.position))
    if (seg.length >= 2) durationMs += seg[seg.length - 1].time - seg[0].time
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1].altitude
      const b = seg[i].altitude
      if (a != null && b != null) elevGainM = (elevGainM ?? 0) + Math.max(0, b - a)
    }
  }
  const hours = durationMs / 3600000
  return {
    distanceM,
    durationMs,
    avgSpeedKmh: hours > 0 ? distanceM / 1000 / hours : 0,
    elevGainM,
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}
