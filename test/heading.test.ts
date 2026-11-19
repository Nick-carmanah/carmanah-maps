/**
 * Compass and course-up maths (src/lib/heading.ts): the screen's heading
 * from DeviceOrientation (flat, tilted, upright, landscape) and from iOS's
 * webkitCompassHeading, magnetic → true, smoothing across north, choosing
 * compass vs GPS course, course from fixes, and the compass button's taps.
 */
import { describe, expect, it } from 'vitest'
import type { Position } from 'geojson'
import { destination } from '../src/lib/cogo'
import {
  angleDelta,
  chooseHeading,
  compassTap,
  coneHalfAngle,
  courseFromFixes,
  magneticToTrue,
  screenHeadingFromIos,
  screenHeadingFromOrientation,
  smoothHeading,
  smoothingFactor,
  VEHICLE_SPEED_MPS,
  type CourseFix,
} from '../src/lib/heading'
import { declinationDeg } from '../src/lib/magnetic'

/** Equal as headings (0 and 360 are the same). */
const sameHeading = (a: number | null, b: number, tol = 1e-6) => {
  expect(a).not.toBeNull()
  expect(Math.abs(angleDelta(a!, b))).toBeLessThan(tol)
}

describe('heading from DeviceOrientation', () => {
  it('flat, portrait: heading is 360 − alpha', () => {
    for (const alpha of [0, 10, 90, 180, 270, 359]) {
      sameHeading(screenHeadingFromOrientation(alpha, 0, 0, 0), (360 - alpha) % 360)
    }
  })

  it('holds steady from flat to upright (tilting towards you)', () => {
    for (const beta of [0, 20, 45, 70, 89, 90, 100]) {
      sameHeading(screenHeadingFromOrientation(30, beta, 0, 0), 330)
    }
  })

  it('a sideways tilt does not swing it', () => {
    for (const gamma of [-60, -30, 0, 30, 60]) {
      sameHeading(screenHeadingFromOrientation(0, 0, gamma, 0), 0)
    }
  })

  it('landscape, flat: the screen faces a quarter turn from the phone top', () => {
    // Phone turned anticlockwise (screen angle 90): its top points west
    // (alpha 90) while you, and the screen's up, face north.
    sameHeading(screenHeadingFromOrientation(90, 0, 0, 90), 0)
    sameHeading(screenHeadingFromOrientation(0, 0, 0, 90), 90)
    sameHeading(screenHeadingFromOrientation(0, 0, 0, 270), 270)
  })

  it('landscape, upright in front of you', () => {
    // Right side up, screen facing you, you facing north: alpha 90, gamma −90.
    sameHeading(screenHeadingFromOrientation(90, 0, -90, 90), 0, 1e-6)
  })

  it('pitched and tipped forward: still the way the top points', () => {
    for (const beta of [-60, -30, 30, 60]) sameHeading(screenHeadingFromOrientation(200, beta, 0, 0), 160)
  })

  it('portrait rotation lock, held in landscape: goes by the way the back faces', () => {
    // As the landscape hold above, but the screen still says portrait.
    sameHeading(screenHeadingFromOrientation(90, 0, -90, 0), 0, 1e-6)
  })
})

describe('iOS and magnetic north', () => {
  it('adds the screen angle in landscape', () => {
    sameHeading(screenHeadingFromIos(270, 90), 0)
    sameHeading(screenHeadingFromIos(45, 0), 45)
  })

  it('turns magnetic into true with the declination', () => {
    expect(magneticToTrue(100, 16)).toBeCloseTo(116, 9)
    expect(magneticToTrue(350, 16)).toBeCloseTo(6, 9)
    expect(magneticToTrue(5, -10)).toBeCloseTo(355, 9)
    // Kamloops mid-2026: about 15° east, so a compass reading 0 points ~15°T.
    const decl = declinationDeg(50.6745, -120.3273, new Date('2026-07-01T00:00:00Z'))
    expect(decl).toBeGreaterThan(14)
    expect(decl).toBeLessThan(17)
    expect(magneticToTrue(0, decl)).toBeCloseTo(decl, 9)
  })
})

describe('smoothing', () => {
  it('turns the short way across north', () => {
    expect(smoothHeading(359, 1, 0.5)).toBeCloseTo(0, 9)
    expect(smoothHeading(1, 359, 0.5)).toBeCloseTo(0, 9)
    expect(smoothHeading(null, 123, 0.1)).toBe(123)
    expect(smoothHeading(10, 20, 1)).toBeCloseTo(20, 9)
  })

  it('factor grows with the time between readings', () => {
    expect(smoothingFactor(0, 180)).toBe(0)
    expect(smoothingFactor(180, 180)).toBeCloseTo(1 - Math.exp(-1), 9)
    expect(smoothingFactor(10_000, 180)).toBeCloseTo(1, 6)
  })

  it('angleDelta is the signed smallest turn', () => {
    expect(angleDelta(350, 10)).toBeCloseTo(20, 9)
    expect(angleDelta(10, 350)).toBeCloseTo(-20, 9)
    expect(angleDelta(0, 180)).toBeCloseTo(180, 9)
  })
})

describe('compass or GPS course', () => {
  const now = 1_000_000
  const compass = { deg: 40, time: now - 100 }
  const walking = { deg: 90, time: now - 500, speed: 1.4 }

  it('the compass while it reports', () => {
    expect(chooseHeading(compass, walking, now)).toEqual({ deg: 40, source: 'compass' })
  })

  it('no compass (or a stale one): the GPS course while moving', () => {
    expect(chooseHeading(null, walking, now)).toEqual({ deg: 90, source: 'gps' })
    expect(chooseHeading({ deg: 40, time: now - 5000 }, walking, now)?.source).toBe('gps')
  })

  it('in a vehicle the course wins over the compass', () => {
    expect(chooseHeading(compass, { ...walking, speed: VEHICLE_SPEED_MPS + 1 }, now)?.source).toBe('gps')
  })

  it('nothing when standing still with no compass', () => {
    expect(chooseHeading(null, { ...walking, speed: 0.2 }, now)).toBeNull()
    expect(chooseHeading(null, { ...walking, time: now - 60_000 }, now)).toBeNull()
    expect(chooseHeading(null, null, now)).toBeNull()
  })
})

describe('course from fixes', () => {
  const at: Position = [-120.3273, 50.6745]
  const fix = (position: Position, time: number, extra: Partial<CourseFix> = {}): CourseFix => ({
    position,
    time,
    accuracy: 5,
    speed: null,
    heading: null,
    ...extra,
  })

  it("uses the GPS's own course while moving", () => {
    expect(courseFromFixes(null, fix(at, 0, { heading: 123, speed: 2 }))).toEqual({ deg: 123, time: 0, speed: 2 })
  })

  it('else the bearing between fixes once you have moved further than their error', () => {
    const next = destination(at, 200, 12)
    const c = courseFromFixes(fix(at, 0), fix(next, 8000))
    expect(c?.deg).toBeCloseTo(200, 3)
    expect(c?.speed).toBeCloseTo(1.5, 3)
  })

  it('wobble while standing still is not a course', () => {
    expect(courseFromFixes(fix(at, 0), fix(destination(at, 90, 3), 1000))).toBeNull()
    // A negative course (iOS "invalid") is ignored.
    expect(courseFromFixes(null, fix(at, 0, { heading: -1, speed: 2 }))).toBeNull()
  })
})

describe('the compass button', () => {
  it('north-up and straight → course-up; course-up → north-up', () => {
    expect(compassTap('north', 0, 0)).toEqual({ mode: 'course', resetNorth: false })
    expect(compassTap('course', 87, 0)).toEqual({ mode: 'north', resetNorth: true })
  })

  it('a turned or tilted map is straightened first', () => {
    expect(compassTap('north', 30, 0)).toEqual({ mode: 'north', resetNorth: true })
    expect(compassTap('north', 359.9, 20)).toEqual({ mode: 'north', resetNorth: true })
    expect(compassTap('north', -0.2, 0)).toEqual({ mode: 'course', resetNorth: false })
  })

  it('cone widens with compass doubt', () => {
    expect(coneHalfAngle(5, 'compass')).toBe(15)
    expect(coneHalfAngle(40, 'compass')).toBe(40)
    expect(coneHalfAngle(200, 'compass')).toBe(60)
    expect(coneHalfAngle(null, 'compass')).toBe(30)
    expect(coneHalfAngle(null, 'gps')).toBe(18)
  })
})
