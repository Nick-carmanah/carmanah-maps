/**
 * Measurements at BC latitudes through the functions the app calls (measure
 * tool, feature sheet, tracks, navigation, fire packs, My Maps, geofences,
 * "Send this area"): what the old 6,371,008.8 m sphere read, and what the
 * WGS84 ellipsoid reads, in metres, hectares and chains.
 *
 * References are independent of src/lib/geodesic.ts: closed-form radii of
 * curvature for lines along a parallel or a meridian, and BC Albers
 * (EPSG:3005, equal-area) for areas.
 */
import { describe, expect, it } from 'vitest'
import type { Position } from 'geojson'
import { fromBcAlbers, toBcAlbers } from '../src/lib/albers'
import { featureDetails, featureStat, type UserFeature } from '../src/lib/features'
import { circlePolygon, distToPolylineM } from '../src/lib/fences'
import { bearingDeg } from '../src/lib/geo'
import { azimuthDeg, distanceM } from '../src/lib/geodesic'
import { areaAt, framePointToLngLat, groundSizeM, metresPerPx, scaleDenominator } from '../src/lib/geopdf-write'
import { distanceToMapM } from '../src/lib/library/nearby'
import type { Corners } from '../src/lib/library/types'
import { haversineMeters, pathLengthMeters, ringAreaSqMeters } from '../src/lib/measure'
import { areaBbox, ringsHectares, type LonLat } from '../src/lib/packs/area'
import { segmentedLengthM } from '../src/lib/track'
import { DEFAULT_UNIT_SETTINGS, M_PER_CHAIN, formatArea, formatDistance } from '../src/lib/units'

const RAD = Math.PI / 180
const A = 6378137
const E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)

// ---- The old formulas, verbatim from src/lib/measure.ts before this change ----

const EARTH_RADIUS_M = 6371008.8
const rad = (deg: number) => (deg * Math.PI) / 180
function oldHaversineMeters(a: Position, b: Position): number {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h))
}
function oldPathLengthMeters(coords: Position[]): number {
  let total = 0
  for (let i = 1; i < coords.length; i++) total += oldHaversineMeters(coords[i - 1], coords[i])
  return total
}
function oldRingAreaSqMeters(coords: Position[]): number {
  if (coords.length < 3) return 0
  let sum = 0
  for (let i = 0; i < coords.length; i++) {
    const p1 = coords[i]
    const p2 = coords[(i + 1) % coords.length]
    sum += (rad(p2[0]) - rad(p1[0])) * (2 + Math.sin(rad(p1[1])) + Math.sin(rad(p2[1])))
  }
  return Math.abs((sum * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2)
}

// ---- Independent references ----

/** Prime vertical and meridional radii of curvature at a latitude (closed form). */
function radii(lat: number) {
  const s = Math.sin(lat * RAD)
  const w = Math.sqrt(1 - E2 * s * s)
  return { N: A / w, M: (A * (1 - E2)) / w ** 3 }
}

/** Meridian arc length between two latitudes: ∫M dφ by Simpson's rule. */
function meridianArc(lat1: number, lat2: number): number {
  const n = 1000
  const h = (lat2 - lat1) / n
  let sum = 0
  for (let i = 0; i <= n; i++) sum += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * radii(lat1 + i * h).M
  return (sum * h * RAD) / 3
}

/** Planar area in BC Albers metres (equal-area: the area on the ellipsoid). */
function albersArea(ring: Position[]): number {
  const xy = ring.map(([lon, lat]) => toBcAlbers(lat, lon))
  let sum = 0
  for (let i = 0; i < xy.length; i++) {
    const p = xy[i]
    const q = xy[(i + 1) % xy.length]
    sum += p.easting * q.northing - q.easting * p.northing
  }
  return Math.abs(sum / 2)
}

const KAMLOOPS: Position = [-120.33, 50.67]
const chains = { ...DEFAULT_UNIT_SETTINGS, distance: 'chains' as const }
const metric = { ...DEFAULT_UNIT_SETTINGS, distance: 'metric' as const }
const hectares = { ...DEFAULT_UNIT_SETTINGS, area: 'ha' as const }

/** A point `metres` east of p along its parallel (exact: N cos φ per radian). */
function eastAlongParallel([lon, lat]: Position, metres: number): Position {
  return [lon + metres / (radii(lat).N * Math.cos(lat * RAD) * RAD), lat]
}

const feature = (kind: 'line' | 'area', coordinates: Position[]): UserFeature =>
  ({ id: 'f', kind, name: '', notes: '', color: '#e11d48', coordinates, layerId: 'l' }) as UserFeature

describe('lengths: the old error and the fix', () => {
  // A 50-chain fireline (1,005.84 m) running east–west at Kamloops. On a
  // parallel this short the geodesic is shorter than the parallel arc by
  // micrometres, so the arc length is the reference.
  const LINE_M = 50 * M_PER_CHAIN
  const line = [KAMLOOPS, eastAlongParallel(KAMLOOPS, LINE_M / 2), eastAlongParallel(KAMLOOPS, LINE_M)]

  it('east–west: the sphere read 0.31% short (3.1 m per km); WGS84 reads it to the millimetre', () => {
    const old = oldPathLengthMeters(line)
    const now = pathLengthMeters(line)
    expect(LINE_M).toBeCloseTo(1005.84, 9)
    near(old, 1002.70, 0.01) // metres
    near((LINE_M - old) / LINE_M, 0.00312, 0.00001)
    near(now, LINE_M, 0.001)
    // In chains (Gunter's, 20.1168 m), as a crew reads it off the line.
    near(old / M_PER_CHAIN, 49.844, 0.001)
    near(now / M_PER_CHAIN, 50.0, 0.0001)
    expect(formatDistance(old, chains)).toBe('49.8 ch')
    expect(formatDistance(now, chains)).toBe('50.0 ch')
    expect(formatDistance(old, metric)).toBe('1.00 km')
    expect(formatDistance(now, metric)).toBe('1.01 km')
  })

  it('north–south: the sphere read 0.04% short; WGS84 matches the meridian arc', () => {
    const top: Position = [KAMLOOPS[0], 50.68]
    const arc = meridianArc(KAMLOOPS[1], 50.68)
    near(arc, 1112.42, 0.01)
    near(arc - oldHaversineMeters(KAMLOOPS, top), 0.47, 0.01)
    near(haversineMeters(KAMLOOPS, top), arc, 0.001)
  })

  it('the same numbers reach the feature sheet, tracks and navigation', () => {
    near(segmentedLengthM(line), LINE_M, 0.001) // tracks, with or without pauses
    near(segmentedLengthM(line, [1]), distanceM(line[1], line[2]), 0.001)
    expect(featureStat(feature('line', line))).toBe(formatDistance(LINE_M))
    near(haversineMeters(line[0], line[2]), LINE_M, 0.001) // navigation's distance to target
    // Navigation's bearing comes from the same geodesic: due east here sets off ~0.0055° poleward.
    expect(bearingDeg(line[0], line[2])).toBe(azimuthDeg(line[0], line[2]))
    near(bearingDeg(line[0], line[2]), 89.99450, 0.00001)
  })
})

describe('areas: the old error and the fix', () => {
  // A 1,000 ha burned area near Kamloops, drawn as 720 vertices in BC Albers
  // and scaled there to exactly 10,000,000 m² (Albers is equal-area).
  const ring: Position[] = (() => {
    const c = toBcAlbers(KAMLOOPS[1], KAMLOOPS[0])
    const xy: [number, number][] = []
    for (let i = 0; i < 720; i++) {
      const t = (i / 720) * 2 * Math.PI
      const r = 1 + 0.3 * Math.sin(3 * t) + 0.1 * Math.cos(5 * t)
      xy.push([r * Math.cos(t), r * Math.sin(t)])
    }
    let twice = 0
    for (let i = 0; i < xy.length; i++) {
      const [x1, y1] = xy[i]
      const [x2, y2] = xy[(i + 1) % xy.length]
      twice += x1 * y2 - x2 * y1
    }
    const k = Math.sqrt(1e7 / (twice / 2))
    return xy.map(([x, y]) => fromBcAlbers(c.easting + k * x, c.northing + k * y)!)
  })()

  it('the sphere read 0.35% small (3.5 ha per 1,000 ha); WGS84 matches BC Albers', () => {
    const reference = albersArea(ring)
    near(reference, 1e7, 0.01) // m²: the round trip through Albers keeps it
    const old = oldRingAreaSqMeters(ring)
    const now = ringAreaSqMeters(ring)
    near(old / 10_000, 996.46, 0.01) // hectares
    near(now, reference, 0.01) // m²
    near(now / 10_000, 1000.0, 1e-6)
    expect(formatArea(old, hectares)).toBe('996 ha')
    expect(formatArea(now, hectares)).toBe('1000 ha')
  })

  it('the feature sheet and the fire-pack size agree', () => {
    expect(featureStat(feature('area', ring))).toBe(formatArea(1e7))
    const hole = ring.map(([lon, lat]) => [KAMLOOPS[0] + (lon - KAMLOOPS[0]) / 10, KAMLOOPS[1] + (lat - KAMLOOPS[1]) / 10])
    const holed = { ...feature('area', ring), holes: [hole] }
    expect(featureStat(holed)).toBe(formatArea(1e7 - ringAreaSqMeters(hole)))
    near(ringsHectares([ring as LonLat[]]), 1000, 1e-6)
    // Perimeter in chains, the other number on the sheet.
    const perimeter = pathLengthMeters([...ring, ring[0]])
    expect(featureDetails(feature('area', ring))[1]).toBe(`perimeter ${formatDistance(perimeter)}`)
    expect(perimeter / oldPathLengthMeters([...ring, ring[0]])).toBeGreaterThan(1.001)
  })
})

describe('the other places that measure', () => {
  it('fire-pack buffer: the bounding box reaches at least the buffer, in true metres', () => {
    const fire: LonLat[] = [[-121.2, 50.1], [-121.0, 50.1], [-121.0, 50.3], [-121.2, 50.3]]
    const bufferM = 5000
    const [w, s, e, n] = areaBbox({ rings: [fire], bufferM })
    const west = distanceM([-121.2, 50.3], [w, 50.3]) // at the northern edge, where degrees are shortest
    const east = distanceM([-121.0, 50.3], [e, 50.3])
    const south = distanceM([-121.2, 50.1], [-121.2, s])
    const north = distanceM([-121.2, 50.3], [-121.2, n])
    for (const d of [west, east, south, north]) {
      expect(d).toBeGreaterThanOrEqual(bufferM - 0.01)
      expect(d).toBeLessThan(bufferM * 1.01)
    }
  })

  it('My Maps distance to a map: the geodesic distance to the nearest edge', () => {
    // A 4 km × 4 km frame 10 km east of the position; its west edge is a meridian.
    const west = eastAlongParallel(KAMLOOPS, 10_000)[0]
    const eastEdge = eastAlongParallel(KAMLOOPS, 14_000)[0]
    const frame: Corners = [
      [west, 50.69], [eastEdge, 50.69], [eastEdge, 50.65], [west, 50.65],
    ]
    let brute = Infinity
    for (let i = 0; i <= 4000; i++) brute = Math.min(brute, distanceM(KAMLOOPS, [west, 50.65 + (0.04 * i) / 4000]))
    near(distanceToMapM(frame, KAMLOOPS), brute, 0.01)
    near(brute, 10_000, 0.05)
  })

  it('geofences: the fence circle is the radius on the ground, and so is the line buffer', () => {
    const ring = circlePolygon(KAMLOOPS, 500)
    expect(ring).toHaveLength(49)
    expect(ring[48]).toEqual(ring[0])
    for (const p of ring) near(distanceM(KAMLOOPS, p), 500, 1e-6)
    const meridian: Position[] = [[-120.3, 50.6], [-120.3, 50.7]]
    const p = eastAlongParallel([-120.3, 50.65], 400)
    near(distToPolylineM(p, meridian), 400, 0.05)
  })

  it('"Send this area": the printed scale and the ground size are WGS84', () => {
    const area = areaAt(KAMLOOPS, 14, { w: 1600, h: 1100 })
    const at = (fx: number, fy: number) => framePointToLngLat(area, fx, fy)
    // East–west ground metres per pixel at the centre, measured with geodesics.
    const measured = distanceM(at(area.w / 2 - 50, area.h / 2), at(area.w / 2 + 50, area.h / 2)) / 100
    near(metresPerPx(area) / measured, 1, 1e-6)
    // The old sphere-of-6,378,137-m formula was 0.2% small at this latitude (a/N).
    const [, lat] = at(area.w / 2, area.h / 2)
    const old = (2 * Math.PI * 6378137 * Math.cos(lat * RAD)) / (512 * 2 ** 14)
    near(metresPerPx(area) / old, 1.00201, 0.00001)
    near(scaleDenominator(area), metresPerPx(area) / (0.0254 / 96), 1e-6)
    const g = groundSizeM(area)
    near(g.w, distanceM(at(0, area.h / 2), at(area.w, area.h / 2)), 1e-9)
    near(g.h, distanceM(at(area.w / 2, 0), at(area.w / 2, area.h)), 1e-9)
  })
})

function near(x: number, y: number, tol: number) {
  expect(Math.abs(x - y), `${x} vs ${y}`).toBeLessThanOrEqual(tol)
}
