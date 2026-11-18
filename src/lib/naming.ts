/**
 * BCWS-style naming convention: What_When_Where_Who
 * e.g. "Edge_JUL11_K61067_2P14". GIS-safe per BCWS GIS guidance:
 * no spaces, no punctuation, underscores between words.
 */
import { adoptLegacyPref, readOwnerPref, readStoredKey, writeOwnerPref } from './storage/prefs'
import { readMapsContext } from './storage/owner'

export interface Profile {
  callsign: string
  fireNumber: string
}

/** Per person (plan §0, shared phones): `carmanah-maps.<ownerId>.profile`. */
const PREF = 'profile'
/** Before owners: one profile for everyone on the website (the guest adopts it). */
const SHARED_KEY = 'carmanah-profile'

function parseProfile(raw: string | null): Profile | null {
  try {
    if (raw) return { callsign: '', fireNumber: '', ...JSON.parse(raw) }
  } catch {
    // fall through
  }
  return null
}

export function getProfile(): Profile {
  const own = parseProfile(readOwnerPref(PREF))
  if (own) return own
  if (adoptLegacyPref(PREF)) {
    const raw = readStoredKey(SHARED_KEY)
    const legacy = parseProfile(raw)
    if (legacy && raw) {
      writeOwnerPref(PREF, raw)
      return legacy
    }
  }
  return { callsign: '', fireNumber: '' }
}

export function saveProfile(profile: Profile): void {
  writeOwnerPref(PREF, JSON.stringify(profile))
}

/**
 * Call sign and fire number to name things with. The crew app's hand-off
 * (carmanah.mapsContext.v1, rebuild plan §0) wins field by field over the
 * profile typed in on this page: it's what the crew app knows about the
 * person signed in right now. The profile fills in what the hand-off lacks.
 */
export function namingProfile(): Profile {
  const p = getProfile()
  const handOff = readMapsContext()
  return {
    callsign: handOff.callSign ?? p.callsign.trim(),
    fireNumber: handOff.fireNumber ?? p.fireNumber.trim(),
  }
}

/** True when there's a call sign or fire number — enables convention naming. */
export function conventionActive(): boolean {
  const p = namingProfile()
  return Boolean(p.callsign || p.fireNumber)
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

export function datePart(d = new Date()): string {
  return `${MONTHS[d.getMonth()]}${String(d.getDate()).padStart(2, '0')}`
}

export function sanitizeGisName(s: string): string {
  return s
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** "Edge" → "Edge_JUL11_K61067_2P14" using the stored profile. */
export function buildConventionName(what: string): string {
  const p = namingProfile()
  return sanitizeGisName([what, datePart(), p.fireNumber, p.callsign].filter(Boolean).join('_'))
}

/** Workshop track types: semantic color + "What" prefix + auto-layer. */
export const TRACK_TYPES = [
  { what: 'Edge', label: 'Fire edge', color: '#e11d1d', layer: 'Fire edge' },
  { what: 'DGd', label: 'Dozer guard', color: '#111111', layer: 'Guards' },
  { what: 'HGd', label: 'Hand guard', color: '#404040', layer: 'Guards' },
  { what: 'Patrol', label: 'Patrol', color: '#3b82f6', layer: 'Patrols' },
  { what: 'DTA', label: 'DT assessment', color: '#a855f7', layer: 'Danger trees' },
  { what: 'Track', label: 'General', color: '#f97316', layer: 'Lines' },
] as const
