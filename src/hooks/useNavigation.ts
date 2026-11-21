import { useEffect, useRef, useState } from 'react'
import type { Position } from 'geojson'
import { positionError, subscribeFix, type GpsFix } from '../lib/position'
import type { UserFeature } from '../lib/features'
import {
  advanceSession,
  etaSeconds,
  groundSpeed,
  legTo,
  remainingM,
  waypointPositions,
  type NavEvent,
  type NavOptions,
  type NavSession,
  type SpeedFix,
} from '../lib/navigation'

// Kept here for the feature sheet's Google Maps link.
export { navTargetPosition } from '../lib/navigation'

export interface NavReadout {
  position: Position | null
  /** GPS accuracy, metres. */
  accuracy: number | null
  /** The waypoint being navigated to. */
  target: Position | null
  distanceM: number | null
  /** Degrees true, from you to the target. */
  bearing: number | null
  /** Smoothed ground speed (m/s) while moving. */
  speedMps: number | null
  /** To the target at the current speed. */
  etaS: number | null
  /** To the end of the route, along it. */
  remainingM: number | null
  etaEndS: number | null
}

/** How many recent fixes the speed is smoothed over. */
const SPEED_WINDOW = 5

/**
 * Follows the shared GPS while a session runs: live distance, bearing and
 * ETA to the current waypoint, and the session moved on by each fix
 * (arrival, approach; navigation.ts advanceSession). `onAdvance` hears
 * every change, with the alerts it raised.
 */
export function useNavigation(
  session: NavSession | null,
  features: UserFeature[],
  options: NavOptions,
  onAdvance: (next: NavSession, events: NavEvent[]) => void,
  onNotify: (message: string, isError?: boolean) => void,
): NavReadout {
  const [fix, setFix] = useState<GpsFix | null>(null)
  const fixesRef = useRef<SpeedFix[]>([])
  const sessionRef = useRef(session)
  sessionRef.current = session
  const featuresRef = useRef(features)
  featuresRef.current = features
  const optionsRef = useRef(options)
  optionsRef.current = options
  const onAdvanceRef = useRef(onAdvance)
  onAdvanceRef.current = onAdvance
  const active = session != null

  useEffect(() => {
    if (!active) {
      setFix(null)
      fixesRef.current = []
      return
    }
    const err = positionError()
    if (err) onNotify(`GPS: ${err}`, true)
    return subscribeFix((f) => {
      const position: Position = [f.lng, f.lat]
      fixesRef.current = [...fixesRef.current.slice(-(SPEED_WINDOW - 1)), { position, time: f.time, speed: f.speed }]
      setFix(f)
      const s = sessionRef.current
      if (!s) return
      const points = waypointPositions(s.waypoints, featuresRef.current)
      const { session: next, events } = advanceSession(s, position, points, optionsRef.current)
      if (next !== s) {
        sessionRef.current = next
        onAdvanceRef.current(next, events)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const empty: NavReadout = {
    position: null,
    accuracy: null,
    target: null,
    distanceM: null,
    bearing: null,
    speedMps: null,
    etaS: null,
    remainingM: null,
    etaEndS: null,
  }
  if (!session) return empty
  const points = waypointPositions(session.waypoints, features)
  const target = points[Math.min(session.index, points.length - 1)] ?? null
  if (!fix || !target) return { ...empty, target }

  const position: Position = [fix.lng, fix.lat]
  const { distanceM, bearing } = legTo(position, target)
  const speedMps = groundSpeed(fixesRef.current)
  const rest = points.length > 1 ? remainingM(position, points, session.index) : null
  return {
    position,
    accuracy: fix.accuracy,
    target,
    distanceM,
    bearing,
    speedMps,
    etaS: etaSeconds(distanceM, speedMps),
    remainingM: rest,
    etaEndS: rest != null ? etaSeconds(rest, speedMps) : null,
  }
}
