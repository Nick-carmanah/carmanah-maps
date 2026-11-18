import { useEffect, useState } from 'react'
import type { Position } from 'geojson'
import { openInGoogleMaps } from '../lib/google-maps'

/** "View in Google Maps" for one point. Offline it says it needs signal
 * (for a few seconds) instead of opening a page that can't load. */
export default function GoogleMapsButton({ position }: { position: Position }) {
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    if (!offline) return
    const t = setTimeout(() => setOffline(false), 3500)
    return () => clearTimeout(t)
  }, [offline])
  return (
    <button
      className={`btn small${offline ? ' gps-needs-signal' : ''}`}
      onClick={() => setOffline(openInGoogleMaps(position) === 'offline')}
      title="Open this location in Google Maps (needs signal)"
    >
      {offline ? '📶 Google Maps needs signal' : '🌐 View in Google Maps'}
    </button>
  )
}
