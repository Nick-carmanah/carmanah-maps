import { useEffect, useRef, useState } from 'react'
import type { NavReadout } from '../hooks/useNavigation'
import type { NavSession } from '../lib/navigation'
import { getHeading, subscribeHeading } from '../lib/compass'
import { formatDuration } from '../lib/track'
import { formatBearing, formatDistance, formatSpeed } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'

/**
 * The navigation readout: stays at the top of the map while navigating,
 * whatever else is open below. Big numbers first (distance, bearing in
 * the chosen angle unit and north, ETA at the current speed), then the
 * target and route progress, then big buttons.
 *
 * The arrow points to the target from the way you face (the compass, else
 * your GPS course); with neither, from the top of the map.
 */
export default function NavPanel({
  session,
  readout,
  mapBearing,
  arrivalRadiusM,
  onBack,
  onSkip,
  onEditRoute,
  onEnd,
}: {
  session: NavSession
  readout: NavReadout
  mapBearing: number
  arrivalRadiusM: number
  onBack: () => void
  onSkip: () => void
  onEditRoute: () => void
  onEnd: () => void
}) {
  useUnitSettings()
  const [heading, setHeading] = useState(() => getHeading().heading)
  useEffect(() => subscribeHeading((h) => setHeading(h.heading)), [])
  const ref = useRef<HTMLDivElement>(null)

  // The track chip (top of the screen) moves down below the panel.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement
    const set = () => root.style.setProperty('--nav-panel-bottom', `${Math.round(el.getBoundingClientRect().bottom + 6)}px`)
    set()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null
    ro?.observe(el)
    window.addEventListener('resize', set)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', set)
      root.style.removeProperty('--nav-panel-bottom')
    }
  }, [])

  const count = session.waypoints.length
  const isRoute = count > 1
  const index = Math.min(session.index, count - 1)
  const wp = session.waypoints[index]
  const { distanceM, bearing, position } = readout
  const pointer = bearing != null ? bearing - (heading ?? mapBearing) : null
  const weakGps = readout.accuracy != null && readout.accuracy > arrivalRadiusM

  return (
    <div ref={ref} className={`nav-panel${session.finished ? ' finished' : ''}`} role="region" aria-label="Navigation">
      <div className="nav-main">
        <span
          className="nav-pointer"
          style={pointer != null ? { transform: `rotate(${pointer}deg)` } : { opacity: 0.3 }}
          aria-hidden
        >
          <svg viewBox="-12 -12 24 24">
            <path d="M0 -11 L8 9 L0 4 L-8 9 Z" />
          </svg>
        </span>
        <div className="nav-figures">
          {session.finished ? (
            <span className="nav-big">✓ Arrived</span>
          ) : distanceM != null ? (
            <>
              <span className="nav-big">{formatDistance(distanceM)}</span>
              <span className="nav-big">{formatBearing(bearing ?? 0, position)}</span>
              <span className="nav-mid">{readout.etaS != null ? `ETA ${formatDuration(readout.etaS * 1000)}` : 'ETA —'}</span>
            </>
          ) : (
            <span className="nav-mid">Waiting for GPS…</span>
          )}
        </div>
        <button className="btn nav-end" onClick={onEnd}>
          End
        </button>
      </div>
      <div className="nav-sub">
        <span className="nav-target">
          {isRoute ? `${index + 1}/${count} · ` : ''}
          {wp?.name || 'Target'}
        </span>
        {readout.speedMps != null && <span>{formatSpeed(readout.speedMps)}</span>}
        {isRoute && readout.remainingM != null && !session.finished && (
          <span>
            {formatDistance(readout.remainingM)} to end
            {readout.etaEndS != null && ` (${formatDuration(readout.etaEndS * 1000)})`}
          </span>
        )}
        {weakGps && <span className="nav-warn">GPS ±{formatDistance(readout.accuracy!)}</span>}
      </div>
      {isRoute && (
        <div className="nav-buttons">
          <button className="btn" onClick={onBack} disabled={index === 0 && !session.finished}>
            ◀ Back
          </button>
          <button className="btn" onClick={onSkip} disabled={session.finished}>
            Skip ▶
          </button>
          <button className="btn" onClick={onEditRoute}>
            ✎ Route
          </button>
        </div>
      )}
    </div>
  )
}
