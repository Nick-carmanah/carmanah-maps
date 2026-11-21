import { useEffect, useState } from 'react'
import type { Position } from 'geojson'
import type { UserFeature } from '../lib/features'
import { legTo, routeLengthM, waypointPositions, type Waypoint } from '../lib/navigation'
import { formatBearing, formatDistance } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'
import { useGpsFix, useNow } from '../hooks/useGpsFix'
import FeaturePicker from './FeaturePicker'

/** Route points come from placemarks and areas (a line is followed instead). */
const PICK_KINDS: UserFeature['kind'][] = ['pin', 'area']
/** "My position" needs a fix at least this fresh, ms. */
const FRESH_FIX_MS = 30_000

/**
 * Plan a route: an ordered list of waypoints. Tap placemarks or the map to
 * add them (the hook listens to the map while this is open), or add the
 * crosshair, your position, or a placemark from the list. Every action is
 * a big button: move up, move down, remove; no dragging or long-presses.
 * Docked at the bottom so the top half of the map (and the crosshair)
 * stays in view.
 */
export default function RoutePanel({
  waypoints,
  features,
  hiddenLayerIds,
  from,
  resuming,
  onChange,
  onAddCrosshair,
  onAddMyPosition,
  onAddFeature,
  onSaveLine,
  onStart,
  onClose,
}: {
  waypoints: Waypoint[]
  features: UserFeature[]
  hiddenLayerIds: Set<string>
  /** For the list's distances: you, or the crosshair. */
  from: Position | null
  /** Editing the route being navigated: Start carries on from the same point. */
  resuming: boolean
  onChange: (waypoints: Waypoint[]) => void
  onAddCrosshair: () => void
  onAddMyPosition: (position: Position) => void
  onAddFeature: (feature: UserFeature) => void
  onSaveLine: () => void
  onStart: () => void
  onClose: () => void
}) {
  useUnitSettings()
  // GPS stays on while planning, so "My position" is where you are now.
  const { fix } = useGpsFix()
  const now = useNow(true, 5000)
  const freshFix = fix && now - fix.time < FRESH_FIX_MS ? fix : null
  const [picking, setPicking] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  useEffect(() => {
    if (!clearArmed) return
    const t = setTimeout(() => setClearArmed(false), 4000)
    return () => clearTimeout(t)
  }, [clearArmed])

  const points = waypointPositions(waypoints, features)
  const total = routeLengthM(points)
  const move = (i: number, by: -1 | 1) => {
    const j = i + by
    if (j < 0 || j >= waypoints.length) return
    const next = waypoints.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="nav-dock route-panel" role="dialog" aria-label="Plan a route">
      <div className="sheet-header">
        <span className="kind-icon">🚩</span>
        <span className="sheet-title">
          Route · {waypoints.length} point{waypoints.length === 1 ? '' : 's'}
          {waypoints.length > 1 && ` · ${formatDistance(total)}`}
        </span>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>

      {picking ? (
        <>
          <FeaturePicker
            features={features}
            hiddenLayerIds={hiddenLayerIds}
            from={from}
            kinds={PICK_KINDS}
            pickLabel="Add"
            onPick={(f) => {
              onAddFeature(f)
              setPicking(false)
            }}
          />
          <button className="btn" onClick={() => setPicking(false)}>
            Back to the route
          </button>
        </>
      ) : (
        <>
          <div className="settings-hint">
            Tap placemarks or the map to add points, in the order you'll walk them.
          </div>
          <ol className="route-list">
            {waypoints.map((wp, i) => {
              const leg = i > 0 ? legTo(points[i - 1], points[i]) : null
              return (
                <li key={wp.id} className="route-row">
                  <span className="route-num">{i + 1}</span>
                  <span className="route-name">
                    {wp.name}
                    {leg && (
                      <small>
                        {formatDistance(leg.distanceM)} · {formatBearing(leg.bearing, points[i - 1])}
                      </small>
                    )}
                  </span>
                  <button className="btn route-icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${wp.name} up`}>
                    ▲
                  </button>
                  <button
                    className="btn route-icon-btn"
                    onClick={() => move(i, 1)}
                    disabled={i === waypoints.length - 1}
                    aria-label={`Move ${wp.name} down`}
                  >
                    ▼
                  </button>
                  <button
                    className="btn route-icon-btn danger"
                    onClick={() => onChange(waypoints.filter((w) => w.id !== wp.id))}
                    aria-label={`Remove ${wp.name}`}
                  >
                    ✕
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="nav-actions">
            <button className="btn" onClick={onAddCrosshair}>
              ＋ Crosshair
            </button>
            <button
              className="btn"
              disabled={!freshFix}
              title={freshFix ? undefined : 'Waiting for GPS'}
              onClick={() => freshFix && onAddMyPosition([freshFix.lng, freshFix.lat])}
            >
              ＋ My position
            </button>
            <button className="btn" onClick={() => setPicking(true)}>
              ＋ From list
            </button>
          </div>
          <div className="nav-actions">
            <button className="btn" onClick={() => onChange(waypoints.slice().reverse())} disabled={waypoints.length < 2}>
              ⇅ Reverse
            </button>
            <button
              className="btn danger"
              disabled={!waypoints.length}
              onClick={() => {
                if (!clearArmed) {
                  setClearArmed(true)
                  return
                }
                setClearArmed(false)
                onChange([])
              }}
            >
              {clearArmed ? 'Tap again to clear' : 'Clear'}
            </button>
            <button className="btn" onClick={onSaveLine} disabled={waypoints.length < 2}>
              Save as line
            </button>
            <button className="btn primary" onClick={onStart} disabled={!waypoints.length}>
              ▶ {resuming ? 'Carry on' : 'Start'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
