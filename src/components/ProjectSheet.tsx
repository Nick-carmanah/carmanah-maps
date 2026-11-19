import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Position } from 'geojson'
import type { UserFeature } from '../lib/features'
import {
  bearingToTrue,
  bearingUnitLabel,
  destination,
  distanceInputUnits,
  parseBearing,
  parseLength,
} from '../lib/cogo'
import { formatCoord } from '../lib/coords'
import { bearingDeg } from '../lib/geo'
import { navTargetPosition } from '../lib/navigation'
import { formatBearing, formatDistance } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'
import { useGpsFix } from '../hooks/useGpsFix'
import FeaturePicker from './FeaturePicker'

export type ProjectOrigin =
  | { kind: 'gps' }
  | { kind: 'crosshair'; position: Position }
  | { kind: 'feature'; featureId: string }

export interface ProjectedPoint {
  position: Position
  /** For the saved placemark's notes and the target's name. */
  description: string
}

const PICK_KINDS: UserFeature['kind'][] = ['pin', 'area']

/**
 * Project a point: from you, the crosshair or a placemark, along a bearing
 * (degrees or mils, true or magnetic, per the units settings; quadrant
 * bearings like N45E work too) for a distance. The line previews on the
 * map as you type; then save it as a placemark, navigate to it, or add it
 * to the route being planned. Docked at the bottom so the map stays in
 * view.
 */
export default function ProjectSheet({
  map,
  features,
  hiddenLayerIds,
  initialOrigin,
  canAddToRoute,
  onPreview,
  onSave,
  onGo,
  onAddToRoute,
  onClose,
}: {
  map: MlMap | null
  features: UserFeature[]
  hiddenLayerIds: Set<string>
  initialOrigin: ProjectOrigin
  canAddToRoute: boolean
  onPreview: (line: { from: Position; to: Position } | null) => void
  onSave: (p: ProjectedPoint) => void
  onGo: (p: ProjectedPoint) => void
  onAddToRoute: (p: ProjectedPoint) => void
  onClose: () => void
}) {
  const units = useUnitSettings()
  const { fix } = useGpsFix()
  const [origin, setOrigin] = useState<ProjectOrigin>(initialOrigin)
  const [picking, setPicking] = useState(false)
  const [bearingText, setBearingText] = useState('')
  const [distanceText, setDistanceText] = useState('')
  const unitChoices = distanceInputUnits(units)
  const [unitLabel, setUnitLabel] = useState(unitChoices[0].label)
  const unit = unitChoices.find((u) => u.label === unitLabel) ?? unitChoices[0]

  const originFeature = origin.kind === 'feature' ? features.find((f) => f.id === origin.featureId) : undefined
  const from: Position | null =
    origin.kind === 'gps'
      ? fix
        ? [fix.lng, fix.lat]
        : null
      : origin.kind === 'crosshair'
        ? origin.position
        : originFeature
          ? navTargetPosition(originFeature)
          : null
  const fromName =
    origin.kind === 'gps' ? 'my position' : origin.kind === 'crosshair' ? 'the crosshair' : (originFeature?.name ?? 'a placemark')

  const typedBearing = parseBearing(bearingText, units.angle)
  const typedLength = parseLength(distanceText)
  const result = useMemo(() => {
    if (!from || typedBearing == null || typedLength == null) return null
    const trueDeg = bearingToTrue(typedBearing, from, units)
    const meters = typedLength * unit.meters
    const to = destination(from, trueDeg, meters)
    return { from, to, trueDeg, meters }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from?.[0], from?.[1], typedBearing, typedLength, unit.meters, units.angle, units.north])

  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview
  useEffect(() => {
    onPreviewRef.current(result ? { from: result.from, to: result.to } : null)
  }, [result])
  useEffect(() => () => onPreviewRef.current(null), [])

  const projected: ProjectedPoint | null = result
    ? {
        position: result.to,
        description: `${formatBearing(result.trueDeg, result.from)} ${formatDistance(result.meters)} from ${fromName}`,
      }
    : null

  const crosshair = (): Position | null => {
    const c = map?.getCenter()
    return c ? [c.lng, c.lat] : null
  }

  return (
    <div className="nav-dock project-sheet" role="dialog" aria-label="Project a point">
      <div className="sheet-header">
        <span className="kind-icon">📐</span>
        <span className="sheet-title">Project a point</span>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>

      {picking ? (
        <>
          <FeaturePicker
            features={features}
            hiddenLayerIds={hiddenLayerIds}
            from={fix ? [fix.lng, fix.lat] : crosshair()}
            kinds={PICK_KINDS}
            pickLabel="From here"
            onPick={(f) => {
              setOrigin({ kind: 'feature', featureId: f.id })
              setPicking(false)
            }}
          />
          <button className="btn" onClick={() => setPicking(false)}>
            Back
          </button>
        </>
      ) : (
        <>
          <div className="nav-segment" role="group" aria-label="Project from">
            <button className={`btn${origin.kind === 'gps' ? ' active' : ''}`} onClick={() => setOrigin({ kind: 'gps' })}>
              My position
            </button>
            <button
              className={`btn${origin.kind === 'crosshair' ? ' active' : ''}`}
              onClick={() => {
                const c = crosshair()
                if (c) setOrigin({ kind: 'crosshair', position: c })
              }}
              title="Takes the crosshair where it is now"
            >
              Crosshair
            </button>
            <button className={`btn${origin.kind === 'feature' ? ' active' : ''}`} onClick={() => setPicking(true)}>
              {origin.kind === 'feature' && originFeature ? originFeature.name : 'Placemark…'}
            </button>
          </div>
          <div className="settings-hint">
            From {fromName}
            {from ? `: ${formatCoord(from, units.coords)}` : origin.kind === 'gps' ? ': waiting for GPS…' : ''}
          </div>
          <div className="nav-form">
            <label>
              <span>Bearing</span>
              <span className="nav-input-row">
                <input
                  className="nav-input"
                  inputMode="decimal"
                  enterKeyHint="next"
                  value={bearingText}
                  onChange={(e) => setBearingText(e.target.value)}
                  placeholder={units.angle === 'mil' ? 'e.g. 0800' : 'e.g. 45 or N45E'}
                  aria-invalid={bearingText.trim() !== '' && typedBearing == null}
                />
                <span className="nav-unit">{bearingUnitLabel(units)}</span>
              </span>
            </label>
            <label>
              <span>Distance</span>
              <span className="nav-input-row">
                <input
                  className="nav-input"
                  inputMode="decimal"
                  enterKeyHint="done"
                  value={distanceText}
                  onChange={(e) => setDistanceText(e.target.value)}
                  placeholder="e.g. 250"
                  aria-invalid={distanceText.trim() !== '' && typedLength == null}
                />
                <select className="nav-unit-select" value={unit.label} onChange={(e) => setUnitLabel(e.target.value)}>
                  {unitChoices.map((u) => (
                    <option key={u.label} value={u.label}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>
          </div>
          {bearingText.trim() !== '' && typedBearing == null && (
            <div className="settings-hint error">
              {units.angle === 'mil' ? 'Bearing: mils 0–6400.' : 'Bearing: degrees 0–360 (45, 45.5, 45°30′) or a quadrant (N45E).'}
            </div>
          )}
          {result && (
            <div className="nav-result">
              <strong>{formatCoord(result.to, units.coords)}</strong>
              <span>
                Back bearing {formatBearing(bearingDeg(result.to, result.from), result.to)}
              </span>
            </div>
          )}
          <div className="nav-actions">
            <button className="btn" disabled={!projected} onClick={() => projected && onSave(projected)}>
              Save placemark
            </button>
            {canAddToRoute && (
              <button className="btn" disabled={!projected} onClick={() => projected && onAddToRoute(projected)}>
                ＋ Route
              </button>
            )}
            <button className="btn primary" disabled={!projected} onClick={() => projected && onGo(projected)}>
              Go to it
            </button>
          </div>
        </>
      )}
    </div>
  )
}
