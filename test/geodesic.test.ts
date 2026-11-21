/**
 * The WGS84 geodesic module (src/lib/geodesic.ts), checked three independent
 * ways:
 *   1. GeographicLib's own test vectors (geographiclib-js, geodesic/test/
 *      geodesictest.js: the 20 reference geodesics and the GeodSolve /
 *      Planimeter regressions). GeographicLib is Copyright (c) Charles Karney,
 *      MIT/X11 licence.
 *   2. Vincenty's inverse formula, written out here, on random lines in BC.
 *   3. Areas against BC Albers (EPSG:3005, src/lib/albers.ts), which is an
 *      equal-area projection: the planar area of a densely drawn polygon in
 *      Albers metres is its area on the ellipsoid.
 */
import { describe, expect, it } from 'vitest'
import type { Position } from 'geojson'
import { toBcAlbers } from '../src/lib/albers'
import {
  WGS84,
  azimuthDeg,
  destination,
  distanceM,
  lengthM,
  metresPerDegree,
  ringAreaM2,
} from '../src/lib/geodesic'

const RAD = Math.PI / 180
const A = 6378137
const F = 1 / 298.257223563
const E2 = F * (2 - F)

/** |x − y| ≤ tol, with a readable message. */
function near(x: number, y: number, tol: number, what = '') {
  expect(Math.abs(x - y), `${what} ${x} vs ${y}`).toBeLessThanOrEqual(tol)
}

/** Difference of two angles, degrees, in [−180, 180]. */
const angleDiff = (x: number, y: number) => ((((x - y) % 360) + 540) % 360) - 180

// lat1, lon1, azi1, lat2, lon2, azi2, s12, a12, m12, M12, M21, S12 — verbatim
// from geodesictest.js ("testcases").
const TESTCASES: number[][] = [
  [35.60777, -139.44815, 111.098748429560326, -11.17491, -69.95921, 129.289270889708762,
    8935244.5604818305, 80.50729714281974, 6273170.2055303837, 0.16606318447386067, 0.16479116945612937, 12841384694976.432],
  [55.52454, 106.05087, 22.020059880982801, 77.03196, 197.18234, 109.112041110671519,
    4105086.1713924406, 36.892740690445894, 3828869.3344387607, 0.80076349608092607, 0.80101006984201008, 61674961290615.615],
  [-21.97856, 142.59065, -32.44456876433189, 41.84138, 98.56635, -41.84359951440466,
    8394328.894657671, 75.62930491011522, 6161154.5773110616, 0.24816339233950381, 0.24930251203627892, -6637997720646.717],
  [-66.99028, 112.2363, 173.73491240878403, -12.70631, 285.90344, 2.512956620913668,
    11150344.2312080241, 100.278634181155759, 6289939.5670446687, -0.17199490274700385, -0.17722569526345708, -121287239862139.744],
  [-17.42761, 173.34268, -159.033557661192928, -15.84784, 5.93557, -20.787484651536988,
    16076603.1631180673, 144.640108810286253, 3732902.1583877189, -0.81273638700070476, -0.81299800519154474, 97825992354058.708],
  [32.84994, 48.28919, 150.492927788121982, -56.28556, 202.29132, 48.113449399816759,
    16727068.9438164461, 150.565799985466607, 3147838.1910180939, -0.87334918086923126, -0.86505036767110637, -72445258525585.010],
  [6.96833, 52.74123, 92.581585386317712, -7.39675, 206.17291, 90.721692165923907,
    17102477.2496958388, 154.147366239113561, 2772035.6169917581, -0.89991282520302447, -0.89986892177110739, -1311796973197.995],
  [-50.56724, -16.30485, -105.439679907590164, -33.56571, -94.97412, -47.348547835650331,
    6455670.5118668696, 58.083719495371259, 5409150.7979815838, 0.53053508035997263, 0.52988722644436602, 41071447902810.047],
  [-58.93002, -8.90775, 140.965397902500679, -8.91104, 133.13503, 19.255429433416599,
    11756066.0219864627, 105.755691241406877, 6151101.2270708536, -0.26548622269867183, -0.27068483874510741, -86143460552774.735],
  [-68.82867, -74.28391, 93.774347763114881, -50.63005, -8.36685, 34.65564085411343,
    3956936.926063544, 35.572254987389284, 3708890.9544062657, 0.81443963736383502, 0.81420859815358342, -41845309450093.787],
  [-10.62672, -32.0898, -86.426713286747751, 5.883, -134.31681, -80.473780971034875,
    11470869.3864563009, 103.387395634504061, 6184411.6622659713, -0.23138683500430237, -0.23155097622286792, 4198803992123.548],
  [-21.76221, 166.90563, 29.319421206936428, 48.72884, 213.97627, 43.508671946410168,
    9098627.3986554915, 81.963476716121964, 6299240.9166992283, 0.13965943368590333, 0.14152969707656796, 10024709850277.476],
  [-19.79938, -174.47484, 71.167275780171533, -11.99349, -154.35109, 65.589099775199228,
    2319004.8601169389, 20.896611684802389, 2267960.8703918325, 0.93427001867125849, 0.93424887135032789, -3935477535005.785],
  [-11.95887, -116.94513, 92.712619830452549, 4.57352, 7.16501, 78.64960934409585,
    13834722.5801401374, 124.688684161089762, 5228093.177931598, -0.56879356755666463, -0.56918731952397221, -9919582785894.853],
  [-87.85331, 85.66836, -65.120313040242748, 66.48646, 16.09921, -4.888658719272296,
    17286615.3147144645, 155.58592449699137, 2635887.4729110181, -0.90697975771398578, -0.91095608883042767, 42667211366919.534],
  [1.74708, 128.32011, -101.584843631173858, -11.16617, 11.87109, -86.325793296437476,
    12942901.1241347408, 116.650512484301857, 5682744.8413270572, -0.44857868222697644, -0.44824490340007729, 10763055294345.653],
  [-25.72959, -144.90758, -153.647468693117198, -57.70581, -269.17879, -48.343983158876487,
    9413446.7452453107, 84.664533838404295, 6356176.6898881281, 0.09492245755254703, 0.09737058264766572, 74515122850712.444],
  [-41.22777, 122.32875, 14.285113402275739, -7.57291, 130.37946, 10.805303085187369,
    3812686.035106021, 34.34330804743883, 3588703.8812128856, 0.82605222593217889, 0.82572158200920196, -2456961531057.857],
  [11.01307, 138.25278, 79.43682622782374, 6.62726, 247.05981, 103.708090215522657,
    11911190.819018408, 107.341669954114577, 6070904.722786735, -0.29767608923657404, -0.29785143390252321, 17121631423099.696],
  [-29.47124, 95.14681, -163.779130441688382, -27.46601, -69.15955, -15.909335945554969,
    13487015.8381145492, 121.294026715742277, 5481428.9945736388, -0.51527225545373252, -0.51556587964721788, 104679964020340.318],
]

describe('GeographicLib test vectors', () => {
  it('inverse: the 20 reference geodesics (same tolerances as GeographicLib)', () => {
    for (const [lat1, lon1, azi1, lat2, lon2, azi2, s12, , , , , S12] of TESTCASES) {
      const r = WGS84.inverse(lat1, lon1, lat2, lon2, true)
      near(r.azi1, azi1, 1e-13, 'azi1')
      near(r.azi2, azi2, 1e-13, 'azi2')
      near(r.s12, s12, 1e-8, 's12')
      near(r.S12, S12, 0.1, 'S12')
    }
  })

  it('direct: the 20 reference geodesics', () => {
    for (const [lat1, lon1, azi1, lat2, lon2, azi2, s12] of TESTCASES) {
      const r = WGS84.direct(lat1, lon1, azi1, s12)
      near(r.lat2, lat2, 1e-13, 'lat2')
      near(angleDiff(r.lon2, lon2), 0, 1e-13, 'lon2')
      near(r.azi2, azi2, 1e-13, 'azi2')
    }
  })

  it('GeodSolve0 and 1: JFK to Paris CDG', () => {
    const inv = WGS84.inverse(40.6, -73.8, 49.01666667, 2.55)
    near(inv.azi1, 53.47022, 0.5e-5)
    near(inv.azi2, 111.59367, 0.5e-5)
    near(inv.s12, 5853226, 0.5)
    const dir = WGS84.direct(40.63972222, -73.77888889, 53.5, 5850e3)
    near(dir.lat2, 49.01467, 0.5e-5)
    near(dir.lon2, 2.56106, 0.5e-5)
    near(dir.azi2, 111.62947, 0.5e-5)
  })

  it('GeodSolve4: a 7 cm line, not rounded to zero', () => {
    near(WGS84.inverse(36.493349428792, 0, 36.49334942879201, 0.0000008).s12, 0.072, 0.5e-3)
  })

  it('GeodSolve6, 9, 10, 11, 59: nearly antipodal points (the hard case for Newton)', () => {
    near(WGS84.inverse(88.202499451857, 0, -88.202499451857, 179.981022032992859592).s12, 20003898.214, 0.5e-3)
    near(WGS84.inverse(89.262080389218, 0, -89.262080389218, 179.992207982775375662).s12, 20003925.854, 0.5e-3)
    near(WGS84.inverse(89.333123580033, 0, -89.333123580032997687, 179.99295812360148422).s12, 20003926.881, 0.5e-3)
    near(WGS84.inverse(56.320923501171, 0, -56.320923501171, 179.664747671772880215).s12, 19993558.287, 0.5e-3)
    near(WGS84.inverse(52.784459512564, 0, -52.784459512563990912, 179.634407464943777557).s12, 19991596.095, 0.5e-3)
    near(WGS84.inverse(48.522876735459, 0, -48.52287673545898293, 179.599720456223079643).s12, 19989144.774, 0.5e-3)
    const r = WGS84.inverse(5, 0.00000000000001, 10, 180)
    near(r.azi1, 0.000000000000035, 1.5e-14)
    near(r.azi2, 179.99999999999996, 1.5e-14)
    near(r.s12, 18345191.174332713, 5e-9)
  })

  it('Planimeter0, 5, 6, 12, 13: polygon areas and perimeters', () => {
    const poly = (pts: number[][]) => WGS84.polygon(pts)
    let p = poly([[89, 0], [89, 90], [89, 180], [89, 270]])
    near(p.perimeter, 631819.8745, 1e-4)
    near(p.area, 24952305678, 1)
    p = poly([[-89, 0], [-89, 90], [-89, 180], [-89, 270]])
    near(p.perimeter, 631819.8745, 1e-4)
    near(p.area, -24952305678, 1)
    p = poly([[0, -1], [-1, 0], [0, 1], [1, 0]])
    near(p.perimeter, 627598.2731, 1e-4)
    near(p.area, 24619419146, 1)
    p = poly([[90, 0], [0, 0], [0, 90]]) // an eighth of the ellipsoid
    near(p.perimeter, 30022685, 1)
    near(p.area, 63758202715511, 1)
    near(p.area * 8, WGS84.totalArea, 8)
    p = poly([[89, 0.1], [89, 90.1], [89, -179.9]])
    near(p.perimeter, 539297, 1)
    near(p.area, 12476152838.5, 1)
    for (const pts of [
      [[9, -0.00000000000001], [9, 180], [9, 0]],
      [[9, 0.00000000000001], [9, 0], [9, 180]],
      [[9, 0.00000000000001], [9, 180], [9, 0]],
      [[9, -0.00000000000001], [9, 0], [9, 180]],
    ]) {
      p = poly(pts)
      near(p.perimeter, 36026861, 1)
      near(p.area, 0, 1)
    }
    p = poly([[66.562222222, 0], [66.562222222, 180], [66.562222222, 360]])
    near(p.perimeter, 10465729, 1)
    near(p.area, 0, 1)
    p = poly([[89, -360], [89, -240], [89, -120], [89, 0], [89, 120], [89, 240]])
    near(p.perimeter, 1160741, 1)
    near(p.area, 32415230256, 1)
  })
})

/** Vincenty (1975) inverse on WGS84: an independent formula, good to ~0.1 mm away from antipodes. */
function vincenty(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const b = A * (1 - F)
  const L = (lon2 - lon1) * RAD
  const U1 = Math.atan((1 - F) * Math.tan(lat1 * RAD))
  const U2 = Math.atan((1 - F) * Math.tan(lat2 * RAD))
  const [sinU1, cosU1, sinU2, cosU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)]
  let lambda = L
  let sinS = 0
  let cosS = 0
  let sigma = 0
  let cos2a = 0
  let cos2sm = 0
  for (let i = 0; i < 200; i++) {
    const sinL = Math.sin(lambda)
    const cosL = Math.cos(lambda)
    sinS = Math.hypot(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL)
    cosS = sinU1 * sinU2 + cosU1 * cosU2 * cosL
    sigma = Math.atan2(sinS, cosS)
    const sinA = (cosU1 * cosU2 * sinL) / sinS
    cos2a = 1 - sinA * sinA
    cos2sm = cos2a ? cosS - (2 * sinU1 * sinU2) / cos2a : 0
    const C = (F / 16) * cos2a * (4 + F * (4 - 3 * cos2a))
    const prev = lambda
    lambda = L + (1 - C) * F * sinA * (sigma + C * sinS * (cos2sm + C * cosS * (-1 + 2 * cos2sm * cos2sm)))
    if (Math.abs(lambda - prev) < 1e-13) break
  }
  const u2 = (cos2a * (A * A - b * b)) / (b * b)
  const Ac = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
  const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
  const dS =
    B * sinS * (cos2sm + (B / 4) * (cosS * (-1 + 2 * cos2sm * cos2sm) - (B / 6) * cos2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2sm * cos2sm)))
  return b * Ac * (sigma - dS)
}

/** Seeded uniform numbers (mulberry32). */
function random(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('against Vincenty, in BC', () => {
  it('agrees to 0.1 mm on 2,000 random lines from 1 m to 1,000 km', () => {
    const rnd = random(7)
    let worst = 0
    for (let i = 0; i < 2000; i++) {
      const lat1 = 48.3 + rnd() * 11.7
      const lon1 = -139 + rnd() * 25
      const scale = 10 ** (rnd() * 4 - 4) // 0.0001° to 1°… then up to ~10°
      const lat2 = Math.min(60, Math.max(48.3, lat1 + (rnd() - 0.5) * 20 * scale))
      const lon2 = lon1 + (rnd() - 0.5) * 30 * scale
      const d = distanceM([lon1, lat1], [lon2, lat2])
      worst = Math.max(worst, Math.abs(d - vincenty(lat1, lon1, lat2, lon2)))
    }
    expect(worst).toBeLessThan(1e-4)
  })
})

/** Planar area of [lng, lat] vertices in BC Albers metres (shoelace). */
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

/** Points every ~`stepM` metres along each geodesic edge of a ring. */
function densify(ring: Position[], stepM: number): Position[] {
  const out: Position[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    const { s12, azi1 } = WGS84.inverse(a[1], a[0], b[1], b[0])
    const n = Math.max(1, Math.ceil(s12 / stepM))
    for (let k = 0; k < n; k++) out.push(k === 0 ? a : destination(a, azi1, (s12 * k) / n))
  }
  return out
}

describe('areas against BC Albers (equal-area)', () => {
  it('a 3,600-vertex fire near Kamloops: same area to a square centimetre', () => {
    const ring: Position[] = []
    for (let i = 0; i < 3600; i++) {
      const t = (i / 3600) * 2 * Math.PI
      const r = 2000 * (1 + 0.35 * Math.sin(3 * t) + 0.15 * Math.cos(7 * t)) // metres, lobed
      ring.push([-120.33 + (r * Math.cos(t)) / 70_700, 50.67 + (r * Math.sin(t)) / 111_250])
    }
    const albers = albersArea(ring)
    const karney = ringAreaM2(ring)
    expect(albers).toBeGreaterThan(1e7) // over 1,000 ha
    near(karney, albers, 0.01, 'm²')
  })

  it('a 20 km square with long geodesic edges (densified for Albers)', () => {
    const sw = [-121.4, 50.2]
    const nw = destination(sw, 0, 20_000)
    const ne = destination(nw, 90, 20_000)
    const se = destination(sw, 90, 20_000)
    const ring = [sw, se, ne, nw]
    const karney = ringAreaM2(ring)
    near(karney / 1e8, 4, 0.01) // ~400 km²
    near(karney, albersArea(densify(ring, 20)), 0.5, 'm²')
  })

  it('doesn’t care which way round the ring goes, or whether it is closed', () => {
    const ring: Position[] = [[-120.4, 50.6], [-120.3, 50.62], [-120.32, 50.7], [-120.41, 50.68]]
    const a = ringAreaM2(ring)
    near(ringAreaM2([...ring].reverse()), a, 1e-6)
    near(ringAreaM2([...ring, ring[0]]), a, 1e-6)
    expect(ringAreaM2(ring.slice(0, 2))).toBe(0)
  })
})

describe('helpers', () => {
  it('destination and distance/azimuth undo each other', () => {
    const rnd = random(3)
    for (let i = 0; i < 200; i++) {
      const start: Position = [-130 + rnd() * 15, 49 + rnd() * 10]
      const azi = rnd() * 360
      const dist = 10 ** (rnd() * 6)
      const end = destination(start, azi, dist)
      near(distanceM(start, end), dist, 1e-8 * Math.max(1, dist / 1000))
      // Coordinates carry ~1e-10 m of round-off, so short lines' azimuths are looser.
      near(angleDiff(azimuthDeg(start, end), azi), 0, Math.max(1e-9, 1e-7 / dist))
    }
  })

  it('metresPerDegree is the local scale of the geodesic (finite differences)', () => {
    for (const lat of [0, 30, 49, 50.67, 60, 69]) {
      const { east, north } = metresPerDegree(lat)
      const d = 1e-4 // degrees
      near(distanceM([-120, lat], [-120 + d, lat]) / d, east, east * 1e-7, `east at ${lat}`)
      near(distanceM([-120, lat - d / 2], [-120, lat + d / 2]) / d, north, north * 1e-7, `north at ${lat}`)
    }
    // Closed form at 50°N: N cos φ and M, in metres per degree.
    const s = Math.sin(50 * RAD)
    const w = Math.sqrt(1 - E2 * s * s)
    near(metresPerDegree(50).east, ((A / w) * Math.cos(50 * RAD) * Math.PI) / 180, 1e-6)
    near(metresPerDegree(50).north, ((A * (1 - E2)) / w ** 3) * RAD, 1e-6)
  })

  it('lengthM adds up the segments; one point or none is 0', () => {
    const path: Position[] = [[-120.3, 50.6], [-120.2, 50.61], [-120.1, 50.65]]
    near(lengthM(path), distanceM(path[0], path[1]) + distanceM(path[1], path[2]), 1e-9)
    expect(lengthM(path.slice(0, 1))).toBe(0)
    expect(lengthM([])).toBe(0)
    expect(distanceM(path[0], path[0])).toBe(0)
  })

  it('is fast enough for big tracks and perimeters', () => {
    const ring: Position[] = []
    for (let i = 0; i < 20_000; i++) {
      const t = (i / 20_000) * 2 * Math.PI
      ring.push([-120.33 + 0.1 * Math.cos(t), 50.67 + 0.07 * Math.sin(t)])
    }
    const t0 = performance.now()
    lengthM(ring)
    ringAreaM2(ring)
    // ~20 ms on a laptop; generous for a busy 2-core CI runner.
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
