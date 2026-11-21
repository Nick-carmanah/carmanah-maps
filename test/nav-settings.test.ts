/**
 * Navigation settings (src/lib/nav-settings.ts): defaults, sanitising a
 * stored entry, and the radius choices in each typing unit.
 */
import { describe, expect, it } from 'vitest'
import {
  approachChoices,
  DEFAULT_NAV_SETTINGS,
  radiusChoices,
  sanitizeNavSettings,
} from '../src/lib/nav-settings'
import { M_PER_CHAIN, M_PER_FT } from '../src/lib/units'

describe('navigation settings', () => {
  it('defaults: 20 m arrival, 100 m heads-up, auto-advance, sound and vibration on, screen sleeps', () => {
    expect(sanitizeNavSettings(undefined)).toEqual(DEFAULT_NAV_SETTINGS)
    expect(DEFAULT_NAV_SETTINGS).toEqual({
      arrivalRadiusM: 20,
      approachM: 100,
      autoAdvance: true,
      sound: true,
      vibrate: true,
      keepScreenOn: false,
    })
  })

  it('keeps good values and drops bad ones', () => {
    expect(
      sanitizeNavSettings({ arrivalRadiusM: 50, approachM: 0, autoAdvance: false, sound: false, keepScreenOn: true }),
    ).toEqual({ ...DEFAULT_NAV_SETTINGS, arrivalRadiusM: 50, approachM: 0, autoAdvance: false, sound: false, keepScreenOn: true })
    expect(sanitizeNavSettings({ arrivalRadiusM: -5, approachM: 'far', vibrate: 'yes' })).toEqual(DEFAULT_NAV_SETTINGS)
    expect(sanitizeNavSettings({ arrivalRadiusM: Number.NaN, approachM: 1e9 })).toEqual(DEFAULT_NAV_SETTINGS)
  })

  it('offers round numbers in the unit crews type in', () => {
    expect(radiusChoices('m')).toContain(20)
    expect(radiusChoices('ft').map((m) => Math.round(m / M_PER_FT))).toEqual([15, 30, 50, 75, 100, 150, 300])
    expect(radiusChoices('ch')[2]).toBeCloseTo(M_PER_CHAIN, 9)
    expect(approachChoices('m')[0]).toBe(0)
    expect(approachChoices('ft')[6]).toBeCloseTo(1609.344, 6)
  })
})
