import type { Position } from 'geojson'
import { COORD_FORMATS, type CoordFormat } from './coords'
import { declinationDeg } from './magnetic'

/**
 * Units of measurement: one choice per metric, like Avenza's settings screen.
 * Every number the app shows goes through the formatters below, so changing a
 * setting changes it everywhere.
 *
 * All of it lives under ONE storage key, read and written only by
 * loadUnitSettings / saveUnitSettings. When settings become per-owner (plan
 * §0: crews share phones), only those two functions change.
 */

export type DistanceUnit = 'metric' | 'imperial' | 'nautical' | 'chains'
export type AreaUnit = 'ha' | 'm2' | 'km2' | 'ac' | 'mi2'
export type SpeedUnit = 'kmh' | 'mph' | 'kn' | 'ms'
export type AngleUnit = 'deg' | 'mil'
export type NorthRef = 'true' | 'magnetic'
export type AltitudeUnit = 'm' | 'ft'
export type PaceUnit = 'min/km' | 'min/mi'

export interface UnitSettings {
  distance: DistanceUnit
  area: AreaUnit
  coords: CoordFormat
  speed: SpeedUnit
  angle: AngleUnit
  north: NorthRef
  altitude: AltitudeUnit
  pace: PaceUnit
}

/** Today's behaviour: metric, hectares, DDM (the BCWS field standard), °T. */
export const DEFAULT_UNIT_SETTINGS: UnitSettings = {
  distance: 'metric',
  area: 'ha',
  coords: 'ddm',
  speed: 'kmh',
  angle: 'deg',
  north: 'true',
  altitude: 'm',
  pace: 'min/km',
}

export const UNIT_CHOICES: { [K in keyof UnitSettings]: readonly UnitSettings[K][] } = {
  distance: ['metric', 'imperial', 'nautical', 'chains'],
  area: ['ha', 'm2', 'km2', 'ac', 'mi2'],
  coords: COORD_FORMATS,
  speed: ['kmh', 'mph', 'kn', 'ms'],
  angle: ['deg', 'mil'],
  north: ['true', 'magnetic'],
  altitude: ['m', 'ft'],
  pace: ['min/km', 'min/mi'],
}

// ---- Exact conversion factors (international definitions) ----

/** Metres per unit. */
export const M_PER_FT = 0.3048
export const M_PER_MI = 1609.344
export const M_PER_NM = 1852
/** Gunter's chain: 66 ft = 22 yd = 1/80 mile. */
export const M_PER_CHAIN = 20.1168
/** Square metres per unit. */
export const SQM_PER_HA = 10_000
export const SQM_PER_KM2 = 1_000_000
export const SQM_PER_ACRE = 4046.8564224
export const SQM_PER_MI2 = M_PER_MI * M_PER_MI
/** Metres per second per unit. */
export const MPS_PER_KMH = 1 / 3.6
export const MPS_PER_MPH = M_PER_MI / 3600
export const MPS_PER_KN = M_PER_NM / 3600
/** NATO mils: 6400 to the circle. */
export const MILS_PER_CIRCLE = 6400

// ---- Storage ----

const KEY = 'carmanah-unit-settings'
/** Before this PR: 'metric' | 'imperial', and the readout's own format. */
const LEGACY_UNITS_KEY = 'carmanah-units'
const LEGACY_COORD_KEY = 'carmanah-coord-fmt'

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null // no storage (private mode, tests)
  }
}

/** Keep only known values, so a stale or hand-edited entry can't break formatting. */
export function sanitizeUnitSettings(raw: unknown): UnitSettings {
  const out = { ...DEFAULT_UNIT_SETTINGS }
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(UNIT_CHOICES) as (keyof UnitSettings)[]) {
      const v = (raw as Record<string, unknown>)[k]
      if ((UNIT_CHOICES[k] as readonly unknown[]).includes(v)) {
        ;(out as Record<string, unknown>)[k] = v
      }
    }
  }
  return out
}

export function loadUnitSettings(): UnitSettings {
  const stored = readKey(KEY)
  if (stored) {
    try {
      return sanitizeUnitSettings(JSON.parse(stored))
    } catch {
      // fall through to the legacy keys
    }
  }
  // First run after the upgrade: carry the old choices over unchanged.
  // Altitude stays metres for imperial users because that's what they saw
  // before (elevation gain was always shown in metres).
  const legacy: Partial<UnitSettings> = {}
  if (readKey(LEGACY_UNITS_KEY) === 'imperial') {
    Object.assign(legacy, { distance: 'imperial', area: 'ac', speed: 'mph', pace: 'min/mi' })
  }
  const fmt = readKey(LEGACY_COORD_KEY)
  if (fmt) legacy.coords = fmt as CoordFormat
  return sanitizeUnitSettings({ ...DEFAULT_UNIT_SETTINGS, ...legacy })
}

function saveUnitSettings(settings: UnitSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Storage full or unavailable: the choice still holds for this session.
  }
}

let current: UnitSettings = loadUnitSettings()
const listeners = new Set<() => void>()

export function getUnitSettings(): UnitSettings {
  return current
}

export function setUnitSettings(patch: Partial<UnitSettings>): void {
  current = sanitizeUnitSettings({ ...current, ...patch })
  saveUnitSettings(current)
  for (const listener of listeners) listener()
}

export function subscribeUnitSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Another tab changed them (website only; the app has one page).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    current = loadUnitSettings()
    for (const listener of listeners) listener()
  })
}

// ---- Formatting ----

/** 2 significant figures below 1, 2 decimals below 100, whole numbers above. */
function smart(v: number): string {
  if (v >= 100) return String(Math.round(v))
  if (v >= 1) return v.toFixed(2)
  if (v <= 0) return '0'
  return v.toFixed(Math.min(6, 1 - Math.floor(Math.log10(v))))
}

function grouped(v: number): string {
  return Math.round(v).toLocaleString('en-CA')
}

/** Lengths: lines, tracks, measure, navigation. */
export function formatDistance(meters: number, s: UnitSettings = current): string {
  switch (s.distance) {
    case 'imperial': {
      const miles = meters / M_PER_MI
      return miles >= 0.2 ? `${miles.toFixed(2)} mi` : `${Math.round(meters / M_PER_FT)} ft`
    }
    case 'nautical': {
      // Aviation pairing: nautical miles, feet up close.
      const nm = meters / M_PER_NM
      return nm >= 0.1 ? `${nm.toFixed(2)} NM` : `${Math.round(meters / M_PER_FT)} ft`
    }
    case 'chains': {
      const ch = meters / M_PER_CHAIN
      return ch < 10 ? `${ch.toFixed(2)} ch` : ch < 100 ? `${ch.toFixed(1)} ch` : `${Math.round(ch)} ch`
    }
    default:
      return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`
  }
}

/** Short distances you type in (geofence radius): the unit and its size. */
export function inputDistanceUnit(s: UnitSettings = current): { label: string; meters: number } {
  switch (s.distance) {
    case 'imperial':
    case 'nautical':
      return { label: 'ft', meters: M_PER_FT }
    case 'chains':
      return { label: 'ch', meters: M_PER_CHAIN }
    default:
      return { label: 'm', meters: 1 }
  }
}

/** Areas. Hectares (or acres) are the working units for fire sizes. */
export function formatArea(sqMeters: number, s: UnitSettings = current): string {
  switch (s.area) {
    case 'm2':
      return `${grouped(sqMeters)} m²`
    case 'km2':
      return `${smart(sqMeters / SQM_PER_KM2)} km²`
    case 'mi2':
      return `${smart(sqMeters / SQM_PER_MI2)} mi²`
    case 'ac': {
      const acres = sqMeters / SQM_PER_ACRE
      if (acres >= 100) return `${Math.round(acres)} ac`
      if (acres >= 0.1) return `${acres.toFixed(1)} ac`
      return `${Math.round(sqMeters / (M_PER_FT * M_PER_FT))} ft²`
    }
    default: {
      const ha = sqMeters / SQM_PER_HA
      if (ha >= 100) return `${Math.round(ha)} ha`
      if (ha >= 1) return `${ha.toFixed(1)} ha`
      return `${Math.round(sqMeters)} m²`
    }
  }
}

export function formatSpeed(metersPerSecond: number, s: UnitSettings = current): string {
  switch (s.speed) {
    case 'mph':
      return `${(metersPerSecond / MPS_PER_MPH).toFixed(1)} mph`
    case 'kn':
      return `${(metersPerSecond / MPS_PER_KN).toFixed(1)} kn`
    case 'ms':
      return `${metersPerSecond.toFixed(1)} m/s`
    default:
      return `${(metersPerSecond / MPS_PER_KMH).toFixed(1)} km/h`
  }
}

/** Altitudes and elevation differences. */
export function formatAltitude(meters: number, s: UnitSettings = current): string {
  return s.altitude === 'ft'
    ? `${grouped(meters / M_PER_FT)} ft`
    : `${grouped(meters)} m`
}

/** Average pace, e.g. "12:30 /km". Null when there's too little to go on. */
export function formatPace(
  durationMs: number,
  meters: number,
  s: UnitSettings = current,
): string | null {
  const perMile = s.pace === 'min/mi'
  const units = meters / (perMile ? M_PER_MI : 1000)
  if (meters < 10 || durationMs <= 0) return null
  const secPerUnit = Math.round(durationMs / 1000 / units)
  if (secPerUnit >= 100 * 3600) return null
  const h = Math.floor(secPerUnit / 3600)
  const m = Math.floor((secPerUnit % 3600) / 60)
  const sec = String(secPerUnit % 60).padStart(2, '0')
  const time = h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
  return `${time} /${perMile ? 'mi' : 'km'}`
}

/**
 * A bearing given in degrees true, shown in the chosen angle unit and north
 * reference. `at` is where the bearing is taken from; magnetic north needs it
 * for the declination (World Magnetic Model, computed offline).
 */
export function formatBearing(
  trueDeg: number,
  at: Position | null,
  s: UnitSettings = current,
  date: Date = new Date(),
): string {
  let deg = trueDeg
  let ref = 'T'
  if (s.north === 'magnetic' && at) {
    deg -= declinationDeg(at[1], at[0], date)
    ref = 'M'
  }
  deg = ((deg % 360) + 360) % 360
  if (s.angle === 'mil') {
    const mils = Math.round((deg * MILS_PER_CIRCLE) / 360) % MILS_PER_CIRCLE
    return `${String(mils).padStart(4, '0')} mil ${ref}`
  }
  return `${Math.round(deg)}°${ref}`
}

/** "16.2° E" — magnetic declination at a place, for display. */
export function formatDeclination(deg: number): string {
  return `${Math.abs(deg).toFixed(1)}° ${deg >= 0 ? 'E' : 'W'}`
}
