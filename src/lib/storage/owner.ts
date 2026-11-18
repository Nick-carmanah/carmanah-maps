/**
 * Who owns the data on this page, read from the crew app's hand-off.
 *
 * The Carmanah crew app writes `carmanah.mapsContext.v1` to localStorage
 * before it opens the map page (rebuild plan §0). We only ever READ it: it
 * belongs to the crew app, which clears it at sign-out. No hand-off (the
 * website, or a signed-out phone) means the map runs as `guest`.
 *
 * Expected shape (extra fields are ignored):
 *   { "ownerId": "u123", "fireNumber": "K61067", "callSign": "2P14", ... }
 */

export const MAPS_CONTEXT_KEY = 'carmanah.mapsContext.v1'
export const GUEST_OWNER = 'guest'

/**
 * File-name safe, per the contract: letters, digits, `-`, `_` only. Names
 * starting with `_` are ours, for things that belong to nobody (the shared
 * basemap packs live in `maps/_packs/`), so an owner can never be one of them.
 */
const OWNER_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/

export function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_ID_RE.test(value)
}

export interface MapsContext {
  /** Validated owner id; `guest` when there's no usable hand-off. */
  ownerId: string
  /** The fire the person is on, if the hand-off says. */
  fireNumber?: string
  /** The person's call sign (e.g. "2P14"), if the hand-off says. */
  callSign?: string
}

function cleanText(value: unknown, max = 40): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().slice(0, max)
  return text || undefined
}

/** Parse a hand-off value. Anything malformed falls back to `guest`. */
export function parseMapsContext(raw: string | null): MapsContext {
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    }
  } catch {
    // Not JSON: treat as no hand-off.
  }
  const ownerId = isOwnerId(data.ownerId) ? data.ownerId : GUEST_OWNER
  return {
    ownerId,
    fireNumber: cleanText(data.fireNumber ?? data.fire_number ?? data.fire),
    callSign: cleanText(data.callSign ?? data.call_sign ?? data.callsign),
  }
}

export function readMapsContext(): MapsContext {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(MAPS_CONTEXT_KEY)
  } catch {
    // Storage blocked (private mode on some browsers): run as guest.
  }
  return parseMapsContext(raw)
}

let pageOwner: string | undefined

/**
 * The owner for this page load. Read once, on first use, and fixed until the
 * page reloads: every personal store (layers, features, photos, maps,
 * settings) uses this one id, so nothing can mix two people's data. If the
 * hand-off changes while the page is open, the page reloads (below).
 */
export function pageOwnerId(): string {
  if (pageOwner === undefined) {
    pageOwner = readMapsContext().ownerId
    if (typeof window !== 'undefined') reloadOnOwnerChange(pageOwner)
  }
  return pageOwner
}

/**
 * The crew app clears or replaces the hand-off when someone signs out or in.
 * If that happens while this page is open, the page must not keep showing
 * the previous person's data, so reload it under the new owner. Checked when
 * another page changes the hand-off, and whenever this page comes back into
 * view (including from the back/forward cache, where it missed those events).
 */
export function reloadOnOwnerChange(currentOwnerId: string): () => void {
  const check = () => {
    if (readMapsContext().ownerId !== currentOwnerId) location.reload()
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === MAPS_CONTEXT_KEY || e.key === null) check()
  }
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) check()
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') check()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('pageshow', onPageShow)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('pageshow', onPageShow)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
