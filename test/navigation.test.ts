/**
 * Navigation maths (src/lib/navigation.ts, with geo.ts bearings, measure.ts
 * distances and cogo.ts projection): bearing and distance to a target,
 * projecting a point and navigating back to it, route length, route
 * advance on arrival (approach and arrival alerts once each, chained
 * close points, Skip/Back, auto-advance off), ground speed and ETA,
 * following a line, and reading a saved session back.
 */
import { describe, expect, it } from 'vitest'
import type { Position } from 'geojson'
import { destination } from '../src/lib/cogo'
import { bearingDeg } from '../src/lib/geo'
import { distanceM } from '../src/lib/geodesic'
import {
  advanceSession,
  etaSeconds,
  groundSpeed,
  legLengths,
  legTo,
  newSession,
  nextWaypointName,
  remainingM,
  routeLengthM,
  sanitizeSession,
  sanitizeWaypoints,
  stepSession,
  thinPath,
  waypointPosition,
  waypointPositions,
  waypointsFromLine,
  type NavEvent,
  type NavOptions,
  type NavSession,
  type Waypoint,
} from '../src/lib/navigation'
import type { UserFeature } from '../src/lib/features'

/** Degrees, minutes, seconds; the sign of `d` applies to the whole angle. */
const dms = (d: number, m: number, s = 0) => (d < 0 ? -1 : 1) * (Math.abs(d) + m / 60 + s / 3600)

// BC Interior.
const START: Position = [-120.3273, 50.6745]
const OPTS: NavOptions = { arrivalRadiusM: 20, approachM: 100, autoAdvance: true }

let n = 0
const id = () => `wp${++n}`
const wp = (name: string, position: Position, featureId?: string): Waypoint => ({
  id: id(),
  name,
  position,
  ...(featureId ? { featureId } : {}),
})

/** `m` metres east of START (west when negative). */
const east = (m: number): Position => (m >= 0 ? destination(START, 90, m) : destination(START, 270, -m))

/** A route east from START: points every 200 m. */
function eastRoute(count: number, spacing = 200): Waypoint[] {
  return Array.from({ length: count }, (_, i) => wp(`P${i + 1}`, destination(START, 90, spacing * i)))
}

/** Walk the session along fixes; collect every event. */
function walk(session: NavSession, fixes: Position[], opts: NavOptions = OPTS) {
  const points = session.waypoints.map((w) => w.position)
  const events: NavEvent[] = []
  let s = session
  for (const f of fixes) {
    const r = advanceSession(s, f, points, opts)
    s = r.session
    events.push(...r.events)
  }
  return { session: s, events }
}

describe('bearing and distance to a target', () => {
  // Expected values below are WGS84 geodesics: Karney's algorithm (GeographicLib,
  // as geodesic.ts computes it), checked against Vincenty's inverse, which agrees
  // to 0.1 mm and 1e-8°. The two sources work these examples on a sphere.
  it('the Aviation Formulary example (LAX → JFK), on WGS84', () => {
    // LAX 33°57′N 118°24′W, JFK 40°38′N 73°47′W. The Formulary's sphere gives
    // 0.623585 rad (≈ 3,973 km) at 66°; on WGS84: 3,981,600.617 m at 65.93354897°.
    const lax: Position = [dms(-118, 24), dms(33, 57)]
    const jfk: Position = [dms(-73, 47), dms(40, 38)]
    const { distanceM: d, bearing } = legTo(lax, jfk)
    expect(Math.abs(d - 3981600.617)).toBeLessThan(0.01)
    expect(Math.abs(bearing - 65.93354897)).toBeLessThan(1e-6)
  })

  it('the Movable Type example, on WGS84', () => {
    // 53°19′14″N 001°43′47″W → 53°11′18″N 000°08′00″E. Movable Type's sphere
    // gives 124.8 km at 096°01′18″; on WGS84: 125,207.820 m at 96.0020842°.
    const a: Position = [dms(-1, 43, 47), dms(53, 19, 14)]
    const b: Position = [dms(0, 8, 0), dms(53, 11, 18)]
    const { distanceM: d, bearing } = legTo(a, b)
    expect(Math.abs(d - 125207.82)).toBeLessThan(0.01)
    expect(Math.abs(bearing - 96.0020842)).toBeLessThan(1e-6)
  })

  it('reads the cardinal directions', () => {
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 9)
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 9)
    expect(bearingDeg([0, 1], [0, 0])).toBeCloseTo(180, 9)
    expect(bearingDeg([1, 0], [0, 0])).toBeCloseTo(270, 9)
  })

  it('one degree of latitude in BC is the WGS84 meridian arc (111,238.681 m at 50–51°N)', () => {
    expect(Math.abs(distanceM([-120, 50], [-120, 51]) - 111238.681)).toBeLessThan(0.001)
  })
})

describe('project a point, then navigate to it', () => {
  it('reads back the bearing and distance it was projected with', () => {
    for (const bearing of [0, 1, 45, 89.5, 90, 135, 180, 225, 270, 315, 359.9]) {
      for (const meters of [5, 25, 250, 1000, 12_000]) {
        const to = destination(START, bearing, meters)
        const leg = legTo(START, to)
        expect(Math.abs(leg.distanceM - meters)).toBeLessThan(1e-6 * meters + 1e-6)
        const turn = ((leg.bearing - bearing + 540) % 360) - 180
        expect(Math.abs(turn)).toBeLessThan(1e-6)
      }
    }
  })

  it('from a placemark: the line from the placemark is the typed one, whatever your position', () => {
    const placemark: Position = [-120.5, 50.8]
    const to = destination(placemark, 300, 750)
    expect(legTo(placemark, to).distanceM).toBeCloseTo(750, 6)
    // From you somewhere else the readout is your own leg, not the projection's.
    const you = destination(placemark, 180, 500)
    expect(legTo(you, to).distanceM).toBeGreaterThan(750)
  })
})

describe('route lengths', () => {
  it('sums the legs and counts the rest of the route from where you are', () => {
    const route = eastRoute(4)
    const pts = route.map((w) => w.position)
    const legs = legLengths(pts)
    expect(legs).toHaveLength(3)
    for (const l of legs) expect(l).toBeCloseTo(200, 6)
    expect(routeLengthM(pts)).toBeCloseTo(600, 5)
    // Standing 50 m short of point 2 (index 1): 50 m, then two legs.
    const you = destination(START, 90, 150)
    expect(remainingM(you, pts, 1)).toBeCloseTo(450, 5)
    expect(remainingM(you, pts, 4)).toBe(0)
  })
})

describe('advancing a route', () => {
  it('approach once, arrive, go on to the next, finish at the last', () => {
    const route = eastRoute(3)
    // Walk from 300 m west of P1 to past P3, every 5 m.
    const fixes = Array.from({ length: 190 }, (_, i) => east(-300 + i * 5))
    const { session, events } = walk(newSession(route, 'Route'), fixes)
    expect(events.map((e) => `${e.type}:${e.name}`)).toEqual([
      'approach:P1',
      'arrive:P1',
      'approach:P2',
      'arrive:P2',
      'approach:P3',
      'finish:P3',
    ])
    expect(events[0].distanceM).toBeLessThanOrEqual(100)
    expect(events[1].distanceM).toBeLessThanOrEqual(20)
    expect(events[1].nextName).toBe('P2')
    expect(session.finished).toBe(true)
    expect(session.index).toBe(2)
  })

  it("doesn't repeat alerts when the GPS wobbles at the edge of the radius", () => {
    const route = [wp('Helipad', START), wp('Spot', destination(START, 0, 500))]
    // In and out of the approach ring, then of the arrival ring, at P2.
    const target = route[1].position
    const wobble = [130, 95, 105, 98, 101, 60, 19, 21, 18, 25, 15].map((d) => destination(target, 180, d))
    const s0 = { ...newSession(route), index: 1 }
    const { events, session } = walk(s0, wobble)
    expect(events.map((e) => e.type)).toEqual(['approach', 'finish'])
    // Finished: nothing more, wherever you go.
    const after = walk(session, [target, destination(target, 90, 300), target])
    expect(after.events).toEqual([])
  })

  it('passes close waypoints in one go when you are within each radius', () => {
    // Two flags 10 m apart, a third 400 m on.
    const route = [wp('A', START), wp('B', destination(START, 90, 10)), wp('C', destination(START, 90, 400))]
    const { events, session } = walk(newSession(route), [destination(START, 90, 5)])
    expect(events.map((e) => `${e.type}:${e.name}`)).toEqual(['arrive:A', 'arrive:B'])
    expect(session.index).toBe(2)
  })

  it('a loop back to the start only ends when you get back', () => {
    const a = START
    const b = destination(START, 0, 300)
    const route = [wp('Start', a), wp('Top', b), wp('Back', a)]
    const first = walk(newSession(route), [a])
    expect(first.events.map((e) => e.name)).toEqual(['Start'])
    expect(first.session.finished).toBe(false)
    expect(first.session.index).toBe(1)
  })

  it('with auto-advance off, waits on the reached point until Skip', () => {
    const route = eastRoute(3)
    const opts = { ...OPTS, autoAdvance: false }
    const p1 = route[0].position
    const { events, session } = walk(newSession(route), [p1, p1, destination(p1, 90, 5)], opts)
    expect(events.map((e) => e.type)).toEqual(['arrive'])
    expect(events[0].nextName).toBeUndefined()
    expect(session.index).toBe(0)
    expect(session.alerted).toBe('arrive')
    const skipped = stepSession(session, 1)
    expect(skipped.index).toBe(1)
    expect(skipped.alerted).toBe('none')
  })

  it('approach alert off (0) gives only arrivals', () => {
    const route = eastRoute(2)
    const fixes = Array.from({ length: 70 }, (_, i) => east(-100 + i * 5))
    const { events } = walk(newSession(route), fixes, { ...OPTS, approachM: 0 })
    expect(events.map((e) => e.type)).toEqual(['arrive', 'finish'])
  })

  it('Skip and Back stay inside the route; Skip past the end finishes', () => {
    const s = newSession(eastRoute(3))
    expect(stepSession(s, -1).index).toBe(0)
    const last = stepSession(stepSession(s, 1), 1)
    expect(last.index).toBe(2)
    expect(last.finished).toBe(false)
    const done = stepSession(last, 1)
    expect(done.finished).toBe(true)
    const back = stepSession(done, -1)
    expect(back.finished).toBe(false)
    expect(back.index).toBe(1)
  })

  it('follows a placemark that was moved', () => {
    const pin: UserFeature = {
      id: 'pin-1',
      kind: 'pin',
      name: 'Drop point',
      notes: '',
      color: '#f00',
      coordinates: destination(START, 45, 300),
      layerId: 'l',
      createdAt: 0,
      updatedAt: 0,
    }
    const w = wp('Drop point', START, 'pin-1')
    expect(waypointPosition(w, [pin])).toEqual(pin.coordinates)
    // Deleted: the waypoint keeps where it was when added.
    expect(waypointPosition(w, [])).toEqual(START)
    const s = newSession([w])
    const live = advanceSession(s, pin.coordinates as Position, waypointPositions(s.waypoints, [pin]), OPTS)
    expect(live.events.map((e) => e.type)).toEqual(['finish'])
  })
})

describe('ground speed and ETA', () => {
  const t0 = Date.UTC(2026, 7, 1, 18, 0, 0)

  it('uses the GPS speed when it reports one', () => {
    const fixes = [1.2, 1.4, 1.3, 1.5, 1.6].map((speed, i) => ({ position: START, time: t0 + i * 1000, speed }))
    expect(groundSpeed(fixes)).toBeCloseTo(1.4, 9)
  })

  it('without GPS speed: progress over the window, not wobble', () => {
    // Walking east at 1.25 m/s.
    const walking = [0, 1, 2, 3, 4].map((i) => ({
      position: destination(START, 90, 1.25 * i),
      time: t0 + i * 1000,
      speed: null,
    }))
    expect(groundSpeed(walking)).toBeCloseTo(1.25, 6)
    // Standing still with 3 m of wobble each fix: not moving.
    const wobble = [0, 3, 0, 3, 0].map((d, i) => ({
      position: destination(START, i % 2 ? 90 : 270, d),
      time: t0 + i * 1000,
      speed: null,
    }))
    expect(groundSpeed(wobble)).toBeNull()
  })

  it('needs a few seconds of fixes', () => {
    expect(groundSpeed([])).toBeNull()
    expect(groundSpeed([{ position: START, time: t0, speed: null }])).toBeNull()
  })

  it('ETA is distance over speed, none when standing still', () => {
    expect(etaSeconds(1000, 1.25)).toBeCloseTo(800, 9)
    expect(etaSeconds(1000, 0.1)).toBeNull()
    expect(etaSeconds(1000, null)).toBeNull()
  })
})

describe('following a line', () => {
  it('thins a long track to at most the cap, keeping both ends', () => {
    const track = Array.from({ length: 5000 }, (_, i) => destination(START, 60, i * 2))
    const thin = thinPath(track, 10, 200)
    expect(thin.length).toBeLessThanOrEqual(200)
    expect(thin[0]).toEqual(track[0])
    expect(thin[thin.length - 1]).toEqual(track[track.length - 1])
    for (let i = 1; i < thin.length - 1; i++) expect(distanceM(thin[i - 1], thin[i])).toBeGreaterThanOrEqual(10)
  })

  it('keeps a short route line as it is', () => {
    const line = eastRoute(4).map((w) => w.position)
    expect(thinPath(line)).toEqual(line)
  })

  it('names the points after the line', () => {
    const line: UserFeature = {
      id: 'line-1',
      kind: 'line',
      name: 'Handline',
      notes: '',
      color: '#f00',
      coordinates: eastRoute(3).map((w) => w.position),
      layerId: 'l',
      createdAt: 0,
      updatedAt: 0,
    }
    const wps = waypointsFromLine(line, id)
    expect(wps.map((w) => w.name)).toEqual(['Handline 1', 'Handline 2', 'Handline 3'])
  })

  it('numbers new points past the ones taken', () => {
    expect(nextWaypointName([])).toBe('WP 1')
    expect(nextWaypointName([wp('WP 2', START)])).toBe('WP 3')
  })
})

describe('saved sessions', () => {
  it('round-trips and drops anything malformed', () => {
    const s = { ...newSession(eastRoute(3), 'Route', 123), index: 1, alerted: 'approach' as const }
    expect(sanitizeSession(JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(sanitizeSession(null)).toBeNull()
    expect(sanitizeSession({ waypoints: [] })).toBeNull()
    const bad = sanitizeSession({
      waypoints: [{ id: 'a', name: 'ok', position: [-120, 50] }, { id: 'b', position: [-120, 95] }, 'x'],
      index: 7,
      alerted: 'loud',
    })
    expect(bad?.waypoints.map((w) => w.id)).toEqual(['a'])
    expect(bad?.index).toBe(0)
    expect(bad?.alerted).toBe('none')
    expect(sanitizeWaypoints('nope')).toEqual([])
  })
})
