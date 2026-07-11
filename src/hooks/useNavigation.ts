import { useEffect, useRef, useState } from 'react'
import type { Position } from 'geojson'
import { bearingDeg, centroidOf } from '../lib/geo'
import { haversineMeters } from '../lib/measure'
import type { UserFeature } from '../lib/features'

export interface NavState {
  position: Position | null
  distanceM: number | null
  bearing: number | null
  /** Estimated seconds to target at current smoothed speed, if moving. */
  etaS: number | null
}

export function navTargetPosition(feature: UserFeature): Position {
  return feature.kind === 'pin'
    ? (feature.coordinates as Position)
    : centroidOf(feature.coordinates as Position[])
}

/** Watches GPS while a target is set; returns live distance/bearing/ETA. */
export function useNavigation(
  target: UserFeature | null,
  onNotify: (message: string, isError?: boolean) => void,
): NavState {
  const [position, setPosition] = useState<Position | null>(null)
  const fixesRef = useRef<{ position: Position; time: number }[]>([])

  useEffect(() => {
    if (!target) {
      setPosition(null)
      fixesRef.current = []
      return
    }
    const addFix = (lng: number, lat: number) => {
      const fix = { position: [lng, lat] as Position, time: Date.now() }
      fixesRef.current = [...fixesRef.current.slice(-4), fix]
      setPosition(fix.position)
    }
    let watchId: number | null = null
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => addFix(pos.coords.longitude, pos.coords.latitude),
        (err) => onNotify(`GPS: ${err.message}`, true),
        { enableHighAccuracy: true, maximumAge: 0 },
      )
    } else {
      onNotify('GPS not available on this device', true)
    }
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__posFeed = addFix
    }
    return () => {
      if (watchId !== null) navigator.geolocation?.clearWatch(watchId)
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__posFeed
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id])

  if (!target || !position) {
    return { position: null, distanceM: null, bearing: null, etaS: null }
  }

  const targetPos = navTargetPosition(target)
  const distanceM = haversineMeters(position, targetPos)
  const bearing = bearingDeg(position, targetPos)

  // Smoothed ground speed over the last few fixes → ETA when actually moving.
  let etaS: number | null = null
  const fixes = fixesRef.current
  if (fixes.length >= 2) {
    const first = fixes[0]
    const last = fixes[fixes.length - 1]
    const dt = (last.time - first.time) / 1000
    if (dt > 1) {
      let travelled = 0
      for (let i = 1; i < fixes.length; i++) {
        travelled += haversineMeters(fixes[i - 1].position, fixes[i].position)
      }
      const speed = travelled / dt
      if (speed > 0.4) etaS = distanceM / speed
    }
  }

  return { position, distanceM, bearing, etaS }
}
