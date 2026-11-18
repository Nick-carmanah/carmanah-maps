import type { Position } from 'geojson'
import { formatCoord, FORMAT_LABELS } from '../lib/coords'
import { formatAltitude, formatBearing, formatDistance, formatSpeed } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'
import { useGpsFix, useNow } from '../hooks/useGpsFix'
import GoogleMapsButton from './GoogleMapsButton'
import './GpsTools.css'

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  return `${Math.floor(m / 60)} h ${m % 60} min ago`
}

/** GPS info: where the phone thinks it is and how sure it is. Every number
 * follows the unit settings. */
export default function GpsInfoPanel({
  onClose,
  onNotify,
}: {
  onClose: () => void
  onNotify: (message: string, isError?: boolean) => void
}) {
  const units = useUnitSettings()
  const { fix, error } = useGpsFix()
  const now = useNow(true)
  const position: Position | null = fix ? [fix.lng, fix.lat] : null
  const coordText = position ? formatCoord(position, units.coords) : null
  const stale = fix ? now - fix.time > 30_000 : false
  const dash = '—'

  const rows: [string, string][] = fix
    ? [
        [
          'Accuracy',
          fix.accuracy != null ? `±${formatDistance(fix.accuracy)}` : dash,
        ],
        [
          'Altitude',
          fix.altitude != null
            ? `${formatAltitude(fix.altitude)}${
                fix.altitudeAccuracy != null ? ` ±${formatAltitude(fix.altitudeAccuracy)}` : ''
              }`
            : dash,
        ],
        ['Speed', fix.speed != null ? formatSpeed(fix.speed) : dash],
        [
          'Heading',
          fix.heading != null && (fix.speed == null || fix.speed > 0)
            ? formatBearing(fix.heading, position)
            : dash,
        ],
        [
          'Last fix',
          `${new Date(fix.time).toLocaleTimeString('en-CA', { hour12: false })} (${ago(now - fix.time)})`,
        ],
      ]
    : []

  return (
    <div className="feature-sheet gps-sheet" role="dialog" aria-label="GPS info">
      <div className="sheet-header">
        <span className="kind-icon">📡</span>
        <span className="sheet-title">GPS info</span>
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="sheet-scroll">
        {fix ? (
          <>
            <div className="gps-position">
              <span className="gps-format">{FORMAT_LABELS[units.coords]}</span>
              <span className="gps-coords">{coordText}</span>
            </div>
            <dl className="gps-grid">
              {rows.map(([k, v]) => (
                <div key={k} className={k === 'Last fix' && stale ? 'gps-stale' : undefined}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <div className="gps-status">{error ? `GPS: ${error}` : 'Waiting for GPS…'}</div>
        )}
        {fix && error && <div className="gps-status error">GPS: {error}</div>}
        {fix && (
          <div className="gps-actions">
            <button
              className="btn small"
              onClick={() =>
                navigator.clipboard?.writeText(coordText ?? '').then(
                  () => onNotify(`Copied ${coordText}`),
                  () => onNotify('Could not copy', true),
                )
              }
            >
              Copy position
            </button>
            {position && <GoogleMapsButton position={position} />}
          </div>
        )}
      </div>
    </div>
  )
}
