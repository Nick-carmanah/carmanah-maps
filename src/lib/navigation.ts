import type { Position } from 'geojson'
import type { UserFeature } from './features'
import { centroidOf } from './geo'
import { azimuthDeg, distanceM } from './geodesic'
import { splitSegments } from './track'

/**
 * Navigation maths: go to a point, follow a route leg by leg, arrival and
 * approach alerts, ground speed and ETA. Pure (no DOM, no GPS), so the
 * tests drive it with synthetic fixes; useNavigation.ts feeds it live.
 *
 * Distances and bearings are WGS84 geodesics (geodesic.ts), like every
 * other number in the app (measure.ts, geo.ts, cogo.ts destination), so a
 * point projected 250 m at 045° reads 250 m at 045° when you navigate to
 * it, and GIS measures the same.
 */

/** Where a feature is navigated to: a pin's spot, else the vertex centroid. */
export function navTargetPosition(feature: UserFeature): Position {
  return feature.kind === 'pin'
    ? (feature.coordinates as Position)
    : centroidOf(feature.coordinates as Position[])
}

export interface Waypoint {
  /** For list keys and reordering. */
  id: string
  name: string
  /** Where it was when added. A placemark's live position wins while it exists. */
  position: Position
  /** The placemark it came from, if any. */
  featureId?: string
}

export interface NavSession {
  /** A single go-to is a route of one. */
  waypoints: Waypoint[]
  /** The waypoint being navigated to. */
  index: number
  /** Reached the last waypoint. */
  finished: boolean
  /** What has been said about waypoint `index` (each alert sounds once). */
  alerted: 'none' | 'approach' | 'arrive'
  /** Route name, when it's a route. */
  name?: string
  startedAt: number
}

export interface NavOptions {
  /** Arrived within this, metres. */
  arrivalRadiusM: number
  /** Early warning within this, metres (0 = off). */
  approachM: number
  /** Go on to the next waypoint on arrival (else wait for Skip). */
  autoAdvance: boolean
}

export type NavEventType = 'approach' | 'arrive' | 'finish'

export interface NavEvent {
  type: NavEventType
  index: number
  name: string
  distanceM: number
  /** For 'arrive': the waypoint now being navigated to, if any. */
  nextName?: string
}

/** Live position of a waypoint: its placemark's, while the placemark exists. */
export function waypointPosition(wp: Waypoint, features: readonly UserFeature[]): Position {
  if (wp.featureId) {
    const f = features.find((x) => x.id === wp.featureId)
    if (f) return navTargetPosition(f)
  }
  return wp.position
}

export function waypointPositions(waypoints: readonly Waypoint[], features: readonly UserFeature[]): Position[] {
  return waypoints.map((wp) => waypointPosition(wp, features))
}

/** Length of each leg: legs[i] runs from point i to point i+1. */
export function legLengths(points: readonly Position[]): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) out.push(distanceM(points[i - 1], points[i]))
  return out
}

export function routeLengthM(points: readonly Position[]): number {
  return legLengths(points).reduce((s, d) => s + d, 0)
}

/** From where you are, to waypoint `index`, then along the rest of the route. */
export function remainingM(position: Position, points: readonly Position[], index: number): number {
  if (index >= points.length) return 0
  let total = distanceM(position, points[index])
  for (let i = index + 1; i < points.length; i++) total += distanceM(points[i - 1], points[i])
  return total
}

export function newSession(waypoints: Waypoint[], name?: string, now = Date.now()): NavSession {
  return { waypoints, index: 0, finished: false, alerted: 'none', name, startedAt: now }
}

/**
 * One GPS fix against the session: approach and arrival alerts for the
 * current waypoint, and on arrival on to the next one (or done at the
 * last). Each alert sounds once per waypoint, so GPS wobble at the edge of
 * the radius doesn't repeat it. Close waypoints are passed in one go when
 * you're within the radius of each in turn.
 */
export function advanceSession(
  session: NavSession,
  position: Position,
  points: readonly Position[],
  opts: NavOptions,
): { session: NavSession; events: NavEvent[] } {
  const events: NavEvent[] = []
  let s = session
  if (s.finished || !points.length) return { session: s, events }
  const radius = Math.max(0, opts.arrivalRadiusM)
  for (let guard = 0; guard <= points.length; guard++) {
    const index = Math.min(s.index, points.length - 1)
    const wp = s.waypoints[index]
    const d = distanceM(position, points[index])
    const last = index >= points.length - 1
    if (d <= radius) {
      if (s.alerted === 'arrive') break // waiting for Skip (auto-advance off)
      if (last) {
        events.push({ type: 'finish', index, name: wp.name, distanceM: d })
        s = { ...s, index, finished: true, alerted: 'arrive' }
        break
      }
      if (!opts.autoAdvance) {
        events.push({ type: 'arrive', index, name: wp.name, distanceM: d })
        s = { ...s, alerted: 'arrive' }
        break
      }
      events.push({ type: 'arrive', index, name: wp.name, distanceM: d, nextName: s.waypoints[index + 1].name })
      s = { ...s, index: index + 1, alerted: 'none' }
      continue
    }
    if (s.alerted === 'none' && opts.approachM > radius && d <= opts.approachM) {
      events.push({ type: 'approach', index, name: wp.name, distanceM: d })
      s = { ...s, alerted: 'approach' }
    }
    break
  }
  return { session: s, events }
}

/** Skip ahead (+1) or back (−1) a leg by hand. */
export function stepSession(session: NavSession, by: 1 | -1): NavSession {
  const last = session.waypoints.length - 1
  if (by > 0 && session.index >= last) return { ...session, index: last, finished: true, alerted: 'arrive' }
  const index = Math.max(0, Math.min(last, session.index + by))
  return { ...session, index, finished: false, alerted: 'none' }
}

// ---- Speed and ETA ----

export interface SpeedFix {
  position: Position
  time: number
  /** As the GPS reports it, m/s (null or negative = unknown). */
  speed: number | null
}

/** Below this (m/s) you're standing still, as far as an ETA goes. */
export const MIN_ETA_SPEED_MPS = 0.3

/**
 * Smoothed ground speed over the last few fixes, m/s, or null when
 * standing still. Uses the GPS's own speed (Doppler, steady even when the
 * position wobbles) when it gives one; otherwise straight-line progress
 * from the first to the last fix, so wobble while standing still doesn't
 * add up to a walking pace.
 */
export function groundSpeed(fixes: readonly SpeedFix[]): number | null {
  if (!fixes.length) return null
  const reported = fixes.map((f) => f.speed).filter((v): v is number => v != null && v >= 0)
  if (reported.length && fixes[fixes.length - 1].speed != null) {
    const avg = reported.reduce((s, v) => s + v, 0) / reported.length
    return avg >= MIN_ETA_SPEED_MPS ? avg : null
  }
  if (fixes.length < 2) return null
  const first = fixes[0]
  const last = fixes[fixes.length - 1]
  const dt = (last.time - first.time) / 1000
  if (dt < 3) return null
  const v = distanceM(first.position, last.position) / dt
  return v >= MIN_ETA_SPEED_MPS ? v : null
}

/** Seconds to cover `distanceM` at `speedMps`, or null when not moving. */
export function etaSeconds(distanceM: number, speedMps: number | null): number | null {
  if (speedMps == null || !(speedMps >= MIN_ETA_SPEED_MPS)) return null
  return distanceM / speedMps
}

/** Distance and bearing (degrees true) from you to a point. */
export function legTo(position: Position, target: Position): { distanceM: number; bearing: number } {
  return { distanceM: distanceM(position, target), bearing: azimuthDeg(position, target) }
}

// ---- Lines as routes ----

/** Most waypoints a followed line becomes (a long GPS track is thinned). */
export const MAX_FOLLOW_POINTS = 200

/**
 * Thin a path for following: keep the first and last points and every
 * point at least `minSpacingM` from the last kept one; the spacing grows
 * until no more than `max` points remain.
 */
export function thinPath(points: readonly Position[], minSpacingM = 10, max = MAX_FOLLOW_POINTS): Position[] {
  if (points.length <= 2) return points.slice()
  let spacing = Math.max(0, minSpacingM)
  for (;;) {
    const kept: Position[] = [points[0]]
    for (let i = 1; i < points.length - 1; i++) {
      if (distanceM(kept[kept.length - 1], points[i]) >= spacing) kept.push(points[i])
    }
    const last = points[points.length - 1]
    if (kept.length > 1 && distanceM(kept[kept.length - 1], last) < spacing / 2) kept.pop()
    kept.push(last)
    if (kept.length <= max || spacing > 1e7) return kept
    spacing = Math.max(1, spacing) * 1.5
  }
}

/** A saved line (a route, an Avenza line, a track) as waypoints to follow. */
export function waypointsFromLine(feature: UserFeature, makeId: () => string): Waypoint[] {
  const coords = feature.coordinates as Position[]
  const path = splitSegments(coords, feature.segmentStarts).flat()
  return thinPath(path).map((p, i) => ({ id: makeId(), name: `${feature.name} ${i + 1}`, position: [p[0], p[1]] }))
}

/** "WP 4": the next free number among waypoints named that way. */
export function nextWaypointName(waypoints: readonly Waypoint[]): string {
  let n = waypoints.length + 1
  const taken = new Set(waypoints.map((w) => w.name))
  while (taken.has(`WP ${n}`)) n++
  return `WP ${n}`
}

// ---- Storage ----

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPosition = (v: unknown): v is Position =>
  Array.isArray(v) && v.length >= 2 && finite(v[0]) && finite(v[1]) && Math.abs(v[1]) <= 90 && Math.abs(v[0]) <= 360

/** Waypoints read back from storage; anything malformed is dropped. */
export function sanitizeWaypoints(raw: unknown): Waypoint[] {
  if (!Array.isArray(raw)) return []
  const out: Waypoint[] = []
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue
    const r = w as Record<string, unknown>
    if (!isPosition(r.position) || typeof r.id !== 'string') continue
    out.push({
      id: r.id,
      name: typeof r.name === 'string' ? r.name : '',
      position: [r.position[0], r.position[1]],
      ...(typeof r.featureId === 'string' ? { featureId: r.featureId } : {}),
    })
  }
  return out
}

/** A session read back from storage (the app was closed mid-route), or null. */
export function sanitizeSession(raw: unknown): NavSession | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const waypoints = sanitizeWaypoints(r.waypoints)
  if (!waypoints.length) return null
  const index = finite(r.index) ? Math.max(0, Math.min(waypoints.length - 1, Math.floor(r.index))) : 0
  const alerted = r.alerted === 'approach' || r.alerted === 'arrive' ? r.alerted : 'none'
  return {
    waypoints,
    index,
    finished: r.finished === true,
    alerted,
    ...(typeof r.name === 'string' && r.name ? { name: r.name } : {}),
    startedAt: finite(r.startedAt) ? r.startedAt : Date.now(),
  }
}
