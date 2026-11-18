import type { Position } from 'geojson'

/** One GPS fix as the browser (or the crew app's WebView) reports it. */
export interface GpsFix {
  lng: number
  lat: number
  /** Horizontal accuracy, metres (W3C: 95% confidence); null if unknown. */
  accuracy: number | null
  /** Metres, as the device reports it; null if unknown. */
  altitude: number | null
  altitudeAccuracy: number | null
  /** Ground speed, m/s; null if unknown. */
  speed: number | null
  /** Direction of travel, degrees true; null when unknown or standing still. */
  heading: number | null
  /** When the fix was taken, ms since 1970. */
  time: number
}

type FixListener = (fix: GpsFix) => void
type ErrorListener = (message: string) => void

/**
 * Shared GPS watcher: starts watchPosition when the first consumer subscribes,
 * stops when the last unsubscribes, so navigation, geofences, track recording,
 * GPS averaging and the GPS info panel share one watch.
 *
 * In dev, window.__posFeed(lng, lat, extra?) injects a synthetic fix to every
 * subscriber (desktop testing has no GPS); `extra` sets accuracy, altitude,
 * speed, heading or time (accuracy defaults to 5 m).
 */
const subscribers = new Set<{ fix: FixListener; error?: ErrorListener }>()
let watchId: number | null = null
let lastError: string | null = null
let latest: GpsFix | null = null

const finite = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

export function fixFromPosition(pos: GeolocationPosition): GpsFix {
  const c = pos.coords
  return {
    lng: c.longitude,
    lat: c.latitude,
    accuracy: finite(c.accuracy),
    altitude: finite(c.altitude),
    altitudeAccuracy: finite(c.altitudeAccuracy),
    speed: finite(c.speed),
    heading: finite(c.heading),
    time: finite(pos.timestamp) ?? Date.now(),
  }
}

function emitFix(fix: GpsFix) {
  latest = fix
  lastError = null
  for (const s of [...subscribers]) s.fix(fix)
}

function emitError(message: string) {
  lastError = message
  for (const s of [...subscribers]) s.error?.(message)
}

function startWatch() {
  if (!navigator.geolocation) {
    lastError = 'GPS not available on this device'
    return
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => emitFix(fixFromPosition(pos)),
    (err) => emitError(err.message),
    { enableHighAccuracy: true, maximumAge: 0 },
  )
}

/** Every fix while subscribed; `onError` hears GPS errors (permission, no
 * signal). Returns the unsubscribe function. */
export function subscribeFix(onFix: FixListener, onError?: ErrorListener): () => void {
  const sub = { fix: onFix, error: onError }
  subscribers.add(sub)
  if (subscribers.size === 1) startWatch()
  if (!navigator.geolocation) onError?.('GPS not available on this device')
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0 && watchId !== null) {
      navigator.geolocation?.clearWatch(watchId)
      watchId = null
    }
  }
}

/** Positions only ([lng, lat]), for consumers that need nothing else. */
export function subscribePosition(listener: (position: Position) => void): () => void {
  return subscribeFix((f) => listener([f.lng, f.lat]))
}

export function positionError(): string | null {
  return lastError
}

/** The most recent fix this session (may be old: check its time). */
export function lastFix(): GpsFix | null {
  return latest
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__posFeed = (
    lng: number,
    lat: number,
    extra: Partial<GpsFix> = {},
  ) =>
    emitFix({
      lng,
      lat,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      speed: null,
      heading: null,
      time: Date.now(),
      ...extra,
    })
}
