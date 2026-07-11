import { useCallback, useEffect, useRef, useState } from 'react'
import type { Position } from 'geojson'
import { haversineMeters, pathLengthMeters } from '../lib/measure'

export interface TrackPoint {
  position: Position
  time: number
  altitude: number | null
}

export type TrackPhase = 'idle' | 'recording' | 'review'

export interface TrackStats {
  distanceM: number
  durationMs: number
  avgSpeedKmh: number
  elevGainM: number | null
}

/** Ignore GPS jitter below this distance between fixes. */
const MIN_MOVE_M = 3

export function trackStats(points: TrackPoint[]): TrackStats {
  const positions = points.map((p) => p.position)
  const distanceM = pathLengthMeters(positions)
  const durationMs = points.length >= 2 ? points[points.length - 1].time - points[0].time : 0
  const hours = durationMs / 3600000
  let elevGainM: number | null = null
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].altitude
    const b = points[i].altitude
    if (a != null && b != null) {
      elevGainM = (elevGainM ?? 0) + Math.max(0, b - a)
    }
  }
  return {
    distanceM,
    durationMs,
    avgSpeedKmh: hours > 0 ? distanceM / 1000 / hours : 0,
    elevGainM,
  }
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

export function useTrackRecorder(onNotify: (message: string, isError?: boolean) => void) {
  const [phase, setPhase] = useState<TrackPhase>('idle')
  const [points, setPoints] = useState<TrackPoint[]>([])
  const watchIdRef = useRef<number | null>(null)
  const wakeLockRef = useRef<{ release(): Promise<void> } | null>(null)
  // Re-render every second while recording so the duration display ticks.
  const [, setTick] = useState(0)

  const addPoint = useCallback((lng: number, lat: number, altitude: number | null = null) => {
    setPoints((prev) => {
      const position: Position = [lng, lat]
      if (
        prev.length &&
        haversineMeters(prev[prev.length - 1].position, position) < MIN_MOVE_M
      ) {
        return prev
      }
      return [...prev, { position, time: Date.now(), altitude }]
    })
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const interval = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [phase])

  // Dev-only: feed synthetic GPS fixes from the console for desktop testing.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__trackFeed = addPoint
    return () => {
      delete (window as unknown as Record<string, unknown>).__trackFeed
    }
  }, [addPoint])

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation?.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    wakeLockRef.current?.release().catch(() => {})
    wakeLockRef.current = null
  }, [])

  const start = useCallback(() => {
    setPoints([])
    setPhase('recording')
    if (navigator.geolocation) {
      watchIdRef.current = navigator.geolocation.watchPosition(
        (pos) =>
          addPoint(pos.coords.longitude, pos.coords.latitude, pos.coords.altitude),
        (err) => onNotify(`GPS: ${err.message}`, true),
        { enableHighAccuracy: true, maximumAge: 0 },
      )
    } else {
      onNotify('GPS not available on this device', true)
    }
    // Keep the screen awake while recording (best-effort).
    navigator.wakeLock?.request('screen').then(
      (lock) => {
        wakeLockRef.current = lock
      },
      () => {},
    )
  }, [addPoint, onNotify])

  const stop = useCallback(() => {
    stopWatching()
    setPoints((prev) => {
      if (prev.length < 2) {
        onNotify('Track too short to save', true)
        setPhase('idle')
        return []
      }
      setPhase('review')
      return prev
    })
  }, [stopWatching, onNotify])

  const discard = useCallback(() => {
    stopWatching()
    setPhase('idle')
    setPoints([])
  }, [stopWatching])

  useEffect(() => stopWatching, [stopWatching])

  return { phase, points, start, stop, discard }
}
