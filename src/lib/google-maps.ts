import type { Position } from 'geojson'

/** Google Maps "search" link for a point (Maps URLs API: opens the Google
 * Maps app on phones that have it, the website otherwise). */
export function googleMapsUrl([lng, lat]: Position): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`
}

/**
 * Open a point in Google Maps. Google Maps is online only, so with no signal
 * this says so ('offline') instead of opening a page that can't load.
 *
 * window.open is what the crew app's Capacitor WebView hands to the system
 * (the Google Maps app or the browser), so no plugin is needed.
 */
export function openInGoogleMaps(position: Position): 'opened' | 'offline' {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
  window.open(googleMapsUrl(position), '_blank', 'noopener')
  return 'opened'
}
