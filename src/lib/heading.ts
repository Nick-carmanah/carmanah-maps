import type { Position } from 'geojson'
import { norm360 } from './cogo'
import { azimuthDeg, distanceM } from './geodesic'

/**
 * Heading maths for the compass button, course-up and the heading cone.
 * Everything here is pure, so the tests run it anywhere; the live sensor
 * plumbing is in compass.ts.
 *
 * Which way is "heading"? The way the top of the screen points: what you
 * face when you hold the phone flat in front of you, or up like a camera.
 * Phones measure it from MAGNETIC north (iOS: CLHeading.magneticHeading
 * behind webkitCompassHeading; Android: the rotation-vector sensor behind
 * deviceorientationabsolute), so it's turned to true north with the
 * offline WMM2025 declination before the map uses it. GPS course over
 * ground is already true.
 */

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Signed smallest turn from a to b, degrees (−180 < d ≤ 180). */
export function angleDelta(a: number, b: number): number {
  const d = norm360(b - a)
  return d > 180 ? d - 360 : d
}

/**
 * Heading of the top of the screen, degrees clockwise from the sensor's
 * north (magnetic), from a W3C DeviceOrientation reading in the Earth
 * frame (`deviceorientationabsolute`: alpha about Z, then beta about X,
 * then gamma about Y). `screenAngle` is how far the screen is turned
 * anticlockwise from the phone's natural orientation (screen.orientation
 * .angle: 0 portrait, 90 or 270 landscape).
 *
 * Tilt-compensated the way a person means it: the phone is pitched level
 * about the screen's own left–right axis, and the heading is where the
 * screen's up then points. So it's exact flat on a map board (rolled or
 * not), upright in front of you like a camera, and anywhere in between
 * when only pitched; in landscape too. Held on its edge with the screen's
 * up level (portrait rotation lock in a landscape hold), it goes by the
 * way the back of the phone faces. Null only if nothing gives a direction.
 */
export function screenHeadingFromOrientation(
  alpha: number,
  beta: number,
  gamma: number,
  screenAngle = 0,
): number | null {
  const [sa, ca] = [Math.sin(rad(alpha)), Math.cos(rad(alpha))]
  const [sb, cb] = [Math.sin(rad(beta)), Math.cos(rad(beta))]
  const [sg, cg] = [Math.sin(rad(gamma)), Math.cos(rad(gamma))]
  const [ss, cs] = [Math.sin(rad(screenAngle)), Math.cos(rad(screenAngle))]
  // The phone's axes in the Earth frame (east, north, up), R = Rz(α)·Rx(β)·Ry(γ).
  const x = [ca * cg - sa * sb * sg, sa * cg + ca * sb * sg, -cb * sg]
  const y = [-sa * cb, ca * cb, sb]
  const z = [ca * sg + sa * sb * cg, sa * sg - ca * sb * cg, cb * cg]
  // The screen's up: the phone's top (Y) turned by the screen angle towards X.
  const u = [cs * y[0] + ss * x[0], cs * y[1] + ss * x[1], cs * y[2] + ss * x[2]]
  // Pitched level about the screen's left–right axis, up points along
  // z_up·u − u_up·z (horizontal part).
  let e = z[2] * u[0] - u[2] * z[0]
  let n = z[2] * u[1] - u[2] * z[1]
  if (Math.hypot(e, n) < 0.2) {
    if (Math.hypot(z[0], z[1]) < 0.5) return null
    e = -z[0]
    n = -z[1]
  }
  return norm360(deg(Math.atan2(e, n)))
}

/**
 * iOS: webkitCompassHeading is the heading of the top of the PHONE from
 * magnetic north; the screen's up is turned `screenAngle` further when
 * the phone is held in landscape.
 */
export function screenHeadingFromIos(webkitCompassHeading: number, screenAngle = 0): number {
  return norm360(webkitCompassHeading + screenAngle)
}

/** Magnetic heading → true, with the declination (east positive). */
export function magneticToTrue(magneticDeg: number, declinationDeg: number): number {
  return norm360(magneticDeg + declinationDeg)
}

/**
 * Exponential smoothing on the circle (359° → 1° is a 2° turn, not 358°).
 * `k` 0–1: how far to move towards the new reading.
 */
export function smoothHeading(previous: number | null, next: number, k: number): number {
  if (previous == null) return norm360(next)
  return norm360(previous + Math.max(0, Math.min(1, k)) * angleDelta(previous, next))
}

/** Smoothing factor for readings `dtMs` apart with time constant `tauMs`. */
export function smoothingFactor(dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return 0
  return 1 - Math.exp(-dtMs / Math.max(1, tauMs))
}

export interface HeadingReading {
  /** Degrees true. */
  deg: number
  /** When it was read, ms. */
  time: number
}

export interface CourseReading extends HeadingReading {
  /** Ground speed, m/s. */
  speed: number
}

/** Slower than this (m/s, ~2.5 km/h) the GPS course is mostly noise. */
export const MIN_COURSE_SPEED_MPS = 0.7
/** Faster than this (m/s, ~18 km/h: in a truck or a helicopter) the GPS
 * course wins over the compass, which the vehicle's metal throws off. */
export const VEHICLE_SPEED_MPS = 5
/** A compass reading older than this is stale (the sensor stopped). */
export const COMPASS_STALE_MS = 2000
/** A GPS course older than this is stale (fixes stopped or you stopped). */
export const COURSE_STALE_MS = 10_000

export type HeadingSource = 'compass' | 'gps'

/**
 * The heading to show: the compass while it's reporting; otherwise the
 * GPS course over ground while you're moving. In a vehicle the course
 * wins. Null when neither says anything.
 */
export function chooseHeading(
  compass: HeadingReading | null,
  course: CourseReading | null,
  now: number,
): { deg: number; source: HeadingSource } | null {
  const compassOk = compass != null && now - compass.time <= COMPASS_STALE_MS
  const courseOk =
    course != null && now - course.time <= COURSE_STALE_MS && course.speed >= MIN_COURSE_SPEED_MPS
  if (courseOk && (!compassOk || course.speed >= VEHICLE_SPEED_MPS)) {
    return { deg: norm360(course.deg), source: 'gps' }
  }
  if (compassOk) return { deg: norm360(compass.deg), source: 'compass' }
  return null
}

export interface CourseFix {
  position: Position
  time: number
  /** Horizontal accuracy, metres. */
  accuracy: number | null
  /** As the GPS reports them (null or negative = unknown). */
  speed: number | null
  heading: number | null
}

/**
 * Course over ground from a fix: the GPS's own course when it gives one
 * while moving, else the bearing from the previous fix when you've gone
 * further than the fixes' error. Null when standing still.
 */
export function courseFromFixes(previous: CourseFix | null, current: CourseFix): CourseReading | null {
  const speed = current.speed != null && current.speed >= 0 ? current.speed : null
  if (current.heading != null && current.heading >= 0 && speed != null && speed >= MIN_COURSE_SPEED_MPS) {
    return { deg: norm360(current.heading), time: current.time, speed }
  }
  if (!previous) return null
  const dt = (current.time - previous.time) / 1000
  if (!(dt > 0)) return null
  const moved = distanceM(previous.position, current.position)
  const noise = Math.max(5, ((previous.accuracy ?? 10) + (current.accuracy ?? 10)) / 2)
  if (moved < noise) return null
  const derived = speed ?? moved / dt
  if (derived < MIN_COURSE_SPEED_MPS) return null
  return { deg: azimuthDeg(previous.position, current.position), time: current.time, speed: derived }
}

// ---- The compass button ----

export type MapOrientation = 'north' | 'course'

/**
 * One tap on the compass button, like Avenza's: course-up → north-up;
 * north-up but turned or tilted → straighten to north; north-up and
 * straight → course-up.
 */
export function compassTap(
  mode: MapOrientation,
  mapBearing: number,
  mapPitch: number,
): { mode: MapOrientation; resetNorth: boolean } {
  if (mode === 'course') return { mode: 'north', resetNorth: true }
  if (Math.abs(angleDelta(0, mapBearing)) > 0.5 || mapPitch > 0.5) {
    return { mode: 'north', resetNorth: true }
  }
  return { mode: 'course', resetNorth: false }
}

/** Half-width of the heading cone, degrees: wider when the compass is unsure. */
export function coneHalfAngle(accuracyDeg: number | null, source: HeadingSource): number {
  if (source === 'gps') return 18
  if (accuracyDeg == null || accuracyDeg < 0) return 30
  return Math.max(15, Math.min(60, accuracyDeg))
}
