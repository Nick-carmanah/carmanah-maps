import type { Position } from 'geojson'

type Listener = (position: Position) => void

/**
 * Shared GPS watcher: starts watchPosition when the first consumer subscribes,
 * stops when the last unsubscribes. In dev, window.__posFeed(lng, lat) injects
 * synthetic fixes to every subscriber (desktop testing has no GPS).
 */
const listeners = new Set<Listener>()
let watchId: number | null = null
let lastError: string | null = null

function emit(lng: number, lat: number) {
  for (const listener of listeners) listener([lng, lat])
}

function startWatch() {
  if (!navigator.geolocation) {
    lastError = 'GPS not available on this device'
    return
  }
  watchId = navigator.geolocation.watchPosition(
    (pos) => emit(pos.coords.longitude, pos.coords.latitude),
    (err) => {
      lastError = err.message
    },
    { enableHighAccuracy: true, maximumAge: 0 },
  )
}

export function subscribePosition(listener: Listener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) startWatch()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && watchId !== null) {
      navigator.geolocation?.clearWatch(watchId)
      watchId = null
    }
  }
}

export function positionError(): string | null {
  return lastError
}

if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__posFeed = emit
}
