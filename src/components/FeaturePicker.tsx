import { useMemo, useState } from 'react'
import type { Position } from 'geojson'
import { KIND_ICONS, type UserFeature } from '../lib/features'
import { legTo, navTargetPosition } from '../lib/navigation'
import { formatBearing, formatDistance } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'

/** Rows shown at once; the filter finds the rest. */
const MAX_ROWS = 60
const ALL_KINDS: UserFeature['kind'][] = ['pin', 'line', 'area']

/**
 * A list of your placemarks (and lines and areas), nearest first, to pick a
 * navigation target or a route point from. Hidden layers are left out.
 * Big rows for gloves; lines can also be followed point by point.
 */
export default function FeaturePicker({
  features,
  hiddenLayerIds,
  from,
  kinds = ALL_KINDS,
  onPick,
  onFollow,
  pickLabel = 'Go',
}: {
  features: UserFeature[]
  hiddenLayerIds: Set<string>
  /** Distances are measured from here (you, or the crosshair). */
  from: Position | null
  kinds?: UserFeature['kind'][]
  onPick: (feature: UserFeature) => void
  /** Lines: follow them vertex by vertex. */
  onFollow?: (feature: UserFeature) => void
  pickLabel?: string
}) {
  useUnitSettings()
  const [filter, setFilter] = useState('')
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return features
      .filter((f) => kinds.includes(f.kind) && !hiddenLayerIds.has(f.layerId))
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .map((f) => {
        const at = navTargetPosition(f)
        return { f, at, leg: from ? legTo(from, at) : null }
      })
      .sort((a, b) => (a.leg && b.leg ? a.leg.distanceM - b.leg.distanceM : a.f.name.localeCompare(b.f.name)))
  }, [features, hiddenLayerIds, kinds, filter, from])

  return (
    <div className="nav-picker">
      <input
        className="nav-input nav-picker-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name…"
        aria-label="Filter features by name"
      />
      {rows.length === 0 && <div className="settings-hint">Nothing to pick: drop a pin or import a layer first.</div>}
      <div className="nav-picker-list">
        {rows.slice(0, MAX_ROWS).map(({ f, leg }) => (
          <div className="nav-picker-row" key={f.id}>
            <button className="nav-picker-main" onClick={() => onPick(f)}>
              <span className="nav-picker-icon" aria-hidden>
                {KIND_ICONS[f.kind]}
              </span>
              <span className="nav-picker-name">{f.name || '(no name)'}</span>
              {leg && (
                <span className="nav-picker-leg">
                  {formatDistance(leg.distanceM)} · {formatBearing(leg.bearing, from)}
                </span>
              )}
              <span className="nav-picker-go">{pickLabel}</span>
            </button>
            {onFollow && f.kind === 'line' && (
              <button className="btn nav-picker-follow" onClick={() => onFollow(f)} title="Follow this line point by point">
                ↝ Follow
              </button>
            )}
          </div>
        ))}
      </div>
      {rows.length > MAX_ROWS && (
        <div className="settings-hint">
          Showing the nearest {MAX_ROWS} of {rows.length}. Filter by name for the rest.
        </div>
      )}
    </div>
  )
}
