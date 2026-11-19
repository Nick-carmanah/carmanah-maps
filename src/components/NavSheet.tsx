import { useState } from 'react'
import type { Position } from 'geojson'
import type { UserFeature } from '../lib/features'
import { formatCoord } from '../lib/coords'
import { useUnitSettings } from '../hooks/useUnitSettings'
import FeaturePicker from './FeaturePicker'

/**
 * Tools → Navigate: where to go. Each choice is one big row (gloves).
 * Going to coordinates: find them with "Find by coordinates" (the map
 * flies there), then "Go to the crosshair".
 */
export default function NavSheet({
  features,
  hiddenLayerIds,
  crosshair,
  from,
  navigating,
  draftCount,
  onGoCrosshair,
  onGoFeature,
  onFollowLine,
  onPlanRoute,
  onProject,
  onEnd,
  onClose,
}: {
  features: UserFeature[]
  hiddenLayerIds: Set<string>
  crosshair: Position | null
  /** Where list distances are measured from. */
  from: Position | null
  navigating: boolean
  draftCount: number
  onGoCrosshair: () => void
  onGoFeature: (f: UserFeature) => void
  onFollowLine: (f: UserFeature) => void
  onPlanRoute: () => void
  onProject: () => void
  onEnd: () => void
  onClose: () => void
}) {
  const units = useUnitSettings()
  const [picking, setPicking] = useState(false)

  return (
    <div className="sheet-wrap">
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="tool-sheet nav-sheet" role="dialog" aria-label="Navigate">
        <div className="sheet-header">
          <span className="kind-icon">🚩</span>
          <span className="sheet-title">{picking ? 'Go to a feature' : 'Navigate'}</span>
          <button className="btn" onClick={picking ? () => setPicking(false) : onClose}>
            {picking ? 'Back' : 'Close'}
          </button>
        </div>
        {picking ? (
          <FeaturePicker
            features={features}
            hiddenLayerIds={hiddenLayerIds}
            from={from}
            onPick={onGoFeature}
            onFollow={onFollowLine}
          />
        ) : (
          <>
            <button className="tool-row" onClick={onGoCrosshair} disabled={!crosshair}>
              <span className="tool-icon">⌖</span>
              <span className="nav-row-text">
                Go to the crosshair
                {crosshair && <small>{formatCoord(crosshair, units.coords)}</small>}
              </span>
            </button>
            <button className="tool-row" onClick={() => setPicking(true)}>
              <span className="tool-icon">📍</span>
              <span className="nav-row-text">
                Go to a placemark or feature
                <small>Nearest first; follow a line point by point</small>
              </span>
            </button>
            <button className="tool-row" onClick={onPlanRoute}>
              <span className="tool-icon">🚩</span>
              <span className="nav-row-text">
                Plan a route
                <small>
                  {draftCount
                    ? `${draftCount} point${draftCount === 1 ? '' : 's'} planned`
                    : 'Waypoints in order, followed leg by leg'}
                </small>
              </span>
            </button>
            <button className="tool-row" onClick={onProject}>
              <span className="tool-icon">📐</span>
              <span className="nav-row-text">
                Project a point
                <small>Bearing and distance from you, the crosshair or a placemark</small>
              </span>
            </button>
            {navigating && (
              <button className="tool-row" onClick={onEnd}>
                <span className="tool-icon">⏹</span>
                End navigation
              </button>
            )}
            <div className="settings-hint">
              For coordinates: Find by coordinates first, then Go to the crosshair. Arrival radius and alerts:
              Profile and settings → Navigation.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
