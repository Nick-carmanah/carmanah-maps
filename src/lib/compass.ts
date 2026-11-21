import type { Position } from 'geojson'
import {
  chooseHeading,
  COMPASS_STALE_MS,
  courseFromFixes,
  magneticToTrue,
  screenHeadingFromIos,
  screenHeadingFromOrientation,
  smoothHeading,
  smoothingFactor,
  type CourseFix,
  type CourseReading,
  type HeadingReading,
  type HeadingSource,
  type MapOrientation,
} from './heading'
import { declinationDeg } from './magnetic'
import { lastFix, subscribeFix } from './position'

/**
 * The live heading the map shows: the phone's compass (DeviceOrientation),
 * else the GPS course over ground while moving (see heading.ts for which
 * wins when). One shared listener, started by the first subscriber and
 * stopped by the last, like the GPS watch in position.ts, so the compass
 * button, the heading cone and navigation share it.
 *
 * iOS (Safari and the crew app's WebView) only gives compass readings
 * after DeviceOrientationEvent.requestPermission(), which must be called
 * from a tap: the compass button and "Start" in navigation do that
 * (requestCompass). Android needs no permission. Without a compass (a
 * laptop, a refused prompt) the heading is the GPS course while you move.
 *
 * In dev, window.__headingFeed(deg, accuracy?) injects a compass reading
 * (magnetic degrees, like a phone) for desktop testing.
 */

export type CompassStatus =
  /** Not listening (no subscribers). */
  | 'off'
  /** iOS: needs a tap on the compass button before it reads anything. */
  | 'needs-permission'
  /** Listening; readings arriving. */
  | 'on'
  /** Listening, but nothing has come in (no compass on this device). */
  | 'unavailable'
  /** The person said no to motion and orientation access. */
  | 'denied'

export interface HeadingState {
  /** Degrees true, or null when unknown. */
  heading: number | null
  source: HeadingSource | null
  /** ± degrees (iOS compass), null when unknown. */
  accuracy: number | null
  compass: CompassStatus
}

type Listener = (state: HeadingState) => void

const listeners = new Set<Listener>()
let state: HeadingState = { heading: null, source: null, accuracy: null, compass: 'off' }

// Sensor readings, degrees true.
let compassReading: HeadingReading | null = null
let compassAccuracy: number | null = null
let courseReading: CourseReading | null = null
let previousFix: CourseFix | null = null
let smoothed: number | null = null
let smoothedAt = 0
let permission: 'unknown' | 'granted' | 'denied' = 'unknown'
let listening: 'absolute' | 'relative' | null = null
let unavailableTimer: ReturnType<typeof setTimeout> | undefined
let stopFix: (() => void) | null = null
let lastEmit = 0
let emitTimer: ReturnType<typeof setTimeout> | undefined

/** Where declination is taken when there's no GPS fix (the map's centre). */
let fallbackPlace: Position | null = null
let declination: { at: Position; deg: number } | null = null

/** Smoothing time constant for compass readings, ms (steady, but keeps up with a turn). */
const COMPASS_TAU_MS = 180
/** Emit at most this often, ms. */
const EMIT_EVERY_MS = 60

const needsPermission = (): boolean =>
  typeof DeviceOrientationEvent !== 'undefined' &&
  typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === 'function'

function screenAngle(): number {
  if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
    return screen.orientation.angle
  }
  const legacy = (window as unknown as { orientation?: number }).orientation
  return typeof legacy === 'number' ? legacy : 0
}

/** Declination where you are (or the map centre), cached until you move ~5 km. */
function declinationHere(): number {
  const fix = lastFix()
  const at: Position | null = fix ? [fix.lng, fix.lat] : fallbackPlace
  if (!at) return 0
  if (!declination || Math.abs(declination.at[0] - at[0]) > 0.05 || Math.abs(declination.at[1] - at[1]) > 0.05) {
    declination = { at, deg: declinationDeg(at[1], at[0]) }
  }
  return declination.deg
}

function compute(now = Date.now()): HeadingState {
  const chosen = chooseHeading(compassReading, courseReading, now)
  let compass: CompassStatus = state.compass
  if (compassReading && now - compassReading.time <= COMPASS_STALE_MS) compass = 'on'
  return {
    heading: chosen ? chosen.deg : null,
    source: chosen ? chosen.source : null,
    accuracy: chosen?.source === 'compass' ? compassAccuracy : null,
    compass,
  }
}

function emit(force = false) {
  const now = Date.now()
  if (!force && now - lastEmit < EMIT_EVERY_MS) {
    if (!emitTimer) emitTimer = setTimeout(() => {
      emitTimer = undefined
      emit(true)
    }, EMIT_EVERY_MS)
    return
  }
  lastEmit = now
  const next = compute(now)
  const same =
    next.source === state.source &&
    next.compass === state.compass &&
    next.accuracy === state.accuracy &&
    (next.heading === state.heading ||
      (next.heading != null && state.heading != null && Math.abs(next.heading - state.heading) < 0.2))
  state = next
  if (same) return
  for (const l of [...listeners]) l(state)
}

function setStatus(compass: CompassStatus) {
  if (state.compass === compass) return
  state = { ...state, compass }
  for (const l of [...listeners]) l(state)
}

/** A compass reading, degrees from MAGNETIC north, for the screen's up. */
function onMagnetic(magnetic: number, accuracy: number | null) {
  const now = Date.now()
  const trueDeg = magneticToTrue(magnetic, declinationHere())
  smoothed = smoothHeading(smoothed, trueDeg, smoothed == null ? 1 : smoothingFactor(now - smoothedAt, COMPASS_TAU_MS))
  smoothedAt = now
  compassReading = { deg: smoothed, time: now }
  compassAccuracy = accuracy
  clearTimeout(unavailableTimer)
  if (state.compass !== 'on') state = { ...state, compass: 'on' }
  emit()
}

function onOrientation(e: DeviceOrientationEvent) {
  const ios = (e as unknown as { webkitCompassHeading?: number; webkitCompassAccuracy?: number })
  if (typeof ios.webkitCompassHeading === 'number' && ios.webkitCompassHeading >= 0) {
    const acc = typeof ios.webkitCompassAccuracy === 'number' && ios.webkitCompassAccuracy >= 0 ? ios.webkitCompassAccuracy : null
    onMagnetic(screenHeadingFromIos(ios.webkitCompassHeading, screenAngle()), acc)
    return
  }
  // A plain 'deviceorientation' is only usable when it says it's absolute.
  if (e.type === 'deviceorientation' && !e.absolute) return
  if (e.alpha == null) return
  const h = screenHeadingFromOrientation(e.alpha, e.beta ?? 0, e.gamma ?? 0, screenAngle())
  if (h != null) onMagnetic(h, null)
}

function startSensor() {
  if (listening || typeof window === 'undefined') return
  if (needsPermission() && permission !== 'granted') {
    setStatus(permission === 'denied' ? 'denied' : 'needs-permission')
    return
  }
  if (typeof DeviceOrientationEvent === 'undefined') {
    setStatus('unavailable')
    return
  }
  listening = 'ondeviceorientationabsolute' in window ? 'absolute' : 'relative'
  window.addEventListener(listening === 'absolute' ? 'deviceorientationabsolute' : 'deviceorientation', onOrientation as EventListener)
  // No reading within a few seconds: no compass here (a laptop).
  clearTimeout(unavailableTimer)
  unavailableTimer = setTimeout(() => {
    if (!compassReading) setStatus('unavailable')
  }, 3000)
}

function stopSensor() {
  if (!listening) return
  window.removeEventListener(listening === 'absolute' ? 'deviceorientationabsolute' : 'deviceorientation', onOrientation as EventListener)
  listening = null
  clearTimeout(unavailableTimer)
}

function start() {
  startSensor()
  stopFix = subscribeFix((fix) => {
    const cur: CourseFix = {
      position: [fix.lng, fix.lat],
      time: fix.time,
      accuracy: fix.accuracy,
      speed: fix.speed,
      heading: fix.heading,
    }
    const course = courseFromFixes(previousFix, cur)
    if (course) courseReading = course
    // Keep the last fix the course was measured from until you've moved.
    if (course || !previousFix) previousFix = cur
    emit()
  })
  if (state.compass === 'off') setStatus(listening ? 'on' : state.compass)
  emit(true)
}

function stop() {
  stopSensor()
  stopFix?.()
  stopFix = null
  clearTimeout(emitTimer)
  emitTimer = undefined
  compassReading = null
  courseReading = null
  previousFix = null
  smoothed = null
  state = { heading: null, source: null, accuracy: null, compass: 'off' }
}

/** Every heading change while subscribed (starts the compass and the GPS). */
export function subscribeHeading(listener: Listener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) start()
  listener(state)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

export function getHeading(): HeadingState {
  return state
}

/**
 * Ask for the compass (iOS shows its "Motion & Orientation" prompt). Call
 * it straight from a tap, before any await. True when the compass may be
 * read (or needs no permission).
 */
export async function requestCompass(): Promise<boolean> {
  if (!needsPermission()) {
    startIfWanted()
    return true
  }
  if (permission === 'granted') {
    startIfWanted()
    return true
  }
  try {
    const answer = await (
      DeviceOrientationEvent as unknown as { requestPermission: () => Promise<'granted' | 'denied'> }
    ).requestPermission()
    permission = answer === 'granted' ? 'granted' : 'denied'
  } catch {
    // Not from a tap, or the WebView doesn't support asking.
    permission = 'denied'
  }
  if (permission === 'granted') startIfWanted()
  else setStatus('denied')
  return permission === 'granted'
}

function startIfWanted() {
  if (listeners.size > 0) startSensor()
}

/** Where to take declination from when there's no GPS fix yet. */
export function setDeclinationFallback(at: Position | null): void {
  fallbackPlace = at
}

// ---- Map orientation: north-up or course-up ----

let orientation: MapOrientation = 'north'
const orientationListeners = new Set<() => void>()

export function getMapOrientation(): MapOrientation {
  return orientation
}

export function setMapOrientation(mode: MapOrientation): void {
  if (orientation === mode) return
  orientation = mode
  for (const l of [...orientationListeners]) l()
}

export function subscribeMapOrientation(listener: () => void): () => void {
  orientationListeners.add(listener)
  return () => orientationListeners.delete(listener)
}

// ---- Who wants the heading cone ----

const coneWanters = new Set<string>()
const coneListeners = new Set<() => void>()

/** Navigation shows the heading cone while it runs, as course-up does. */
export function setHeadingWanted(who: string, wanted: boolean): void {
  const had = coneWanters.has(who)
  if (wanted === had) return
  if (wanted) coneWanters.add(who)
  else coneWanters.delete(who)
  for (const l of [...coneListeners]) l()
}

export function headingWanted(): boolean {
  return coneWanters.size > 0
}

export function subscribeHeadingWanted(listener: () => void): () => void {
  coneListeners.add(listener)
  return () => coneListeners.delete(listener)
}

if (import.meta.env?.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__headingFeed = (magneticDeg: number, accuracy: number | null = 10) =>
    onMagnetic(magneticDeg, accuracy)
}
