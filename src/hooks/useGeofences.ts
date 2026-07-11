import { useEffect, useRef } from 'react'
import { insideFence } from '../lib/fences'
import { subscribePosition } from '../lib/position'
import type { UserFeature } from '../lib/features'

/**
 * Watches GPS while any fence is armed and alerts on boundary crossings.
 * Alerts use toast + vibration + system notification (when permitted).
 */
export function useGeofences(
  features: UserFeature[],
  onAlert: (message: string) => void,
) {
  const featuresRef = useRef(features)
  featuresRef.current = features
  const insideRef = useRef<Map<string, boolean>>(new Map())
  const anyArmed = features.some((f) => f.geofence?.enabled)

  // Ask for notification permission once, when the first fence is armed.
  useEffect(() => {
    if (anyArmed && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  }, [anyArmed])

  useEffect(() => {
    if (!anyArmed) {
      insideRef.current.clear()
      return
    }
    return subscribePosition((position) => {
      for (const feature of featuresRef.current) {
        if (!feature.geofence?.enabled) continue
        const inside = insideFence(position, feature)
        const wasInside = insideRef.current.get(feature.id)
        insideRef.current.set(feature.id, inside)
        if (wasInside === undefined || inside === wasInside) continue

        const message = inside
          ? `Entered ${feature.name}`
          : `LEFT ${feature.name}`
        onAlert(message)
        navigator.vibrate?.([200, 100, 200])
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('Carmanah Maps geofence', { body: message })
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyArmed])
}
