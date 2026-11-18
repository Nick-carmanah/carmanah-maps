/**
 * Magnetic declination from the World Magnetic Model (WMM2025), computed on
 * the phone so magnetic bearings work with no signal.
 *
 * The coefficients below are NOAA NCEI's WMM.COF for WMM2025, verbatim
 * (US Government work, public domain): https://www.ncei.noaa.gov/products/world-magnetic-model
 * WMM2025 is valid from 2025.0 to 2030.0. For WMM2030, paste the new file
 * over WMM_COF, update the constants below, and re-check against the test
 * values NOAA ships with the coefficients.
 *
 * Algorithm: the WMM technical report (NOAA/BGS, "The US/UK World Magnetic
 * Model for 2025-2030", §1.2): geodetic → geocentric coordinates, Schmidt
 * semi-normalised associated Legendre functions to degree 12, field vector
 * rotated back to the ellipsoid, declination = atan2(Y, X).
 */

// prettier-ignore
const WMM_COF = `
    2025.0            WMM-2025     11/13/2024
  1  0  -29351.8       0.0       12.0        0.0
  1  1   -1410.8    4545.4        9.7      -21.5
  2  0   -2556.6       0.0      -11.6        0.0
  2  1    2951.1   -3133.6       -5.2      -27.7
  2  2    1649.3    -815.1       -8.0      -12.1
  3  0    1361.0       0.0       -1.3        0.0
  3  1   -2404.1     -56.6       -4.2        4.0
  3  2    1243.8     237.5        0.4       -0.3
  3  3     453.6    -549.5      -15.6       -4.1
  4  0     895.0       0.0       -1.6        0.0
  4  1     799.5     278.6       -2.4       -1.1
  4  2      55.7    -133.9       -6.0        4.1
  4  3    -281.1     212.0        5.6        1.6
  4  4      12.1    -375.6       -7.0       -4.4
  5  0    -233.2       0.0        0.6        0.0
  5  1     368.9      45.4        1.4       -0.5
  5  2     187.2     220.2        0.0        2.2
  5  3    -138.7    -122.9        0.6        0.4
  5  4    -142.0      43.0        2.2        1.7
  5  5      20.9     106.1        0.9        1.9
  6  0      64.4       0.0       -0.2        0.0
  6  1      63.8     -18.4       -0.4        0.3
  6  2      76.9      16.8        0.9       -1.6
  6  3    -115.7      48.8        1.2       -0.4
  6  4     -40.9     -59.8       -0.9        0.9
  6  5      14.9      10.9        0.3        0.7
  6  6     -60.7      72.7        0.9        0.9
  7  0      79.5       0.0       -0.0        0.0
  7  1     -77.0     -48.9       -0.1        0.6
  7  2      -8.8     -14.4       -0.1        0.5
  7  3      59.3      -1.0        0.5       -0.8
  7  4      15.8      23.4       -0.1        0.0
  7  5       2.5      -7.4       -0.8       -1.0
  7  6     -11.1     -25.1       -0.8        0.6
  7  7      14.2      -2.3        0.8       -0.2
  8  0      23.2       0.0       -0.1        0.0
  8  1      10.8       7.1        0.2       -0.2
  8  2     -17.5     -12.6        0.0        0.5
  8  3       2.0      11.4        0.5       -0.4
  8  4     -21.7      -9.7       -0.1        0.4
  8  5      16.9      12.7        0.3       -0.5
  8  6      15.0       0.7        0.2       -0.6
  8  7     -16.8      -5.2       -0.0        0.3
  8  8       0.9       3.9        0.2        0.2
  9  0       4.6       0.0       -0.0        0.0
  9  1       7.8     -24.8       -0.1       -0.3
  9  2       3.0      12.2        0.1        0.3
  9  3      -0.2       8.3        0.3       -0.3
  9  4      -2.5      -3.3       -0.3        0.3
  9  5     -13.1      -5.2        0.0        0.2
  9  6       2.4       7.2        0.3       -0.1
  9  7       8.6      -0.6       -0.1       -0.2
  9  8      -8.7       0.8        0.1        0.4
  9  9     -12.9      10.0       -0.1        0.1
 10  0      -1.3       0.0        0.1        0.0
 10  1      -6.4       3.3        0.0        0.0
 10  2       0.2       0.0        0.1       -0.0
 10  3       2.0       2.4        0.1       -0.2
 10  4      -1.0       5.3       -0.0        0.1
 10  5      -0.6      -9.1       -0.3       -0.1
 10  6      -0.9       0.4        0.0        0.1
 10  7       1.5      -4.2       -0.1        0.0
 10  8       0.9      -3.8       -0.1       -0.1
 10  9      -2.7       0.9       -0.0        0.2
 10 10      -3.9      -9.1       -0.0       -0.0
 11  0       2.9       0.0        0.0        0.0
 11  1      -1.5       0.0       -0.0       -0.0
 11  2      -2.5       2.9        0.0        0.1
 11  3       2.4      -0.6        0.0       -0.0
 11  4      -0.6       0.2        0.0        0.1
 11  5      -0.1       0.5       -0.1       -0.0
 11  6      -0.6      -0.3        0.0       -0.0
 11  7      -0.1      -1.2       -0.0        0.1
 11  8       1.1      -1.7       -0.1       -0.0
 11  9      -1.0      -2.9       -0.1        0.0
 11 10      -0.2      -1.8       -0.1        0.0
 11 11       2.6      -2.3       -0.1        0.0
 12  0      -2.0       0.0        0.0        0.0
 12  1      -0.2      -1.3        0.0       -0.0
 12  2       0.3       0.7       -0.0        0.0
 12  3       1.2       1.0       -0.0       -0.1
 12  4      -1.3      -1.4       -0.0        0.1
 12  5       0.6      -0.0       -0.0       -0.0
 12  6       0.6       0.6        0.1       -0.0
 12  7       0.5      -0.1       -0.0       -0.0
 12  8      -0.1       0.8        0.0        0.0
 12  9      -0.4       0.1        0.0       -0.0
 12 10      -0.2      -1.0       -0.1       -0.0
 12 11      -1.3       0.1       -0.0        0.0
 12 12      -0.7       0.2       -0.1       -0.1
`

/** Model epoch and end of validity (decimal years). */
export const WMM_EPOCH = 2025.0
export const WMM_VALID_UNTIL = 2030.0
export const WMM_NAME = 'WMM2025'

const MAX_N = 12
/** Geomagnetic reference radius, km. */
const RE = 6371.2
// WGS84 ellipsoid, km.
const WGS_A = 6378.137
const WGS_F = 1 / 298.257223563
const WGS_E2 = WGS_F * (2 - WGS_F)

interface Coefficients {
  g: number[][]
  h: number[][]
  gDot: number[][]
  hDot: number[][]
}

let coefficients: Coefficients | null = null

function grid(): number[][] {
  return Array.from({ length: MAX_N + 1 }, () => new Array<number>(MAX_N + 1).fill(0))
}

function loadCoefficients(): Coefficients {
  if (coefficients) return coefficients
  const c: Coefficients = { g: grid(), h: grid(), gDot: grid(), hDot: grid() }
  const lines = WMM_COF.trim().split('\n').slice(1) // skip the header line
  for (const line of lines) {
    const [n, m, g, h, gDot, hDot] = line.trim().split(/\s+/).map(Number)
    c.g[n][m] = g
    c.h[n][m] = h
    c.gDot[n][m] = gDot
    c.hDot[n][m] = hDot
  }
  coefficients = c
  return c
}

/** Date → decimal year, e.g. 1 July 2026 ≈ 2026.497. */
export function decimalYear(date: Date): number {
  const y = date.getUTCFullYear()
  const start = Date.UTC(y, 0, 1)
  const end = Date.UTC(y + 1, 0, 1)
  return y + (date.getTime() - start) / (end - start)
}

export interface MagneticField {
  /** North, east and down components, nT. */
  x: number
  y: number
  z: number
  /** Declination, degrees: positive = magnetic north is east of true north. */
  declination: number
  /** Inclination (dip), degrees, positive down. */
  inclination: number
}

/**
 * Main field at a place and time. lat/lon geodetic degrees (WGS84), height
 * above the ellipsoid in km, time as a decimal year.
 */
export function magneticField(
  lat: number,
  lon: number,
  heightKm: number,
  year: number,
): MagneticField {
  const { g, h, gDot, hDot } = loadCoefficients()
  const dt = year - WMM_EPOCH

  // Geodetic → geocentric spherical.
  const phi = (lat * Math.PI) / 180
  const lambda = (lon * Math.PI) / 180
  const sinPhi = Math.sin(phi)
  const rc = WGS_A / Math.sqrt(1 - WGS_E2 * sinPhi * sinPhi)
  const p = (rc + heightKm) * Math.cos(phi)
  const zc = (rc * (1 - WGS_E2) + heightKm) * sinPhi
  const r = Math.hypot(p, zc)
  const phiC = Math.asin(zc / r)

  // Schmidt semi-normalised P(n,m) and dP/dθ, θ = geocentric colatitude.
  const cosT = Math.sin(phiC)
  const sinT = Math.cos(phiC)
  const P = grid()
  const dP = grid()
  P[0][0] = 1
  for (let n = 1; n <= MAX_N; n++) {
    for (let m = 0; m <= n; m++) {
      if (n === m) {
        const k = n === 1 ? 1 : Math.sqrt((2 * n - 1) / (2 * n))
        P[n][n] = k * sinT * P[n - 1][n - 1]
        dP[n][n] = k * (cosT * P[n - 1][n - 1] + sinT * dP[n - 1][n - 1])
      } else {
        const k1 = Math.sqrt(n * n - m * m)
        const k2 = n >= 2 ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0
        const pPrev2 = n >= 2 ? P[n - 2][m] : 0
        const dPPrev2 = n >= 2 ? dP[n - 2][m] : 0
        P[n][m] = ((2 * n - 1) * cosT * P[n - 1][m] - k2 * pPrev2) / k1
        dP[n][m] =
          ((2 * n - 1) * (cosT * dP[n - 1][m] - sinT * P[n - 1][m]) - k2 * dPPrev2) / k1
      }
    }
  }

  // Field in the geocentric frame: X' north, Y' east, Z' down.
  let xc = 0
  let yc = 0
  let zcF = 0
  for (let n = 1; n <= MAX_N; n++) {
    const ratio = (RE / r) ** (n + 2)
    for (let m = 0; m <= n; m++) {
      const gnm = g[n][m] + dt * gDot[n][m]
      const hnm = h[n][m] + dt * hDot[n][m]
      const cosM = Math.cos(m * lambda)
      const sinM = Math.sin(m * lambda)
      const a = gnm * cosM + hnm * sinM
      xc += ratio * a * dP[n][m]
      yc += ratio * m * (gnm * sinM - hnm * cosM) * P[n][m]
      zcF -= ratio * (n + 1) * a * P[n][m]
    }
  }
  // Y' divides by sin(colatitude); undefined exactly at the geographic poles.
  yc = sinT > 1e-10 ? yc / sinT : 0

  // Rotate to the ellipsoid (geodetic) frame.
  const psi = phiC - phi
  const x = xc * Math.cos(psi) - zcF * Math.sin(psi)
  const z = xc * Math.sin(psi) + zcF * Math.cos(psi)
  const y = yc

  return {
    x,
    y,
    z,
    declination: (Math.atan2(y, x) * 180) / Math.PI,
    inclination: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
  }
}

/** Declination at ground level (degrees, east positive) for a date. */
export function declinationDeg(lat: number, lon: number, date: Date = new Date()): number {
  return magneticField(lat, lon, 0, decimalYear(date)).declination
}

/** False once the model has run past its five-year life: the app needs updating. */
export function wmmIsCurrent(date: Date = new Date()): boolean {
  const y = decimalYear(date)
  return y >= WMM_EPOCH && y < WMM_VALID_UNTIL
}
