import { ownerPrefKey, readOwnerPref, writeOwnerPref } from './storage/prefs'
import { M_PER_CHAIN, M_PER_FT } from './units'

/**
 * Navigation settings (Avenza's "Navigation settings"): the arrival radius,
 * an early approach alert, whether routes go on to the next point by
 * themselves, and how alerts get your attention. One storage key per
 * person, `carmanah-maps.<ownerId>.navigation`, like the units.
 */
export interface NavSettings {
  /** Arrived within this many metres: alert, and go on to the next point. */
  arrivalRadiusM: number
  /** Heads-up within this many metres (0 = off). */
  approachM: number
  /** Routes: go on to the next point on arrival (off: wait for Skip). */
  autoAdvance: boolean
  sound: boolean
  vibrate: boolean
  /** Hold the screen on while navigating (uses more battery). */
  keepScreenOn: boolean
}

export const DEFAULT_NAV_SETTINGS: NavSettings = {
  arrivalRadiusM: 20,
  approachM: 100,
  autoAdvance: true,
  sound: true,
  vibrate: true,
  keepScreenOn: false,
}

/** Limits on what a stored value may be, metres. */
const RADIUS_RANGE: [number, number] = [1, 5000]
const APPROACH_RANGE: [number, number] = [0, 20_000]

const PREF = 'navigation'

function inRange(v: unknown, [lo, hi]: [number, number]): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
}

/** Keep only sensible values, so a stale or hand-edited entry can't break alerts. */
export function sanitizeNavSettings(raw: unknown): NavSettings {
  const out = { ...DEFAULT_NAV_SETTINGS }
  if (!raw || typeof raw !== 'object') return out
  const r = raw as Record<string, unknown>
  if (inRange(r.arrivalRadiusM, RADIUS_RANGE)) out.arrivalRadiusM = r.arrivalRadiusM
  if (inRange(r.approachM, APPROACH_RANGE)) out.approachM = r.approachM
  for (const k of ['autoAdvance', 'sound', 'vibrate', 'keepScreenOn'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k]
  }
  return out
}

export function loadNavSettings(): NavSettings {
  const stored = readOwnerPref(PREF)
  if (!stored) return { ...DEFAULT_NAV_SETTINGS }
  try {
    return sanitizeNavSettings(JSON.parse(stored))
  } catch {
    return { ...DEFAULT_NAV_SETTINGS }
  }
}

let current: NavSettings = loadNavSettings()
const listeners = new Set<() => void>()

export function getNavSettings(): NavSettings {
  return current
}

export function setNavSettings(patch: Partial<NavSettings>): void {
  current = sanitizeNavSettings({ ...current, ...patch })
  writeOwnerPref(PREF, JSON.stringify(current))
  for (const listener of listeners) listener()
}

export function subscribeNavSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== ownerPrefKey(PREF)) return
    current = loadNavSettings()
    for (const listener of listeners) listener()
  })
}

/**
 * Choices for the radius settings, in the unit crews type distances in
 * (metres, feet or chains), stored as metres.
 */
export function radiusChoices(unit: 'm' | 'ft' | 'ch'): number[] {
  switch (unit) {
    case 'ft':
      return [15, 30, 50, 75, 100, 150, 300].map((ft) => ft * M_PER_FT)
    case 'ch':
      return [0.25, 0.5, 1, 1.5, 2.5, 5].map((ch) => ch * M_PER_CHAIN)
    default:
      return [5, 10, 15, 20, 30, 50, 100]
  }
}

export function approachChoices(unit: 'm' | 'ft' | 'ch'): number[] {
  switch (unit) {
    case 'ft':
      return [0, 150, 300, 500, 1000, 2000, 5280].map((ft) => ft * M_PER_FT)
    case 'ch':
      return [0, 2.5, 5, 10, 25, 50].map((ch) => ch * M_PER_CHAIN)
    default:
      return [0, 50, 100, 200, 500, 1000]
  }
}
