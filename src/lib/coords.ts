import * as mgrs from 'mgrs'
import type { Position } from 'geojson'

export type CoordFormat = 'dd' | 'dms' | 'utm' | 'mgrs'

export const COORD_FORMATS: CoordFormat[] = ['dd', 'dms', 'utm', 'mgrs']

export const FORMAT_LABELS: Record<CoordFormat, string> = {
  dd: 'DD',
  dms: 'DMS',
  utm: 'UTM',
  mgrs: 'MGRS',
}

// ---- UTM (WGS84 Transverse Mercator, standard Snyder series) ----

const A = 6378137
const F = 1 / 298.257223563
const K0 = 0.9996
const E2 = F * (2 - F)
const EP2 = E2 / (1 - E2)
const E4 = E2 * E2
const E6 = E4 * E2

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

const BANDS = 'CDEFGHJKLMNPQRSTUVWX'

export function latBand(lat: number): string {
  if (lat < -80 || lat > 84) return ''
  return BANDS[Math.min(19, Math.floor((lat + 80) / 8))]
}

export interface Utm {
  zone: number
  band: string
  easting: number
  northing: number
}

export function toUtm(lat: number, lon: number): Utm | null {
  if (lat < -80 || lat > 84) return null
  const zone = Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1))
  const lam0 = rad(zone * 6 - 183)
  const phi = rad(lat)
  const lam = rad(lon)

  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const tanPhi = Math.tan(phi)

  const n = A / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  const t = tanPhi * tanPhi
  const c = EP2 * cosPhi * cosPhi
  const a = cosPhi * (lam - lam0)

  const m =
    A *
    ((1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256) * phi -
      ((3 * E2) / 8 + (3 * E4) / 32 + (45 * E6) / 1024) * Math.sin(2 * phi) +
      ((15 * E4) / 256 + (45 * E6) / 1024) * Math.sin(4 * phi) -
      ((35 * E6) / 3072) * Math.sin(6 * phi))

  const easting =
    K0 *
      n *
      (a +
        ((1 - t + c) * a ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120) +
    500000

  let northing =
    K0 *
    (m +
      n *
        tanPhi *
        (a ** 2 / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720))
  if (lat < 0) northing += 10000000

  return { zone, band: latBand(lat), easting, northing }
}

export function fromUtm(utm: Utm): Position {
  const { zone, band } = utm
  let { northing } = utm
  const southern = band ? band.toUpperCase() < 'N' : false
  if (southern) northing -= 10000000

  const x = utm.easting - 500000
  const m = northing / K0
  const mu = m / (A * (1 - E2 / 4 - (3 * E4) / 64 - (5 * E6) / 256))

  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2))
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu)

  const sinPhi1 = Math.sin(phi1)
  const cosPhi1 = Math.cos(phi1)
  const tanPhi1 = Math.tan(phi1)

  const n1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1)
  const t1 = tanPhi1 * tanPhi1
  const c1 = EP2 * cosPhi1 * cosPhi1
  const r1 = (A * (1 - E2)) / (1 - E2 * sinPhi1 * sinPhi1) ** 1.5
  const d = x / (n1 * K0)

  const lat = deg(
    phi1 -
      ((n1 * tanPhi1) / r1) *
        (d ** 2 / 2 -
          ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4) / 24 +
          ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6) /
            720),
  )
  const lon =
    zone * 6 -
    183 +
    deg(
      (d -
        ((1 + 2 * t1 + c1) * d ** 3) / 6 +
        ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5) / 120) /
        cosPhi1,
    )
  return [lon, lat]
}

// ---- Formatting ----

function toDms(value: number, isLat: boolean): string {
  const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W'
  const abs = Math.abs(value)
  const d = Math.floor(abs)
  const mFloat = (abs - d) * 60
  const min = Math.floor(mFloat)
  const s = (mFloat - min) * 60
  return `${d}°${String(min).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${hemi}`
}

export function formatCoord([lng, lat]: Position, fmt: CoordFormat): string {
  switch (fmt) {
    case 'dd':
      return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    case 'dms':
      return `${toDms(lat, true)} ${toDms(lng, false)}`
    case 'utm': {
      const u = toUtm(lat, lng)
      return u
        ? `${u.zone}${u.band} ${Math.round(u.easting)}E ${Math.round(u.northing)}N`
        : 'outside UTM'
    }
    case 'mgrs':
      try {
        return mgrs.forward([lng, lat], 5)
      } catch {
        return 'outside MGRS'
      }
  }
}

// ---- Parsing (search input) ----

/** Parse "50.223, -121.552", DMS, UTM ("10U 601500 5564000"), or MGRS. */
export function parseCoordinate(input: string): Position | null {
  const s = input.trim()
  if (!s) return null

  // MGRS: e.g. 10UFA1500064000 (with or without spaces)
  const compact = s.replace(/\s+/g, '').toUpperCase()
  if (/^\d{1,2}[C-X][A-HJ-NP-Z]{2}(\d{2,10})$/.test(compact)) {
    try {
      const [lng, lat] = mgrs.toPoint(compact)
      return [lng, lat]
    } catch {
      return null
    }
  }

  // UTM: zone + band + easting + northing
  const utmMatch = /^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)$/i.exec(s)
  if (utmMatch) {
    const [, zone, band, e, n] = utmMatch
    return fromUtm({
      zone: Number(zone),
      band: band.toUpperCase(),
      easting: Number(e),
      northing: Number(n),
    })
  }

  // DMS: 50°13'23"N 121°34'52"W (accepts ° ' " or spaces)
  if (/[°'"]/.test(s)) {
    const parts = s.match(/(\d+(?:\.\d+)?)[°\s]+(\d+(?:\.\d+)?)?['\s]*(\d+(?:\.\d+)?)?"?\s*([NSEW])/gi)
    if (parts && parts.length === 2) {
      const values = parts.map((p) => {
        const m = /(\d+(?:\.\d+)?)[°\s]+(?:(\d+(?:\.\d+)?)['\s]*)?(?:(\d+(?:\.\d+)?)"?\s*)?([NSEW])/i.exec(p)!
        const value = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600
        const hemi = m[4].toUpperCase()
        return { value: /[SW]/.test(hemi) ? -value : value, isLat: /[NS]/.test(hemi) }
      })
      const lat = values.find((v) => v.isLat)
      const lon = values.find((v) => !v.isLat)
      if (lat && lon) return [lon.value, lat.value]
    }
    return null
  }

  // Decimal degrees: "lat, lon" (optionally with N/S/E/W suffixes)
  const ddMatch =
    /^(-?\d+(?:\.\d+)?)\s*([NS])?[,\s]+(-?\d+(?:\.\d+)?)\s*([EW])?$/i.exec(s)
  if (ddMatch) {
    let lat = Number(ddMatch[1])
    let lon = Number(ddMatch[3])
    if (ddMatch[2]?.toUpperCase() === 'S') lat = -Math.abs(lat)
    if (ddMatch[4]?.toUpperCase() === 'W') lon = -Math.abs(lon)
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lon, lat]
  }
  return null
}
