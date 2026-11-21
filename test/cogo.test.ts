import { describe, expect, it } from 'vitest'
import type { Position } from 'geojson'
import {
  bearingToTrue,
  bearingUnitLabel,
  destination,
  distanceInputUnits,
  inverse,
  parseBearing,
  parseLength,
  traverse,
} from '../src/lib/cogo'
import { metresPerDegree } from '../src/lib/geodesic'
import { declinationDeg } from '../src/lib/magnetic'
import { pathLengthMeters } from '../src/lib/measure'
import { formatBearing, DEFAULT_UNIT_SETTINGS, M_PER_CHAIN, M_PER_FT } from '../src/lib/units'

/** Degrees, minutes, seconds; the sign of `d` applies to the whole angle. */
const dms = (d: number, m: number, s: number) => (d < 0 ? -1 : 1) * (Math.abs(d) + m / 60 + s / 3600)

/** Ground distance between two nearby positions, metres (for tolerances). */
const gap = (a: Position, b: Position) => inverse(a, b).meters

// Somewhere in the BC Interior, mid-2026.
const KAMLOOPS: Position = [-120.3273, 50.6745]
const DATE = new Date('2026-07-01T00:00:00Z')

describe('destination (course and distance)', () => {
  it('matches GeographicLib’s GeodSolve1 (JFK, 053.5°, 5,850 km → near Paris CDG)', () => {
    // GeographicLib test GeodSolve1: Direct(40.63972222, −73.77888889, 53.5, 5850e3)
    //   → lat2 49.01467, lon2 2.56106 (to 0.5e-5°).
    const got = destination([-73.77888889, 40.63972222], 53.5, 5850e3)
    expect(Math.abs(got[1] - 49.01467)).toBeLessThan(0.5e-5)
    expect(Math.abs(got[0] - 2.56106)).toBeLessThan(0.5e-5)
  })

  it('lands on the Movable Type example’s end point, with its WGS84 course and distance', () => {
    // 53°19′14″N 001°43′47″W → 53°11′18″N 000°08′00″E. Movable Type works it
    // on a sphere (124.8 km at 096°01′18″); on WGS84 it's 125,207.820 m at
    // 096.0020842° (Karney's inverse, as geodesic.ts; Vincenty's agrees to 0.1 mm).
    const start: Position = [dms(-1, 43, 47), dms(53, 19, 14)]
    const got = destination(start, 96.0020842, 125207.82)
    expect(Math.abs(got[1] - dms(53, 11, 18)) * 3600).toBeLessThan(0.001)
    expect(Math.abs(got[0] - dms(0, 8, 0)) * 3600).toBeLessThan(0.001)
  })

  it('follows the ellipsoid along the equator and a meridian', () => {
    const a = 6378137
    const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)
    // Along the equator: arcs of the equatorial circle, radius a.
    const east = destination([0, 0], 90, 1000)
    expect(east[0]).toBeCloseTo((1000 / a) * (180 / Math.PI), 12)
    expect(east[1]).toBeCloseTo(0, 12)
    // North from the equator: the meridian's radius of curvature there, a(1 − e²).
    const north = destination([0, 0], 0, 1000)
    expect(north[0]).toBeCloseTo(0, 12)
    expect(north[1]).toBeCloseTo((1000 / (a * (1 - e2))) * (180 / Math.PI), 10)
    // 5 km south of Kamloops: the local metres per degree north.
    const south = destination(KAMLOOPS, 180, 5000)
    expect(south[0]).toBeCloseTo(KAMLOOPS[0], 12)
    expect(KAMLOOPS[1] - south[1]).toBeCloseTo(5000 / metresPerDegree((KAMLOOPS[1] + south[1]) / 2).north, 9)
  })

  it('agrees with the app’s own ruler: a typed leg measures what was typed', () => {
    const end = destination(KAMLOOPS, 90, 1000)
    expect(pathLengthMeters([KAMLOOPS, end])).toBeCloseTo(1000, 6)
  })

  it('round-trips with the inverse at field distances', () => {
    for (const [bearing, meters] of [
      [0, 50],
      [45, 250],
      [137.5, 1234.5],
      [271, 8000],
      [359.9, 30000],
    ]) {
      const end = destination(KAMLOOPS, bearing, meters)
      const back = inverse(KAMLOOPS, end)
      expect(back.meters).toBeCloseTo(meters, 5) // 10 µm
      expect(back.bearing).toBeCloseTo(bearing, 7)
    }
  })

  it('a zero distance stays put', () => {
    expect(destination(KAMLOOPS, 123, 0)).toEqual(KAMLOOPS)
  })

  it('chains legs into a traverse', () => {
    const legs = [
      { trueDeg: 90, meters: 200 },
      { trueDeg: 180, meters: 150 },
      { trueDeg: 300, meters: 75 },
    ]
    const pts = traverse(KAMLOOPS, legs)
    expect(pts).toHaveLength(4)
    expect(pts[0]).toEqual(KAMLOOPS)
    let at = KAMLOOPS
    legs.forEach((leg, i) => {
      at = destination(at, leg.trueDeg, leg.meters)
      expect(pts[i + 1]).toEqual(at)
      expect(gap(pts[i], pts[i + 1])).toBeCloseTo(leg.meters, 6)
    })
  })
})

describe('typed bearings', () => {
  const T = { angle: 'deg', north: 'true' } as const
  const M = { angle: 'deg', north: 'magnetic' } as const
  const MIL_T = { angle: 'mil', north: 'true' } as const
  const MIL_M = { angle: 'mil', north: 'magnetic' } as const

  it('true north: the bearing as typed', () => {
    expect(bearingToTrue(306.5, KAMLOOPS, T, DATE)).toBe(306.5)
  })

  it('magnetic north adds the WMM declination at the start point (east is positive)', () => {
    const d = declinationDeg(KAMLOOPS[1], KAMLOOPS[0], DATE)
    // The BC Interior is roughly 14–16° east in 2026.
    expect(d).toBeGreaterThan(13)
    expect(d).toBeLessThan(17)
    expect(bearingToTrue(0, KAMLOOPS, M, DATE)).toBeCloseTo(d, 10)
    expect(bearingToTrue(350, KAMLOOPS, M, DATE)).toBeCloseTo((350 + d) % 360, 10)
  })

  it('a magnetic bearing shoots a different line from the same number true', () => {
    const d = declinationDeg(KAMLOOPS[1], KAMLOOPS[0], DATE)
    const mag = destination(KAMLOOPS, bearingToTrue(90, KAMLOOPS, M, DATE), 1000)
    const tru = destination(KAMLOOPS, bearingToTrue(90, KAMLOOPS, T, DATE), 1000)
    expect(gap(mag, destination(KAMLOOPS, 90 + d, 1000))).toBeLessThan(1e-6)
    // Two 1 km lines d degrees apart end 2·1000·sin(d/2) apart.
    expect(gap(mag, tru)).toBeCloseTo(2000 * Math.sin(((d / 2) * Math.PI) / 180), 1)
  })

  it('reads back as typed through the bearing display', () => {
    for (const s of [T, M, MIL_T, MIL_M]) {
      const typed = s.angle === 'mil' ? 1234 : 45
      const trueDeg = bearingToTrue(typed, KAMLOOPS, s, DATE)
      const shown = formatBearing(trueDeg, KAMLOOPS, { ...DEFAULT_UNIT_SETTINGS, ...s }, DATE)
      expect(shown).toBe(s.angle === 'mil' ? `1234 mil ${s.north === 'magnetic' ? 'M' : 'T'}` : `45°${s.north === 'magnetic' ? 'M' : 'T'}`)
    }
  })

  it('mils: 6400 to the circle', () => {
    expect(bearingToTrue(1600, KAMLOOPS, MIL_T)).toBe(90)
    expect(bearingToTrue(3200, KAMLOOPS, MIL_T)).toBe(180)
    expect(bearingToTrue(4800, KAMLOOPS, MIL_T)).toBe(270)
    expect(bearingToTrue(17.7778, KAMLOOPS, MIL_T)).toBeCloseTo(1, 4)
    const byMils = destination(KAMLOOPS, bearingToTrue(1600, KAMLOOPS, MIL_T), 500)
    expect(byMils).toEqual(destination(KAMLOOPS, 90, 500))
    const d = declinationDeg(KAMLOOPS[1], KAMLOOPS[0], DATE)
    expect(bearingToTrue(1600, KAMLOOPS, MIL_M, DATE)).toBeCloseTo(90 + d, 10)
  })

  it('labels the input with the unit and north reference', () => {
    expect(bearingUnitLabel(T)).toBe('°T')
    expect(bearingUnitLabel(M)).toBe('°M')
    expect(bearingUnitLabel(MIL_T)).toBe('mil T')
    expect(bearingUnitLabel(MIL_M)).toBe('mil M')
  })

  it('parses degrees, DMS and quadrant bearings', () => {
    expect(parseBearing('306.5', 'deg')).toBe(306.5)
    expect(parseBearing('306°', 'deg')).toBe(306)
    expect(parseBearing(` 306°52'05.37"`, 'deg')).toBeCloseTo(dms(306, 52, 5.37), 10)
    expect(parseBearing('306 52 05.37', 'deg')).toBeCloseTo(dms(306, 52, 5.37), 10)
    expect(parseBearing('45,5', 'deg')).toBe(45.5)
    expect(parseBearing('360', 'deg')).toBe(0)
    expect(parseBearing('N54W', 'deg')).toBe(306)
    expect(parseBearing('n 54 w', 'deg')).toBe(306)
    expect(parseBearing('N30E', 'deg')).toBe(30)
    expect(parseBearing('S30.5E', 'deg')).toBe(149.5)
    expect(parseBearing('S10W', 'deg')).toBe(190)
    for (const bad of ['', 'abc', '361', '-5', 'N95E', '45 60', '45.5 30', 'N45N']) {
      expect(parseBearing(bad, 'deg')).toBeNull()
    }
  })

  it('parses mils', () => {
    expect(parseBearing('1600', 'mil')).toBe(1600)
    expect(parseBearing('5440 mils', 'mil')).toBe(5440)
    expect(parseBearing('6400', 'mil')).toBe(0)
    expect(parseBearing('6401', 'mil')).toBeNull()
    expect(parseBearing('N45E', 'mil')).toBeNull()
  })
})

describe('typed distances', () => {
  it('offers the distance unit first, chains included', () => {
    expect(distanceInputUnits({ distance: 'metric' }).map((u) => u.label)).toEqual(['m', 'km'])
    expect(distanceInputUnits({ distance: 'imperial' })[0]).toEqual({ label: 'ft', meters: M_PER_FT })
    expect(distanceInputUnits({ distance: 'nautical' })[0]).toEqual({ label: 'NM', meters: 1852 })
    expect(distanceInputUnits({ distance: 'chains' })[0]).toEqual({ label: 'ch', meters: M_PER_CHAIN })
  })

  it('a leg in chains is 66 ft per chain on the ground', () => {
    const ch = distanceInputUnits({ distance: 'chains' })[0]
    const end = destination(KAMLOOPS, 90, 10 * ch.meters)
    expect(gap(KAMLOOPS, end)).toBeCloseTo(201.168, 6)
    expect(10 * ch.meters).toBeCloseTo(660 * M_PER_FT, 9)
  })

  it('parses lengths, comma decimals included', () => {
    expect(parseLength('250')).toBe(250)
    expect(parseLength('12.5')).toBe(12.5)
    expect(parseLength('12,5')).toBe(12.5)
    expect(parseLength('1,234.5')).toBe(1234.5)
    expect(parseLength('.5')).toBe(0.5)
    for (const bad of ['', '0', '-3', 'abc', '1.2.3']) expect(parseLength(bad)).toBeNull()
  })
})
