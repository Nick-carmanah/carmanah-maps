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

/** File-name safe, per the contract: letters, digits, `-`, `_` only. */
const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

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
  const ownerId =
    typeof data.ownerId === 'string' && OWNER_ID_RE.test(data.ownerId) ? data.ownerId : GUEST_OWNER
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

/**
 * The crew app clears or replaces the hand-off when someone signs out or in.
 * If that happens in another tab while this page is open, the page must not
 * keep showing the previous person's maps, so reload it under the new owner.
 */
export function reloadOnOwnerChange(currentOwnerId: string): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== MAPS_CONTEXT_KEY && e.key !== null) return
    if (readMapsContext().ownerId !== currentOwnerId) location.reload()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
