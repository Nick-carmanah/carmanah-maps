import type { Position } from 'geojson'
import { bearingDeg } from './geo'
import { destination as geodesicDestination, distanceM } from './geodesic'
import { declinationDeg } from './magnetic'
import {
  M_PER_CHAIN,
  M_PER_FT,
  M_PER_MI,
  M_PER_NM,
  MILS_PER_CIRCLE,
  getUnitSettings,
  type UnitSettings,
} from './units'

/**
 * Coordinate geometry for drawing: "shoot a bearing, draw the line"
 * (course and distance), and circles.
 *
 * Positions are computed on the WGS84 ellipsoid, like every other number
 * in the app (geodesic.ts via measure.ts and geo.ts, navigation), so a
 * 250 m leg measures 250 m, navigating back to its start reads the typed
 * bearing reversed, and a 100 m circle is 100 m from its centre by the
 * app's own ruler and by GIS.
 *
 * Bearings are typed in the angle unit and north reference from the units
 * settings (degrees or mils; true, or magnetic via the offline WMM2025);
 * distances in the distance unit (metres, feet, nautical miles, chains).
 * Everything here is pure, so tests run it anywhere.
 */

/** 0 ≤ deg < 360 */
export function norm360(d: number): number {
  const n = ((d % 360) + 360) % 360
  return n === 360 ? 0 : n
}

/**
 * The point `meters` along the geodesic (WGS84) from `start` at initial
 * bearing `trueDeg` (degrees from true north). Altitude is not carried
 * over; zero or less stays put.
 */
export function destination(start: Position, trueDeg: number, meters: number): Position {
  if (!(meters > 0)) return [start[0], start[1]]
  return geodesicDestination(start, trueDeg, meters)
}

export interface Inverse {
  /** Distance in metres. */
  meters: number
  /** Initial bearing at `a`, degrees true (0–360). */
  bearing: number
}

/** Distance and initial bearing from a to b: the app's own ruler and compass. */
export function inverse(a: Position, b: Position): Inverse {
  return { meters: distanceM(a, b), bearing: bearingDeg(a, b) }
}

// ---- Bearings as typed ----

type AngleSettings = Pick<UnitSettings, 'angle' | 'north'>

/**
 * Read a bearing the way a crew writes it, in the chosen angle unit:
 *  - degrees: "306.5", "306°", "306 52 05" / 306°52'05" (DMS), or a
 *    quadrant bearing "N54W" / "S 30.5 E";
 *  - mils: "5440" (6400 to the circle).
 * Returns the value in that unit (not yet converted to true), or null.
 */
export function parseBearing(text: string, angle: UnitSettings['angle']): number | null {
  const s = text
    .trim()
    .toUpperCase()
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/[º˚]/g, '°')
    .replace(/,/g, '.')
  if (!s) return null
  if (angle === 'mil') {
    const num = s.replace(/\s*MILS?$/, '')
    if (!/^\d+(\.\d+)?$/.test(num)) return null
    const v = Number(num)
    return v >= 0 && v <= MILS_PER_CIRCLE ? v % MILS_PER_CIRCLE : null
  }
  const quadrant = /^([NS])\s*(.+?)\s*([EW])$/.exec(s)
  const body = quadrant ? quadrant[2] : s
  const m = /^(\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*'?\s*)?(?:(\d+(?:\.\d+)?)\s*"?\s*)?$/.exec(body)
  if (!m) return null
  const [, d, min, sec] = m
  // Only the last part may have decimals; minutes and seconds under 60.
  if ((min && d.includes('.')) || (sec && min?.includes('.'))) return null
  if (Number(min ?? 0) >= 60 || Number(sec ?? 0) >= 60) return null
  const v = Number(d) + Number(min ?? 0) / 60 + Number(sec ?? 0) / 3600
  if (quadrant) {
    if (v > 90) return null
    const [, ns, , ew] = quadrant
    if (ns === 'N') return norm360(ew === 'E' ? v : 360 - v)
    return ew === 'E' ? 180 - v : 180 + v
  }
  return v <= 360 ? norm360(v) : null
}

/** A typed bearing (degrees or mils; true or magnetic) → degrees true. `at`
 * is where the bearing is taken from: magnetic north needs its declination. */
export function bearingToTrue(
  value: number,
  at: Position,
  s: AngleSettings = getUnitSettings(),
  date: Date = new Date(),
): number {
  let d = s.angle === 'mil' ? (value * 360) / MILS_PER_CIRCLE : value
  if (s.north === 'magnetic') d += declinationDeg(at[1], at[0], date)
  return norm360(d)
}

/** Label after a bearing input: °T, °M, mil T, mil M. */
export function bearingUnitLabel(s: AngleSettings = getUnitSettings()): string {
  const ref = s.north === 'magnetic' ? 'M' : 'T'
  return s.angle === 'mil' ? `mil ${ref}` : `°${ref}`
}

// ---- Distances as typed ----

export interface InputUnit {
  label: string
  meters: number
}

/** Units offered for typed lengths (traverse legs, circle radius), the
 * user's distance unit first. */
export function distanceInputUnits(s: Pick<UnitSettings, 'distance'> = getUnitSettings()): InputUnit[] {
  const m = { label: 'm', meters: 1 }
  const km = { label: 'km', meters: 1000 }
  const ft = { label: 'ft', meters: M_PER_FT }
  const mi = { label: 'mi', meters: M_PER_MI }
  const nm = { label: 'NM', meters: M_PER_NM }
  const ch = { label: 'ch', meters: M_PER_CHAIN }
  switch (s.distance) {
    case 'imperial':
      return [ft, mi]
    case 'nautical':
      return [nm, ft]
    case 'chains':
      return [ch, m]
    default:
      return [m, km]
  }
}

/** "250", "12.5", "12,5" (comma decimal) → number > 0, or null. */
export function parseLength(text: string): number | null {
  const s = text.trim().replace(/\s+/g, '')
  if (!s) return null
  const normal = s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.')
  if (!/^\d*\.?\d+$/.test(normal) && !/^\d+\.$/.test(normal)) return null
  const v = Number(normal)
  return Number.isFinite(v) && v > 0 ? v : null
}

// ---- Traverses ----

export interface Leg {
  /** Bearing, degrees true. */
  trueDeg: number
  meters: number
}

/** Follow legs from a start point: the start, then each leg's end. */
export function traverse(start: Position, legs: Leg[]): Position[] {
  const out: Position[] = [[start[0], start[1]]]
  for (const leg of legs) out.push(destination(out[out.length - 1], leg.trueDeg, leg.meters))
  return out
}

// ---- Circles ----

/** Vertices for a circle: within half a metre of the true curve, never
 * fewer than 72 (so its area is within 0.13% of πr²), at most 360, and a
 * multiple of 4 so the N/E/S/W points are vertices. */
export function circleVertexCount(radiusM: number): number {
  const raw = radiusM > 0.5 ? Math.PI / Math.acos(1 - 0.5 / radiusM) : 0
  return Math.max(72, Math.min(360, Math.ceil(raw / 4) * 4))
}

/**
 * A circle as an area ring (unclosed, like every area in the app): every
 * vertex exactly `radiusM` from the centre along the ground, first one due
 * north, then anticlockwise (the GeoJSON winding for an outer ring).
 */
export function circleRing(center: Position, radiusM: number, count = circleVertexCount(radiusM)): Position[] {
  const ring: Position[] = []
  for (let i = 0; i < count; i++) ring.push(destination(center, norm360(-(360 * i) / count), radiusM))
  return ring
}
