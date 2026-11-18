import { useEffect, useSyncExternalStore } from 'react'
import { RECHECK_MS, satelliteSignal } from '../lib/satellite-signal'

const subscribe = (listener: () => void) => satelliteSignal.subscribe(listener)
const getSnapshot = () => satelliteSignal.ok()

/**
 * Can satellite tiles load right now? While satellite is wanted but its tiles
 * failed with the phone still saying it's online, one tile is tried every
 * RECHECK_MS so satellite comes back on its own when signal does.
 */
export function useSatelliteSignal(wanted: boolean): boolean {
  const ok = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (!wanted || ok) return
    const timer = setInterval(() => void satelliteSignal.recheck(), RECHECK_MS)
    return () => clearInterval(timer)
  }, [wanted, ok])
  return ok
}
