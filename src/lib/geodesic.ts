// Lengths, areas, azimuths and destinations on the WGS84 ellipsoid, the way
// GIS measures them (ArcGIS "geodesic" lengths and areas; QGIS and PostGIS
// use this same algorithm through PROJ / GeographicLib). Every distance and
// area the app shows comes from here, via measure.ts and packs/area.ts. The
// spherical formulas used before (R = 6,371,008.8 m) read about 0.3% short
// east–west and 0.35% small in area at BC latitudes.
//
// A port of C. F. F. Karney, "Algorithms for geodesics", J. Geodesy 87,
// 43–55 (2013), https://doi.org/10.1007/s00190-012-0578-z, following
// GeographicLib's JavaScript implementation (geographiclib-geodesic 2.x)
// with its 6th-order series. Distances are good to round-off (nanometres);
// test/geodesic.test.ts checks it against GeographicLib's own test vectors.
// Only what the app needs: oblate ellipsoids (or a sphere), the inverse
// problem with area, the direct problem, and polygons.
//
// GeographicLib is Copyright (c) Charles Karney (2011-2022)
// <karney@alum.mit.edu> and licensed under the MIT/X11 License;
// https://geographiclib.sourceforge.io/
//
// No DOM, no Node: packs/area.ts (shared with the Mac pack builder) imports
// this file with its .ts extension.

import type { Position } from 'geojson'

// ---------- Angles, done carefully (GeographicLib's Math) ----------

const DEGREE = Math.PI / 180
const TINY = Math.sqrt(2.2250738585072014e-308) // sqrt(smallest normal double)
const TOL0 = Number.EPSILON
const TOL1 = 200 * TOL0
const TOL2 = Math.sqrt(TOL0)
const TOLB = TOL0
const XTHRESH = 1000 * TOL2
const MAXIT1 = 20
const MAXIT2 = MAXIT1 + 53 + 10

const sq = (x: number) => x * x
const hypot = (x: number, y: number) => Math.sqrt(x * x + y * y)

function copysign(x: number, y: number): number {
  return Math.abs(x) * (y < 0 || (y === 0 && 1 / y < 0) ? -1 : 1)
}

/** Error-free sum: s + t equals u + v exactly. */
function sum(u: number, v: number): [number, number] {
  const s = u + v
  let up = s - v
  let vpp = s - up
  up -= u
  vpp -= v
  return [s, s ? 0 - (up + vpp) : s]
}

/** x reduced to [−y/2, y/2). */
function remainder(x: number, y: number): number {
  y = Math.abs(y)
  const z = x % y
  return z < -y / 2 ? z + y : z < y / 2 ? z : z - y
}

/** Angle reduced to [−180°, 180°]. */
function angNormalize(x: number): number {
  const y = remainder(x, 360)
  return Math.abs(y) === 180 ? copysign(180, x) : y
}

const latFix = (x: number) => (Math.abs(x) > 90 ? NaN : x)

/** y − x reduced to [−180°, 180°], as d + e (exactly). */
function angDiff(x: number, y: number): [number, number] {
  let [s, t] = sum(remainder(-x, 360), remainder(y, 360))
  ;[s, t] = sum(remainder(s, 360), t)
  let d = s
  if (d === 0 || Math.abs(d) === 180) d = copysign(d, t === 0 ? y - x : -t)
  return [d, t]
}

/** Coarsen tiny angles so that they're exact multiples of 2⁻⁵⁷ degrees. */
function angRound(x: number): number {
  const z = 1 / 16
  let y = Math.abs(x)
  y = y < z ? z - (z - y) : y
  return copysign(y, x)
}

function sincosQuadrant(d: number, q: number, x: number): [number, number] {
  const r = d * DEGREE
  let s = Math.sin(r)
  let c = Math.cos(r)
  if (Math.abs(d) === 45) {
    c = Math.SQRT1_2
    s = copysign(c, r)
  } else if (Math.abs(d) === 30) {
    c = Math.sqrt(0.75)
    s = copysign(0.5, r)
  }
  let sinx: number
  let cosx: number
  switch (q & 3) {
    case 0:
      sinx = s
      cosx = c
      break
    case 1:
      sinx = c
      cosx = -s
      break
    case 2:
      sinx = -s
      cosx = -c
      break
    default:
      sinx = -c
      cosx = s
  }
  cosx += 0
  if (sinx === 0) sinx = copysign(sinx, x)
  return [sinx, cosx]
}

/** sin and cos of an angle in degrees, exact at multiples of 30° and 45°. */
function sincosd(x: number): [number, number] {
  let d = x % 360
  const q = Math.round(d / 90)
  d -= 90 * q
  return sincosQuadrant(d, q, x)
}

/** sincosd(x + t), for x + t from angDiff. */
function sincosde(x: number, t: number): [number, number] {
  const q = Math.round(x / 90)
  return sincosQuadrant(angRound(x - 90 * q + t), q, x)
}

/** atan2 in degrees, with exact results at the quadrant boundaries. */
function atan2d(y: number, x: number): number {
  let q = 0
  if (Math.abs(y) > Math.abs(x)) {
    const t = x
    x = y
    y = t
    q = 2
  }
  if (x < 0 || (x === 0 && 1 / x < 0)) {
    x = -x
    ++q
  }
  let ang = Math.atan2(y, x) / DEGREE
  switch (q) {
    case 1:
      ang = copysign(180, y) - ang
      break
    case 2:
      ang = 90 - ang
      break
    case 3:
      ang = -90 + ang
      break
  }
  return ang
}

function norm2(x: number, y: number): [number, number] {
  const r = hypot(x, y)
  return [x / r, y / r]
}

/** Polynomial of degree N with coefficients p[s], p[s+1], … (highest first) at x. */
function polyval(N: number, p: ArrayLike<number>, s: number, x: number): number {
  let y = N < 0 ? 0 : p[s++]
  while (--N >= 0) y = y * x + p[s++]
  return y
}

/**
 * Clenshaw summation of sum(c[i] sin 2ix, i = 1..n) (sinp, c[0] unused) or
 * sum(c[i] cos (2i+1)x, i = 0..n−1).
 */
function sinCosSeries(sinp: boolean, sinx: number, cosx: number, c: Float64Array): number {
  let k = c.length
  let n = k - (sinp ? 1 : 0)
  const ar = 2 * (cosx - sinx) * (cosx + sinx) // 2 cos 2x
  let y0 = n & 1 ? c[--k] : 0
  let y1 = 0
  n >>= 1
  while (n--) {
    y1 = ar * y0 - y1 + c[--k]
    y0 = ar * y1 - y0 + c[--k]
  }
  return sinp ? 2 * sinx * cosx * y0 : cosx * (y0 - y1)
}

/** Sum with an error term, so that summing big S12s around a small polygon keeps its digits. */
class Accumulator {
  s = 0
  t = 0
  add(y: number): void {
    const [us, ut] = sum(y, this.t)
    const [vs, vt] = sum(us, this.s)
    this.s = vs
    this.t = vt
    if (this.s === 0) this.s = ut
    else this.t += ut
  }
  remainder(y: number): void {
    this.s = remainder(this.s, y)
    this.add(0)
  }
  negate(): void {
    this.s *= -1
    this.t *= -1
  }
}

// ---------- Series (Karney 2013, order 6) ----------

const ORDER = 6
const nC1 = ORDER
const nC1p = ORDER
const nC2 = ORDER
const nA3 = ORDER
const nC3 = ORDER
const nC4 = ORDER

/** (1 − ε) A1 − 1, eq. (17). */
const A1_COEFF = [1, 4, 64, 0, 256]
function A1m1f(eps: number): number {
  const p = ORDER >> 1
  const t = polyval(p, A1_COEFF, 0, sq(eps)) / A1_COEFF[p + 1]
  return (t + eps) / (1 - eps)
}

/** C1[l], eq. (18). */
const C1_COEFF = [-1, 6, -16, 32, -9, 64, -128, 2048, 9, -16, 768, 3, -5, 512, -7, 1280, -7, 2048]
/** C1'[l], eq. (21). */
const C1P_COEFF = [
  205, -432, 768, 1536, 4005, -4736, 3840, 12288, -225, 116, 384, -7173, 2695, 7680, 3467, 7680, 38081, 61440,
]
/** C2[l], eq. (43). */
const C2_COEFF = [1, 2, 16, 32, 35, 64, 384, 2048, 15, 80, 768, 7, 35, 512, 63, 1280, 77, 2048]

/** Coefficients in ε of a sine series, each a polynomial in ε², into c[1..n]. */
function evenSeries(coeff: readonly number[], n: number, eps: number, c: Float64Array): void {
  const eps2 = sq(eps)
  let d = eps
  let o = 0
  for (let l = 1; l <= n; ++l) {
    const p = (n - l) >> 1
    c[l] = (d * polyval(p, coeff, o, eps2)) / coeff[o + p + 1]
    o += p + 2
    d *= eps
  }
}

/** (1 + ε) A2 − 1, eq. (42). */
const A2_COEFF = [-11, -28, -192, 0, 256]
function A2m1f(eps: number): number {
  const p = ORDER >> 1
  const t = polyval(p, A2_COEFF, 0, sq(eps)) / A2_COEFF[p + 1]
  return (t - eps) / (1 + eps)
}

/** A3 (eq. 24): coefficients of ε⁵…ε⁰, each a polynomial in n. */
const A3_COEFF = [-3, 128, -2, -3, 64, -1, -3, -1, 16, 3, -1, -2, 8, 1, -1, 2, 1, 1]
/** C3[l] (eq. 25), l = 1..5: coefficients of ε⁵…εˡ, each a polynomial in n. */
const C3_COEFF = [
  3, 128, 2, 5, 128, -1, 3, 3, 64, -1, 0, 1, 8, -1, 1, 4,
  5, 256, 1, 3, 128, -3, -2, 3, 64, 1, -3, 2, 32,
  7, 512, -10, 9, 384, 5, -9, 5, 192,
  7, 512, -14, 7, 512,
  21, 2560,
]
/** C4[l] (area, eq. 64), l = 0..5: coefficients of ε⁵…εˡ, each a polynomial in n. */
const C4_COEFF = [
  97, 15015, 1088, 156, 45045, -224, -4784, 1573, 45045, -10656, 14144, -4576, -858, 45045,
  64, 624, -4576, 6864, -3003, 15015, 100, 208, 572, 3432, -12012, 30030, 45045,
  1, 9009, -2944, 468, 135135, 5792, 1040, -1287, 135135, 5952, -11648, 9152, -2574, 135135,
  -64, -624, 4576, -6864, 3003, 135135,
  8, 10725, 1856, -936, 225225, -8448, 4992, -1144, 225225, -1440, 4160, -4576, 1716, 225225,
  -136, 63063, 1024, -208, 105105, 3584, -3328, 1144, 315315,
  -128, 135135, -2560, 832, 405405,
  128, 99099,
]

// ---------- The ellipsoid ----------

export interface InverseResult {
  /** Length of the geodesic, metres. */
  s12: number
  /** Azimuth at the first point and (forward) at the second, degrees clockwise from true north. */
  azi1: number
  azi2: number
  /** Area between the geodesic and the equator, m² (only when asked for; else NaN). */
  S12: number
}

export interface DirectResult {
  lat2: number
  lon2: number
  azi2: number
}

interface Lambda12 {
  lam12: number
  salp2: number
  calp2: number
  sig12: number
  ssig1: number
  csig1: number
  ssig2: number
  csig2: number
  eps: number
  domg12: number
  dlam12: number
}

export class Geodesic {
  readonly a: number
  readonly f: number
  private readonly f1: number
  private readonly e2: number
  private readonly ep2: number
  private readonly n: number
  private readonly b: number
  /** Authalic radius squared: the surface area is 4πc². */
  private readonly c2: number
  private readonly etol2: number
  private readonly A3x = new Float64Array(nA3)
  private readonly C3x = new Float64Array((nC3 * (nC3 - 1)) / 2)
  private readonly C4x = new Float64Array((nC4 * (nC4 + 1)) / 2)
  // Scratch space for the series (single-threaded, never re-entered).
  private readonly C1a = new Float64Array(nC1 + 1)
  private readonly C1pa = new Float64Array(nC1p + 1)
  private readonly C2a = new Float64Array(nC2 + 1)
  private readonly C3a = new Float64Array(nC3)
  private readonly C4a = new Float64Array(nC4)

  constructor(a: number, f: number) {
    if (!(a > 0) || !(f >= 0 && f < 1)) throw new Error('Geodesic: only spheres and oblate ellipsoids')
    this.a = a
    this.f = f
    this.f1 = 1 - f
    this.e2 = f * (2 - f)
    this.ep2 = this.e2 / sq(this.f1)
    this.n = f / (2 - f)
    this.b = a * this.f1
    const e = Math.sqrt(this.e2)
    this.c2 = (sq(a) + sq(this.b) * (this.e2 === 0 ? 1 : Math.atanh(e) / e)) / 2
    this.etol2 = (0.1 * TOL2) / Math.sqrt((Math.max(0.001, Math.abs(f)) * Math.min(1, 1 - f / 2)) / 2)

    let o = 0
    let k = 0
    for (let j = nA3 - 1; j >= 0; --j) {
      const p = Math.min(nA3 - j - 1, j)
      this.A3x[k++] = polyval(p, A3_COEFF, o, this.n) / A3_COEFF[o + p + 1]
      o += p + 2
    }
    o = 0
    k = 0
    for (let l = 1; l < nC3; ++l) {
      for (let j = nC3 - 1; j >= l; --j) {
        const p = Math.min(nC3 - j - 1, j)
        this.C3x[k++] = polyval(p, C3_COEFF, o, this.n) / C3_COEFF[o + p + 1]
        o += p + 2
      }
    }
    o = 0
    k = 0
    for (let l = 0; l < nC4; ++l) {
      for (let j = nC4 - 1; j >= l; --j) {
        const p = nC4 - j - 1
        this.C4x[k++] = polyval(p, C4_COEFF, o, this.n) / C4_COEFF[o + p + 1]
        o += p + 2
      }
    }
  }

  /** Surface area of the whole ellipsoid, m². */
  get totalArea(): number {
    return 4 * Math.PI * this.c2
  }

  /** Radii of curvature at a latitude: meridional (north–south) and prime vertical (east–west), metres. */
  radiiOfCurvature(lat: number): { meridional: number; primeVertical: number } {
    const [s] = sincosd(lat)
    const w2 = 1 - this.e2 * s * s
    const w = Math.sqrt(w2)
    return { meridional: (this.a * (1 - this.e2)) / (w2 * w), primeVertical: this.a / w }
  }

  private A3f(eps: number): number {
    return polyval(nA3 - 1, this.A3x, 0, eps)
  }

  private C3f(eps: number, c: Float64Array): void {
    let mult = 1
    let o = 0
    for (let l = 1; l < nC3; ++l) {
      const p = nC3 - l - 1
      mult *= eps
      c[l] = mult * polyval(p, this.C3x, o, eps)
      o += p + 1
    }
  }

  private C4f(eps: number, c: Float64Array): void {
    let mult = 1
    let o = 0
    for (let l = 0; l < nC4; ++l) {
      const p = nC4 - l - 1
      c[l] = mult * polyval(p, this.C4x, o, eps)
      o += p + 1
      mult *= eps
    }
  }

  /** Distance / b (s12b), reduced length / b (m12b) and m0. */
  private lengths(
    eps: number,
    sig12: number,
    ssig1: number,
    csig1: number,
    dn1: number,
    ssig2: number,
    csig2: number,
    dn2: number,
    distance: boolean,
    reduced: boolean,
  ): { s12b: number; m12b: number; m0: number } {
    const { C1a, C2a } = this
    let m0x = 0
    let J12 = 0
    let A1 = A1m1f(eps)
    let A2 = 0
    let s12b = NaN
    let m12b = NaN
    evenSeries(C1_COEFF, nC1, eps, C1a)
    if (reduced) {
      A2 = A2m1f(eps)
      evenSeries(C2_COEFF, nC2, eps, C2a)
      m0x = A1 - A2
      A2 = 1 + A2
    }
    A1 = 1 + A1
    if (distance) {
      const B1 = sinCosSeries(true, ssig2, csig2, C1a) - sinCosSeries(true, ssig1, csig1, C1a)
      s12b = A1 * (sig12 + B1)
      if (reduced) {
        const B2 = sinCosSeries(true, ssig2, csig2, C2a) - sinCosSeries(true, ssig1, csig1, C2a)
        J12 = m0x * sig12 + (A1 * B1 - A2 * B2)
      }
    } else if (reduced) {
      for (let l = 1; l <= nC2; ++l) C2a[l] = A1 * C1a[l] - A2 * C2a[l]
      J12 = m0x * sig12 + (sinCosSeries(true, ssig2, csig2, C2a) - sinCosSeries(true, ssig1, csig1, C2a))
    }
    if (reduced) {
      // Parentheses keep the cancellation exact for coincident points.
      m12b = dn2 * (csig1 * ssig2) - dn1 * (ssig1 * csig2) - csig1 * csig2 * J12
    }
    return { s12b, m12b, m0: m0x }
  }

  /** Positive root k of k⁴ + 2k³ − (x² + y² − 1)k² − 2y²k − y² = 0. */
  private static astroid(x: number, y: number): number {
    const p = sq(x)
    const q = sq(y)
    const r = (p + q - 1) / 6
    if (q === 0 && r <= 0) return 0
    const S = (p * q) / 4
    const r2 = sq(r)
    const r3 = r * r2
    const disc = S * (S + 2 * r3)
    let u = r
    if (disc >= 0) {
      let T3 = S + r3
      T3 += T3 < 0 ? -Math.sqrt(disc) : Math.sqrt(disc)
      const T = Math.cbrt(T3)
      u += T + (T !== 0 ? r2 / T : 0)
    } else {
      const ang = Math.atan2(Math.sqrt(-disc), -(S + r3))
      u += 2 * r * Math.cos(ang / 3)
    }
    const v = Math.sqrt(sq(u) + q)
    const uv = u < 0 ? q / (v - u) : u + v
    const w = (uv - q) / (2 * v)
    return uv / (Math.sqrt(uv + sq(w)) + w)
  }

  /** Starting point for Newton's method; sig12 ≥ 0 when the answer is already good (short lines). */
  private inverseStart(
    sbet1: number,
    cbet1: number,
    sbet2: number,
    cbet2: number,
    lam12: number,
    slam12: number,
    clam12: number,
  ): { sig12: number; salp1: number; calp1: number; salp2: number; calp2: number; dnm: number } {
    let sig12 = -1
    let salp2 = NaN
    let calp2 = NaN
    let dnm = NaN
    const sbet12 = sbet2 * cbet1 - cbet2 * sbet1
    const cbet12 = cbet2 * cbet1 + sbet2 * sbet1
    let sbet12a = sbet2 * cbet1
    sbet12a += cbet2 * sbet1
    const shortline = cbet12 >= 0 && sbet12 < 0.5 && cbet2 * lam12 < 0.5
    let somg12: number
    let comg12: number
    if (shortline) {
      let sbetm2 = sq(sbet1 + sbet2)
      sbetm2 /= sbetm2 + sq(cbet1 + cbet2)
      dnm = Math.sqrt(1 + this.ep2 * sbetm2)
      const omg12 = lam12 / (this.f1 * dnm)
      somg12 = Math.sin(omg12)
      comg12 = Math.cos(omg12)
    } else {
      somg12 = slam12
      comg12 = clam12
    }

    let salp1 = cbet2 * somg12
    let calp1 =
      comg12 >= 0
        ? sbet12 + (cbet2 * sbet1 * sq(somg12)) / (1 + comg12)
        : sbet12a - (cbet2 * sbet1 * sq(somg12)) / (1 - comg12)

    const ssig12 = hypot(salp1, calp1)
    const csig12 = sbet1 * sbet2 + cbet1 * cbet2 * comg12
    if (shortline && ssig12 < this.etol2) {
      // Really short lines.
      salp2 = cbet1 * somg12
      calp2 = sbet12 - cbet1 * sbet2 * (comg12 >= 0 ? sq(somg12) / (1 + comg12) : 1 - comg12)
      ;[salp2, calp2] = norm2(salp2, calp2)
      sig12 = Math.atan2(ssig12, csig12)
    } else if (Math.abs(this.n) >= 0.1 || csig12 >= 0 || ssig12 >= 6 * Math.abs(this.n) * Math.PI * sq(cbet1)) {
      // The zeroth-order spherical approximation is fine.
    } else {
      // Nearly antipodal: scale to a frame with the antipode at the origin.
      const lam12x = Math.atan2(-slam12, -clam12) // lam12 − π
      const k2 = sq(sbet1) * this.ep2
      const eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2)
      const lamscale = this.f * cbet1 * this.A3f(eps) * Math.PI
      const betscale = lamscale * cbet1
      const x = lam12x / lamscale
      const y = sbet12a / betscale
      if (y > -TOL1 && x > -1 - XTHRESH) {
        salp1 = Math.min(1, -x)
        calp1 = -Math.sqrt(1 - sq(salp1))
      } else {
        const k = Geodesic.astroid(x, y)
        const omg12a = lamscale * ((-x * k) / (1 + k))
        somg12 = Math.sin(omg12a)
        comg12 = -Math.cos(omg12a)
        salp1 = cbet2 * somg12
        calp1 = sbet12a - (cbet2 * sbet1 * sq(somg12)) / (1 - comg12)
      }
    }
    if (!(salp1 <= 0)) [salp1, calp1] = norm2(salp1, calp1)
    else {
      salp1 = 1
      calp1 = 0
    }
    return { sig12, salp1, calp1, salp2, calp2, dnm }
  }

  private lambda12(
    sbet1: number,
    cbet1: number,
    dn1: number,
    sbet2: number,
    cbet2: number,
    dn2: number,
    salp1: number,
    calp1: number,
    slam120: number,
    clam120: number,
    diffp: boolean,
  ): Lambda12 {
    if (sbet1 === 0 && calp1 === 0) calp1 = -TINY // break the equatorial degeneracy
    const salp0 = salp1 * cbet1
    const calp0 = hypot(calp1, salp1 * sbet1)

    let ssig1 = sbet1
    const somg1 = salp0 * sbet1
    let csig1 = calp1 * cbet1
    const comg1 = csig1
    ;[ssig1, csig1] = norm2(ssig1, csig1)

    // Enforce symmetries when |bet2| = −bet1.
    const salp2 = cbet2 !== cbet1 ? salp0 / cbet2 : salp1
    const calp2 =
      cbet2 !== cbet1 || Math.abs(sbet2) !== -sbet1
        ? Math.sqrt(
            sq(calp1 * cbet1) + (cbet1 < -sbet1 ? (cbet2 - cbet1) * (cbet1 + cbet2) : (sbet1 - sbet2) * (sbet1 + sbet2)),
          ) / cbet2
        : Math.abs(calp1)
    let ssig2 = sbet2
    const somg2 = salp0 * sbet2
    let csig2 = calp2 * cbet2
    const comg2 = csig2
    ;[ssig2, csig2] = norm2(ssig2, csig2)

    const sig12 = Math.atan2(Math.max(0, csig1 * ssig2 - ssig1 * csig2) + 0, csig1 * csig2 + ssig1 * ssig2)
    const somg12 = Math.max(0, comg1 * somg2 - somg1 * comg2) + 0
    const comg12 = comg1 * comg2 + somg1 * somg2
    const eta = Math.atan2(somg12 * clam120 - comg12 * slam120, comg12 * clam120 + somg12 * slam120)
    const k2 = sq(calp0) * this.ep2
    const eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2)
    this.C3f(eps, this.C3a)
    const B312 = sinCosSeries(true, ssig2, csig2, this.C3a) - sinCosSeries(true, ssig1, csig1, this.C3a)
    const domg12 = -this.f * this.A3f(eps) * salp0 * (sig12 + B312)
    const lam12 = eta + domg12
    let dlam12 = NaN
    if (diffp) {
      if (calp2 === 0) dlam12 = (-2 * this.f1 * dn1) / sbet1
      else {
        const { m12b } = this.lengths(eps, sig12, ssig1, csig1, dn1, ssig2, csig2, dn2, false, true)
        dlam12 = (m12b * this.f1) / (calp2 * cbet2)
      }
    }
    return { lam12, salp2, calp2, sig12, ssig1, csig1, ssig2, csig2, eps, domg12, dlam12 }
  }

  /**
   * The inverse problem: the shortest path between two points (degrees).
   * `area` adds S12, the area between the geodesic and the equator.
   */
  inverse(lat1: number, lon1: number, lat2: number, lon2: number, area = false): InverseResult {
    return this.inverseInt(lat1, lon1, lat2, lon2, area, true)
  }

  /** inverse(), optionally without the distance (s12 NaN) when only the area is needed. */
  private inverseInt(lat1: number, lon1: number, lat2: number, lon2: number, area: boolean, distance: boolean): InverseResult {
    lat1 = angRound(latFix(lat1))
    lat2 = angRound(latFix(lat2))
    let [lon12, lon12s] = angDiff(lon1, lon2)
    // Make the longitude difference positive.
    let lonsign = copysign(1, lon12)
    lon12 *= lonsign
    lon12s *= lonsign
    const lam12 = lon12 * DEGREE
    const [slam12, clam12] = sincosde(lon12, lon12s)
    lon12s = 180 - lon12 - lon12s // the supplementary longitude difference

    // Point 1 gets the larger |latitude|, and is made southern.
    const swapp = Math.abs(lat1) < Math.abs(lat2) || Number.isNaN(lat2) ? -1 : 1
    if (swapp < 0) {
      lonsign *= -1
      const t = lat1
      lat1 = lat2
      lat2 = t
    }
    const latsign = copysign(1, -lat1)
    lat1 *= latsign
    lat2 *= latsign
    // Now 0 ≤ lon12 ≤ 180, −90 ≤ lat1 ≤ −0 and lat1 ≤ lat2 ≤ −lat1.

    let [sbet1, cbet1] = sincosd(lat1)
    sbet1 *= this.f1
    ;[sbet1, cbet1] = norm2(sbet1, cbet1)
    cbet1 = Math.max(TINY, cbet1)
    let [sbet2, cbet2] = sincosd(lat2)
    sbet2 *= this.f1
    ;[sbet2, cbet2] = norm2(sbet2, cbet2)
    cbet2 = Math.max(TINY, cbet2)

    // Force bet2 = ±bet1 exactly when the measures of their difference vanish.
    if (cbet1 < -sbet1) {
      if (cbet2 === cbet1) sbet2 = copysign(sbet1, sbet2)
    } else if (Math.abs(sbet2) === -sbet1) cbet2 = cbet1

    const dn1 = Math.sqrt(1 + this.ep2 * sq(sbet1))
    const dn2 = Math.sqrt(1 + this.ep2 * sq(sbet2))

    let s12x = NaN
    let m12x = NaN
    let sig12 = NaN
    let omg12 = NaN
    let salp1 = NaN
    let calp1 = NaN
    let salp2 = NaN
    let calp2 = NaN
    let somg12 = 2 // 2: not computed yet
    let comg12 = NaN

    let meridian = lat1 === -90 || slam12 === 0
    if (meridian) {
      // Both points on one meridian (or point 1 at a pole).
      calp1 = clam12
      salp1 = slam12
      calp2 = 1
      salp2 = 0
      const ssig1 = sbet1
      const csig1 = calp1 * cbet1
      const ssig2 = sbet2
      const csig2 = calp2 * cbet2
      sig12 = Math.atan2(Math.max(0, csig1 * ssig2 - ssig1 * csig2) + 0, csig1 * csig2 + ssig1 * ssig2)
      const l = this.lengths(this.n, sig12, ssig1, csig1, dn1, ssig2, csig2, dn2, true, true)
      s12x = l.s12b
      m12x = l.m12b
      if (sig12 < 1 || m12x >= 0) {
        if (sig12 < 3 * TINY || (sig12 < TOL0 && (s12x < 0 || m12x < 0))) sig12 = m12x = s12x = 0
        m12x *= this.b
        s12x *= this.b
      } else meridian = false // m12 < 0: nearly antipodal, so not the shortest path
    }

    if (!meridian && sbet1 === 0 && (this.f <= 0 || lon12s >= this.f * 180)) {
      // Along the equator.
      calp1 = calp2 = 0
      salp1 = salp2 = 1
      s12x = this.a * lam12
      sig12 = omg12 = lam12 / this.f1
    } else if (!meridian) {
      const start = this.inverseStart(sbet1, cbet1, sbet2, cbet2, lam12, slam12, clam12)
      sig12 = start.sig12
      salp1 = start.salp1
      calp1 = start.calp1
      if (sig12 >= 0) {
        // Short line: InverseStart has the answer.
        salp2 = start.salp2
        calp2 = start.calp2
        s12x = sig12 * this.b * start.dnm
        omg12 = lam12 / (this.f1 * start.dnm)
      } else {
        // Newton's method on lambda12(alp1) − lam12 = 0, kept inside a bracket.
        let numit = 0
        let salp1a = TINY
        let calp1a = 1
        let salp1b = TINY
        let calp1b = -1
        let tripn = false
        let tripb = false
        let r: Lambda12
        for (; ; ++numit) {
          r = this.lambda12(sbet1, cbet1, dn1, sbet2, cbet2, dn2, salp1, calp1, slam12, clam12, numit < MAXIT1)
          const v = r.lam12
          if (tripb || !(Math.abs(v) >= (tripn ? 8 : 1) * TOL0) || numit === MAXIT2) break
          if (v > 0 && (numit < MAXIT1 || calp1 / salp1 > calp1b / salp1b)) {
            salp1b = salp1
            calp1b = calp1
          } else if (v < 0 && (numit < MAXIT1 || calp1 / salp1 < calp1a / salp1a)) {
            salp1a = salp1
            calp1a = calp1
          }
          if (numit < MAXIT1 && r.dlam12 > 0) {
            const dalp1 = -v / r.dlam12
            if (Math.abs(dalp1) < Math.PI) {
              const sdalp1 = Math.sin(dalp1)
              const cdalp1 = Math.cos(dalp1)
              const nsalp1 = salp1 * cdalp1 + calp1 * sdalp1
              if (nsalp1 > 0) {
                calp1 = calp1 * cdalp1 - salp1 * sdalp1
                salp1 = nsalp1
                ;[salp1, calp1] = norm2(salp1, calp1)
                tripn = Math.abs(v) <= 16 * TOL0
                continue
              }
            }
          }
          // Bisect the bracket.
          salp1 = (salp1a + salp1b) / 2
          calp1 = (calp1a + calp1b) / 2
          ;[salp1, calp1] = norm2(salp1, calp1)
          tripn = false
          tripb = Math.abs(salp1a - salp1) + (calp1a - calp1) < TOLB || Math.abs(salp1 - salp1b) + (calp1 - calp1b) < TOLB
        }
        salp2 = r.salp2
        calp2 = r.calp2
        sig12 = r.sig12
        if (distance) {
          const l = this.lengths(r.eps, sig12, r.ssig1, r.csig1, dn1, r.ssig2, r.csig2, dn2, true, false)
          s12x = l.s12b * this.b
        }
        if (area) {
          // omg12 = lam12 − domg12
          const sdomg12 = Math.sin(r.domg12)
          const cdomg12 = Math.cos(r.domg12)
          somg12 = slam12 * cdomg12 - clam12 * sdomg12
          comg12 = clam12 * cdomg12 + slam12 * sdomg12
        }
      }
    }

    const s12 = 0 + s12x // −0 → 0

    let S12 = NaN
    if (area) {
      const salp0 = salp1 * cbet1
      const calp0 = hypot(calp1, salp1 * sbet1)
      if (calp0 !== 0 && salp0 !== 0) {
        let ssig1 = sbet1
        let csig1 = calp1 * cbet1
        let ssig2 = sbet2
        let csig2 = calp2 * cbet2
        const k2 = sq(calp0) * this.ep2
        const eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2)
        const A4 = sq(this.a) * calp0 * salp0 * this.e2
        ;[ssig1, csig1] = norm2(ssig1, csig1)
        ;[ssig2, csig2] = norm2(ssig2, csig2)
        this.C4f(eps, this.C4a)
        S12 = A4 * (sinCosSeries(false, ssig2, csig2, this.C4a) - sinCosSeries(false, ssig1, csig1, this.C4a))
      } else S12 = 0 // sig1, sig2 indeterminate on the equator
      if (!meridian && somg12 === 2) {
        somg12 = Math.sin(omg12)
        comg12 = Math.cos(omg12)
      }
      let alp12: number
      if (!meridian && comg12 > -0.7071 && sbet2 - sbet1 < 1.75) {
        // tan(Γ/2) = tan(omg12/2) (tan(bet1/2) + tan(bet2/2)) / (1 + tan(bet1/2) tan(bet2/2))
        const domg12 = 1 + comg12
        const dbet1 = 1 + cbet1
        const dbet2 = 1 + cbet2
        alp12 = 2 * Math.atan2(somg12 * (sbet1 * dbet2 + sbet2 * dbet1), domg12 * (sbet1 * sbet2 + dbet1 * dbet2))
      } else {
        let salp12 = salp2 * calp1 - calp2 * salp1
        let calp12 = calp2 * calp1 + salp2 * salp1
        if (salp12 === 0 && calp12 < 0) {
          salp12 = TINY * calp1
          calp12 = -1
        }
        alp12 = Math.atan2(salp12, calp12)
      }
      S12 += this.c2 * alp12
      S12 *= swapp * lonsign * latsign
      S12 += 0
    }

    if (swapp < 0) {
      let t = salp1
      salp1 = salp2
      salp2 = t
      t = calp1
      calp1 = calp2
      calp2 = t
    }
    salp1 *= swapp * lonsign
    calp1 *= swapp * latsign
    salp2 *= swapp * lonsign
    calp2 *= swapp * latsign
    return { s12, azi1: atan2d(salp1, calp1), azi2: atan2d(salp2, calp2), S12 }
  }

  /** The direct problem: where you end up going s12 metres from a point on azimuth azi1 (degrees). */
  direct(lat1: number, lon1: number, azi1: number, s12: number): DirectResult {
    const { C1a, C1pa, C3a } = this
    lat1 = latFix(lat1)
    const [salp1, calp1] = sincosd(angRound(angNormalize(azi1)))
    let [sbet1, cbet1] = sincosd(angRound(lat1))
    sbet1 *= this.f1
    ;[sbet1, cbet1] = norm2(sbet1, cbet1)
    cbet1 = Math.max(TINY, cbet1)

    const salp0 = salp1 * cbet1 // alp0 in [0, π/2 − |bet1|]
    const calp0 = hypot(calp1, salp1 * sbet1)
    let ssig1 = sbet1
    const somg1 = salp0 * sbet1
    let csig1 = sbet1 !== 0 || calp1 !== 0 ? cbet1 * calp1 : 1
    const comg1 = csig1
    ;[ssig1, csig1] = norm2(ssig1, csig1)

    const k2 = sq(calp0) * this.ep2
    const eps = k2 / (2 * (1 + Math.sqrt(1 + k2)) + k2)
    const A1m1 = A1m1f(eps)
    evenSeries(C1_COEFF, nC1, eps, C1a)
    const B11 = sinCosSeries(true, ssig1, csig1, C1a)
    let s = Math.sin(B11)
    let c = Math.cos(B11)
    const stau1 = ssig1 * c + csig1 * s
    const ctau1 = csig1 * c - ssig1 * s
    evenSeries(C1P_COEFF, nC1p, eps, C1pa)
    this.C3f(eps, C3a)
    const A3c = -this.f * salp0 * this.A3f(eps)
    const B31 = sinCosSeries(true, ssig1, csig1, C3a)

    const tau12 = s12 / (this.b * (1 + A1m1))
    s = Math.sin(tau12)
    c = Math.cos(tau12)
    const B12 = -sinCosSeries(true, stau1 * c + ctau1 * s, ctau1 * c - stau1 * s, C1pa)
    let sig12 = tau12 - (B12 - B11)
    let ssig12 = Math.sin(sig12)
    let csig12 = Math.cos(sig12)
    if (Math.abs(this.f) > 0.01) {
      // The reverted series is inaccurate for |f| > 1/100: one Newton step.
      const ssig2 = ssig1 * csig12 + csig1 * ssig12
      const csig2 = csig1 * csig12 - ssig1 * ssig12
      const B12b = sinCosSeries(true, ssig2, csig2, C1a)
      const serr = (1 + A1m1) * (sig12 + (B12b - B11)) - s12 / this.b
      sig12 -= serr / Math.sqrt(1 + k2 * sq(ssig2))
      ssig12 = Math.sin(sig12)
      csig12 = Math.cos(sig12)
    }

    const ssig2 = ssig1 * csig12 + csig1 * ssig12
    let csig2 = csig1 * csig12 - ssig1 * ssig12
    const sbet2 = calp0 * ssig2
    let cbet2 = hypot(salp0, calp0 * csig2)
    if (cbet2 === 0) cbet2 = csig2 = TINY
    const salp2 = salp0
    const calp2 = calp0 * csig2
    const somg2 = salp0 * ssig2
    const comg2 = csig2
    const omg12 = Math.atan2(somg2 * comg1 - comg2 * somg1, comg2 * comg1 + somg2 * somg1)
    const lam12 = omg12 + A3c * (sig12 + (sinCosSeries(true, ssig2, csig2, C3a) - B31))
    return {
      lat2: atan2d(sbet2, this.f1 * cbet2),
      lon2: angNormalize(angNormalize(lon1) + angNormalize(lam12 / DEGREE)),
      azi2: atan2d(salp2, calp2),
    }
  }

  /**
   * Area and perimeter of a polygon with geodesic edges, as GeographicLib's
   * PolygonArea: vertices in order, closed implicitly, [lat, lon] (or
   * [lon, lat] with `lonLat`, GeoJSON's order). The area is signed, positive
   * when the vertices go anticlockwise, and in (−total/2, total/2], so the
   * small polygon you mean wins either way. `perimeter: false` skips the
   * perimeter (NaN), about 15% faster.
   */
  polygon(
    vertices: readonly (readonly number[])[],
    { lonLat = false, perimeter = true }: { lonLat?: boolean; perimeter?: boolean } = {},
  ): { area: number; perimeter: number } {
    const num = vertices.length
    if (num < 2) return { area: 0, perimeter: 0 }
    const iy = lonLat ? 1 : 0
    const ix = 1 - iy
    const areaSum = new Accumulator()
    const perimeterSum = new Accumulator()
    let crossings = 0
    for (let i = 0; i < num; i++) {
      const p = vertices[i]
      const q = vertices[i + 1 < num ? i + 1 : 0]
      const r = this.inverseInt(p[iy], p[ix], q[iy], q[ix], true, perimeter)
      if (perimeter) perimeterSum.add(r.s12)
      areaSum.add(r.S12)
      crossings += transit(p[ix], q[ix])
    }
    // AreaReduceA(reverse = false, sign = true)
    const area0 = this.totalArea
    areaSum.remainder(area0)
    if (crossings & 1) areaSum.add(((areaSum.s < 0 ? 1 : -1) * area0) / 2)
    areaSum.negate() // clockwise sense → anticlockwise positive
    if (areaSum.s > area0 / 2) areaSum.add(-area0)
    else if (areaSum.s <= -area0 / 2) areaSum.add(area0)
    return { area: 0 + areaSum.s, perimeter: perimeter ? perimeterSum.s : NaN }
  }
}

/** ±1 when an edge crosses the prime meridian eastward / westward, else 0. */
function transit(lon1: number, lon2: number): number {
  const [lon12] = angDiff(lon1, lon2)
  lon1 = angNormalize(lon1)
  lon2 = angNormalize(lon2)
  return lon12 > 0 && ((lon1 < 0 && lon2 >= 0) || (lon1 > 0 && lon2 === 0))
    ? 1
    : lon12 < 0 && lon1 >= 0 && lon2 < 0
      ? -1
      : 0
}

// ---------- WGS84, in the app's [lng, lat] order ----------

export const WGS84_A = 6378137
export const WGS84_F = 1 / 298.257223563
export const WGS84 = new Geodesic(WGS84_A, WGS84_F)

/** Shortest distance between two [lng, lat] positions on the ellipsoid, metres. */
export function distanceM(a: Position, b: Position): number {
  return WGS84.inverse(a[1], a[0], b[1], b[0]).s12
}

/** Initial azimuth from a to b, degrees clockwise from true north, 0–360. */
export function azimuthDeg(a: Position, b: Position): number {
  const azi = WGS84.inverse(a[1], a[0], b[1], b[0]).azi1
  return azi < 0 ? azi + 360 : azi
}

/** Length of a [lng, lat] path, metres. */
export function lengthM(path: readonly Position[]): number {
  let total = 0
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i])
  return total
}

/** Area of a [lng, lat] ring (closed implicitly, either direction), m². Holes are the caller's. */
export function ringAreaM2(ring: readonly Position[]): number {
  if (ring.length < 3) return 0
  return Math.abs(WGS84.polygon(ring, { lonLat: true, perimeter: false }).area)
}

/** The [lng, lat] reached going `distance` metres from `start` on initial azimuth `azimuth` (degrees true). */
export function destination(start: Position, azimuth: number, distance: number): Position {
  const r = WGS84.direct(start[1], start[0], azimuth, distance)
  return [r.lon2, r.lat2]
}

/**
 * Metres per degree east and north at a latitude: the scale of a local
 * east/north frame, true at that latitude (prime vertical and meridional
 * radii of curvature). For local flat maths over a few km, such as distance
 * to a line or a buffer.
 */
export function metresPerDegree(lat: number): { east: number; north: number } {
  const { meridional, primeVertical } = WGS84.radiiOfCurvature(lat)
  return { east: primeVertical * Math.abs(sincosd(lat)[1]) * DEGREE, north: meridional * DEGREE }
}
