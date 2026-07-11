/**
 * BCWS-style naming convention: What_When_Where_Who
 * e.g. "Edge_JUL11_K61067_2P14". GIS-safe per BCWS GIS guidance:
 * no spaces, no punctuation, underscores between words.
 */

export interface Profile {
  callsign: string
  fireNumber: string
}

const KEY = 'carmanah-profile'

export function getProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { callsign: '', fireNumber: '', ...JSON.parse(raw) }
  } catch {
    // fall through to empty profile
  }
  return { callsign: '', fireNumber: '' }
}

export function saveProfile(profile: Profile): void {
  localStorage.setItem(KEY, JSON.stringify(profile))
}

/** True when the user has set up a profile — enables convention naming. */
export function conventionActive(): boolean {
  const p = getProfile()
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
  const p = getProfile()
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
