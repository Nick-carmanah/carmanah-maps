import type { Position } from 'geojson'
import { formatCoord } from '../lib/coords'
import { declinationDeg, WMM_NAME, WMM_VALID_UNTIL, wmmIsCurrent } from '../lib/magnetic'
import {
  formatAltitude,
  formatArea,
  formatBearing,
  formatDeclination,
  formatDistance,
  formatPace,
  formatSpeed,
  setUnitSettings,
  type UnitSettings,
} from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'

/** Where the examples are worked out: Kamloops, so magnetic north shows a BC declination. */
const SAMPLE: Position = [-120.3273, 50.6745]

interface Row<K extends keyof UnitSettings> {
  key: K
  label: string
  options: [UnitSettings[K], string][]
  example: (s: UnitSettings) => string
}

const row = <K extends keyof UnitSettings>(r: Row<K>) => r as unknown as Row<keyof UnitSettings>

const ROWS: Row<keyof UnitSettings>[] = [
  row({
    key: 'distance',
    label: 'Distance',
    options: [
      ['metric', 'Metric (m, km)'],
      ['imperial', 'Imperial (ft, mi)'],
      ['nautical', 'Nautical (NM, ft)'],
      ['chains', 'Chains (ch)'],
    ],
    example: (s) => `${formatDistance(1500, s)} · ${formatDistance(120, s)}`,
  }),
  row({
    key: 'area',
    label: 'Area',
    options: [
      ['ha', 'Hectares (ha)'],
      ['m2', 'Square metres (m²)'],
      ['km2', 'Square kilometres (km²)'],
      ['ac', 'Acres (ac)'],
      ['mi2', 'Square miles (mi²)'],
    ],
    example: (s) => formatArea(250_000, s),
  }),
  row({
    key: 'coords',
    label: 'Coordinates',
    options: [
      ['dd', 'Lat/long DD'],
      ['ddm', 'Lat/long DDM'],
      ['dms', 'Lat/long DMS'],
      ['utm', 'UTM'],
      ['mgrs', 'MGRS'],
      ['bcalbers', 'BC Albers (EPSG:3005)'],
    ],
    example: (s) => formatCoord(SAMPLE, s.coords),
  }),
  row({
    key: 'speed',
    label: 'Speed',
    options: [
      ['kmh', 'Kilometres per hour (km/h)'],
      ['mph', 'Miles per hour (mph)'],
      ['kn', 'Knots (kn)'],
      ['ms', 'Metres per second (m/s)'],
    ],
    example: (s) => formatSpeed(1.5, s),
  }),
  row({
    key: 'angle',
    label: 'Angle',
    options: [
      ['deg', 'Degrees (360°)'],
      ['mil', 'Mils (6400)'],
    ],
    example: (s) => formatBearing(245, null, { ...s, north: 'true' }),
  }),
  row({
    key: 'north',
    label: 'North',
    options: [
      ['true', 'True north'],
      ['magnetic', 'Magnetic north'],
    ],
    example: (s) =>
      s.north === 'magnetic'
        ? `245°T = ${formatBearing(245, SAMPLE, { ...s, angle: 'deg' })} (declination ${formatDeclination(declinationDeg(SAMPLE[1], SAMPLE[0]))})`
        : 'Bearings from true north (T)',
  }),
  row({
    key: 'altitude',
    label: 'Altitude',
    options: [
      ['m', 'Metres (m)'],
      ['ft', 'Feet (ft)'],
    ],
    example: (s) => formatAltitude(1250, s),
  }),
  row({
    key: 'pace',
    label: 'Pace',
    options: [
      ['min/km', 'Minutes per kilometre'],
      ['min/mi', 'Minutes per mile'],
    ],
    example: (s) => formatPace(15 * 60_000, 1000, s) ?? '',
  }),
]

/** Settings → Units of measurement: one choice per metric, applied everywhere. */
export default function UnitsSettings() {
  const settings = useUnitSettings()
  return (
    <div className="units-settings">
      <div className="settings-group-title">Units of measurement</div>
      {ROWS.map((r) => (
        <label className="units-row" key={r.key}>
          <span className="units-label">{r.label}</span>
          <select
            value={settings[r.key]}
            onChange={(e) => setUnitSettings({ [r.key]: e.target.value })}
          >
            {r.options.map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
          <span className="units-example">{r.example(settings)}</span>
        </label>
      ))}
      <div className="settings-hint">
        Examples are worked out for Kamloops today. Magnetic north uses NOAA’s {WMM_NAME}{' '}
        model on the phone, so it works offline.
        {!wmmIsCurrent() &&
          ` The model ran out at the start of ${WMM_VALID_UNTIL}: update the app for accurate magnetic bearings.`}{' '}
        Find by coordinates accepts every format, whatever is chosen here.
      </div>
    </div>
  )
}
