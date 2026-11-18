import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeFix } from '../lib/position'
import {
  appendFix,
  finishTrack,
  markPause,
  type TrackPoint,
} from '../lib/track'

// The maths lives in lib/track.ts; re-exported for existing imports.
export { formatDuration, trackSegmentStarts, trackStats } from '../lib/track'
export type { TrackPoint, TrackStats } from '../lib/track'

export type TrackPhase = 'idle' | 'recording' | 'paused' | 'review'

/**
 * GPS track recording with pause/resume. A pause stops listening to GPS and
 * leaves a gap: the fix after resuming starts a new segment instead of
 * joining the last one with a straight line (see lib/track.ts).
 */
export function useTrackRecorder(onNotify: (message: string, isError?: boolean) => void) {
  const [phase, setPhase] = useState<TrackPhase>('idle')
  const [points, setPoints] = useState<TrackPoint[]>([])
  const pointsRef = useRef(points)
  pointsRef.current = points
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const onNotifyRef = useRef(onNotify)
  onNotifyRef.current = onNotify
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null)
  // Re-render every second while recording so the duration display ticks.
  const [, setTick] = useState(0)

  const addPoint = useCallback((lng: number, lat: number, altitude: number | null = null) => {
    setPoints((prev) => appendFix(prev, [lng, lat], Date.now(), altitude))
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const interval = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [phase])

  // Dev-only: feed synthetic GPS fixes from the console for desktop testing.
  // (window.__posFeed in lib/position.ts drives this and every other GPS tool.)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__trackFeed = (
      lng: number,
      lat: number,
      altitude: number | null = null,
    ) => {
      if (phaseRef.current === 'recording') addPoint(lng, lat, altitude)
    }
    return () => {
      delete (window as unknown as Record<string, unknown>).__trackFeed
    }
  }, [addPoint])

  const listen = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = subscribeFix(
      (fix) => addPoint(fix.lng, fix.lat, fix.altitude),
      (message) => onNotifyRef.current(`GPS: ${message}`, true),
    )
    // Keep the screen awake while recording (best-effort).
    navigator.wakeLock?.request('screen').then(
      (lock) => {
        wakeLockRef.current = lock
      },
      () => {},
    )
  }, [addPoint])

  const stopListening = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
  }, [])

  const start = useCallback(() => {
    setPoints([])
    setPhase('recording')
    listen()
  }, [listen])

  const pause = useCallback(() => {
    if (phaseRef.current !== 'recording') return
    stopListening()
    setPoints(markPause)
    setPhase('paused')
  }, [stopListening])

  const resume = useCallback(() => {
    if (phaseRef.current !== 'paused') return
    setPhase('recording')
    listen()
  }, [listen])

  const stop = useCallback(() => {
    stopListening()
    const kept = finishTrack(pointsRef.current)
    if (kept.length < 2) {
      onNotifyRef.current('Track too short to save', true)
      setPhase('idle')
      setPoints([])
      return
    }
    setPoints(kept)
    setPhase('review')
  }, [stopListening])

  const discard = useCallback(() => {
    stopListening()
    setPhase('idle')
    setPoints([])
  }, [stopListening])

  useEffect(() => stopListening, [stopListening])

  return { phase, points, start, pause, resume, stop, discard }
}
