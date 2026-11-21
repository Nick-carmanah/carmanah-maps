import { useSyncExternalStore } from 'react'
import {
  approachChoices,
  getNavSettings,
  radiusChoices,
  setNavSettings,
  subscribeNavSettings,
  type NavSettings,
} from '../lib/nav-settings'
import { formatDistance, inputDistanceUnit } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'

export function useNavSettings(): NavSettings {
  return useSyncExternalStore(subscribeNavSettings, getNavSettings)
}

/** Choices plus the stored value when it isn't one of them (set in another unit). */
function withCurrent(choices: number[], current: number): number[] {
  return choices.some((c) => Math.abs(c - current) < 0.01) ? choices : [...choices, current].sort((a, b) => a - b)
}

const near = (choices: number[], v: number) => choices.find((c) => Math.abs(c - v) < 0.01) ?? v

/** Settings → Navigation: arrival radius, approach alert, and how alerts reach you. */
export default function NavigationSettings() {
  const units = useUnitSettings()
  const s = useNavSettings()
  const unit = inputDistanceUnit(units).label as 'm' | 'ft' | 'ch'
  const radii = withCurrent(radiusChoices(unit), s.arrivalRadiusM)
  const approaches = withCurrent(approachChoices(unit), s.approachM)
  const toggle = (key: 'autoAdvance' | 'sound' | 'vibrate' | 'keepScreenOn', label: string, hint: string) => (
    <label className="units-row">
      <span className="units-label">{label}</span>
      <select value={s[key] ? 'on' : 'off'} onChange={(e) => setNavSettings({ [key]: e.target.value === 'on' })}>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
      <span className="units-example">{hint}</span>
    </label>
  )

  return (
    <div className="units-settings">
      <div className="settings-group-title">Navigation</div>
      <label className="units-row">
        <span className="units-label">Arrival radius</span>
        <select
          value={String(near(radii, s.arrivalRadiusM))}
          onChange={(e) => setNavSettings({ arrivalRadiusM: Number(e.target.value) })}
        >
          {radii.map((m) => (
            <option key={m} value={String(m)}>
              {formatDistance(m)}
            </option>
          ))}
        </select>
        <span className="units-example">Arrived (alert, and on to the next point) this close</span>
      </label>
      <label className="units-row">
        <span className="units-label">Approach alert</span>
        <select
          value={String(near(approaches, s.approachM))}
          onChange={(e) => setNavSettings({ approachM: Number(e.target.value) })}
        >
          {approaches.map((m) => (
            <option key={m} value={String(m)}>
              {m === 0 ? 'Off' : formatDistance(m)}
            </option>
          ))}
        </select>
        <span className="units-example">A heads-up this far out</span>
      </label>
      {toggle('autoAdvance', 'Next point', 'Routes: on arrival, go on to the next point by itself (Off: tap Skip)')}
      {toggle('sound', 'Sound', 'A beep on alerts (the iPhone silent switch mutes it)')}
      {toggle('vibrate', 'Vibrate', 'Android phones; iPhones don’t let web pages vibrate')}
      {toggle('keepScreenOn', 'Screen on', 'Keep the screen on while navigating (uses more battery)')}
    </div>
  )
}
