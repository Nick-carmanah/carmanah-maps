import { useEffect, useState } from 'react'
import { lastFix, subscribeFix, type GpsFix } from '../lib/position'

/** The latest GPS fix while mounted (shared watch, lib/position.ts), and the
 * last GPS error. Starts from this session's last fix, which may be old. */
export function useGpsFix(): { fix: GpsFix | null; error: string | null } {
  const [fix, setFix] = useState<GpsFix | null>(lastFix)
  const [error, setError] = useState<string | null>(null)
  useEffect(
    () =>
      subscribeFix(
        (f) => {
          setFix(f)
          setError(null)
        },
        setError,
      ),
    [],
  )
  return { fix, error }
}

/** Re-render every `ms` while `on` (for "x s ago" and timers). */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return now
}
