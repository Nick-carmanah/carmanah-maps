import type { Position } from 'geojson'

/**
 * BC Albers (EPSG:3005, NAD83): the Province's standard projection for GIS
 * data. Albers equal-area conic on GRS80, Snyder's ellipsoidal formulas
 * ("Map Projections — A Working Manual", 1987, pp. 101-102).
 *
 * proj4's definition, which these match to well under a millimetre:
 *   +proj=aea +lat_0=45 +lon_0=-126 +lat_1=50 +lat_2=58.5
 *   +x_0=1000000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0 +units=m
 * NAD83 and WGS84 differ by ~1-2 m in BC; like proj4 (towgs84=0) we treat
 * them as the same, which is well inside phone-GPS accuracy.
 */

const A = 6378137
const F = 1 / 298.257222101 // GRS80
const E2 = F * (2 - F)
const E = Math.sqrt(E2)

const LAT0 = 45
const LON0 = -126
const LAT1 = 50
const LAT2 = 58.5
const X0 = 1_000_000
const Y0 = 0

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

function mOf(phi: number): number {
  const s = Math.sin(phi)
  return Math.cos(phi) / Math.sqrt(1 - E2 * s * s)
}

function qOf(phi: number): number {
  const s = Math.sin(phi)
  return (
    (1 - E2) *
    (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)))
  )
}

const M1 = mOf(rad(LAT1))
const M2 = mOf(rad(LAT2))
const Q0 = qOf(rad(LAT0))
const Q1 = qOf(rad(LAT1))
const Q2 = qOf(rad(LAT2))
const N = (M1 * M1 - M2 * M2) / (Q2 - Q1)
const C = M1 * M1 + N * Q1
const RHO0 = (A * Math.sqrt(C - N * Q0)) / N
/** q at the pole: the largest |q| the inverse can accept. */
const QP = qOf(Math.PI / 2)

export interface Albers {
  easting: number
  northing: number
}

export function toBcAlbers(lat: number, lon: number): Albers {
  const rho = (A * Math.sqrt(C - N * qOf(rad(lat)))) / N
  const theta = N * rad(lon - LON0)
  return {
    easting: X0 + rho * Math.sin(theta),
    northing: Y0 + RHO0 - rho * Math.cos(theta),
  }
}

/** [lon, lat], or null for numbers that aren't on the projection. */
export function fromBcAlbers(easting: number, northing: number): Position | null {
  const x = easting - X0
  const y = RHO0 - (northing - Y0)
  const rho = Math.hypot(x, y)
  const q = (C - (rho * rho * N * N) / (A * A)) / N
  if (!Number.isFinite(q) || Math.abs(q) > Math.abs(QP)) return null
  const theta = Math.atan2(x, y)
  const lon = LON0 + deg(theta / N)

  // Iterate for latitude (Snyder eq. 3-16); converges in a few steps.
  let phi = Math.asin(q / 2)
  for (let i = 0; i < 15; i++) {
    const s = Math.sin(phi)
    const one = 1 - E2 * s * s
    const dphi =
      ((one * one) / (2 * Math.cos(phi))) *
      (q / (1 - E2) - s / one + (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)))
    phi += dphi
    if (Math.abs(dphi) < 1e-12) break
  }
  const lat = deg(phi)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return [lon, lat]
}

/** Roughly BC plus a margin: where BC Albers numbers make sense to type. */
export function inBcAlbersArea([lon, lat]: Position): boolean {
  return lat >= 44 && lat <= 64 && lon >= -145 && lon <= -108
}
