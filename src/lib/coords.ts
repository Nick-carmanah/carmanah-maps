import * as mgrs from 'mgrs'
import type { Position } from 'geojson'
import { fromBcAlbers, inBcAlbersArea, toBcAlbers } from './albers'

export type CoordFormat = 'dd' | 'ddm' | 'dms' | 'utm' | 'mgrs' | 'bcalbers'

export const COORD_FORMATS: CoordFormat[] = ['dd', 'ddm', 'dms', 'utm', 'mgrs', 'bcalbers']

/** Short labels, for the readout's format button. */
export const FORMAT_LABELS: Record<CoordFormat, string> = {
  dd: 'DD',
  ddm: 'DDM',
  dms: 'DMS',
  utm: 'UTM',
  mgrs: 'MGRS',
  bcalbers: 'ALBERS',
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

export function toUtm(lat: number, lon: number, forceZone?: number): Utm | null {
  if (lat < -80 || lat > 84) return null
  const zone = forceZone ?? Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1))
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

/** Degree decimal minutes — the BCWS field standard. */
function toDdm(value: number, isLat: boolean): string {
  const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W'
  // Round once, in thousandths of a minute, so 59.9996' carries to the degree.
  const t = Math.round(Math.abs(value) * 60_000)
  const d = Math.floor(t / 60_000)
  const min = (t % 60_000) / 1000
  return `${d}°${min.toFixed(3).padStart(6, '0')}'${hemi}`
}

function toDms(value: number, isLat: boolean): string {
  const hemi = isLat ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W'
  // Round once, in tenths of a second, so 59.96" carries to the minute.
  const t = Math.round(Math.abs(value) * 36_000)
  const d = Math.floor(t / 36_000)
  const min = Math.floor((t % 36_000) / 600)
  const s = (t % 600) / 10
  return `${d}°${String(min).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${hemi}`
}

export function formatCoord([lng, lat]: Position, fmt: CoordFormat): string {
  switch (fmt) {
    case 'dd':
      return `${lat.toFixed(5)}, ${lng.toFixed(5)}`
    case 'ddm':
      return `${toDdm(lat, true)} ${toDdm(lng, false)}`
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
    case 'bcalbers': {
      const a = toBcAlbers(lat, lng)
      return `${Math.round(a.easting)}E ${Math.round(a.northing)}N`
    }
  }
}


// ---- Parsing (search input) ----
//
// "Find by coordinates" takes every format the app can show, whatever the
// readout is set to:
//   DD    50.22305, -121.55211   ·   50.22305N 121.55211W
//   DDM   50°13.383'N 121°34.867'W   ·   N50 13.383 W121 34.867
//   DMS   50°13'23.0"N 121°34'52.0"W   ·   50 13 23 N 121 34 52 W
//   UTM   10U 601500E 5564000N   ·   10 601500 5564000   ·   Zone 10 E601500 N5564000
//   MGRS  10UFA0150064000   ·   10U FA 01500 64000
//   BC Albers  1195328E 382812N   ·   BC Albers 1195328 382812

/** Two numbers with optional E/N tags (before or after). E-then-N unless tagged. */
const NUM = String.raw`(\d+(?:\.\d+)?)\s*(?:M\s*)?`
// "E601500 N5564000": both tags in front.
const EN_PREFIX = new RegExp(String.raw`^([EN])\s*${NUM}[,;/]?\s*([EN])\s*${NUM}$`)
// "601500E 5564000N", "601500 5564000", "601500E5564000N": tags (if any) after.
const EN_SUFFIX = new RegExp(
  String.raw`^${NUM}([EN])?(?:\s*[,;/]\s*|\s+|(?<=[EN]))${NUM}([EN])?$`,
)

function parseEastingNorthing(s: string): { e: number; n: number } | null {
  const m = EN_PREFIX.exec(s) ?? EN_SUFFIX.exec(s)
  if (!m) return null
  const prefixed = /^[EN]/.test(s)
  const [first, a, second, b] = prefixed ? [m[1], m[2], m[3], m[4]] : [m[2], m[1], m[4], m[3]]
  if (first && first === second) return null
  return first === 'N' || second === 'E'
    ? { e: Number(b), n: Number(a) }
    : { e: Number(a), n: Number(b) }
}

function parseMgrs(s: string): Position | null {
  const compact = s.replace(/^MGRS\s*/, '').replace(/\s+/g, '')
  const m = /^\d{1,2}[C-HJ-NP-X][A-HJ-NP-Z]{2}(\d*)$/.exec(compact)
  if (!m || m[1].length % 2 || m[1].length > 10) return null
  try {
    const [lng, lat] = mgrs.toPoint(compact)
    return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null
  } catch {
    return null
  }
}

function parseUtm(s: string): Position | null {
  const body = s.replace(/^UTM\s*/, '').replace(/^ZONE\s*/, '')
  // Band joined to the zone ("10U"), or spaced but not E/N (those are tags).
  const m = /^(\d{1,2})(?:([C-HJ-NP-X])|\s+([C-DF-HJ-MP-X]))?\s+(.+)$/.exec(body)
  if (!m) return null
  const zone = Number(m[1])
  const band = m[2] ?? m[3] ?? 'N' // no band: northern hemisphere
  const en = parseEastingNorthing(m[4])
  if (!en || zone < 1 || zone > 60) return null
  if (en.e < 100_000 || en.e > 900_000 || en.n > 10_000_000) return null
  const pos = fromUtm({ zone, band, easting: en.e, northing: en.n })
  return Number.isFinite(pos[1]) && pos[1] >= -80 && pos[1] <= 84 ? pos : null
}

function parseAlbers(s: string): Position | null {
  const body = s.replace(/^(?:BC\s*ALBERS|ALBERS|BCA|EPSG\s*:?\s*3005)\s*:?\s*/, '')
  const en = parseEastingNorthing(body)
  // Small numbers are degrees, not metres.
  if (!en || en.e < 1000 || en.n < 1000) return null
  const pos = fromBcAlbers(en.e, en.n)
  return pos && inBcAlbersArea(pos) ? pos : null
}

interface AngleHalf {
  value: number
  axis: 'lat' | 'lon' | null
}

/** One of latitude or longitude: degrees with optional minutes and seconds. */
function parseAngle(s: string): AngleHalf | null {
  const m =
    /^([NSEW])?\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*(?:(\d+(?:\.\d+)?)\s*'?\s*)?(?:(\d+(?:\.\d+)?)\s*"?\s*)?([NSEW])?$/.exec(
      s.trim(),
    )
  if (!m || (m[1] && m[5])) return null
  const [, , d, min, sec] = m
  // Only the last part given may have decimals; minutes and seconds under 60.
  if ((min && d.includes('.')) || (sec && min?.includes('.'))) return null
  if (Number(min ?? 0) >= 60 || Number(sec ?? 0) >= 60) return null
  const hemi = m[1] ?? m[5]
  const negative = d.startsWith('-')
  if (negative && (hemi === 'N' || hemi === 'E')) return null
  const abs = Math.abs(Number(d)) + Number(min ?? 0) / 60 + Number(sec ?? 0) / 3600
  return {
    value: negative || hemi === 'S' || hemi === 'W' ? -abs : abs,
    axis: hemi === 'N' || hemi === 'S' ? 'lat' : hemi ? 'lon' : null,
  }
}

function parseLatLon(s: string): Position | null {
  const hemis = [...s.matchAll(/[NSEW]/g)]
  let halves: [string, string]
  if (hemis.length === 2) {
    // "N50 … W121 …" splits before the second letter; "50 …N 121 …W" after the first.
    const cut = /^[NSEW]/.test(s) ? hemis[1].index! : hemis[0].index! + 1
    halves = [s.slice(0, cut), s.slice(cut)]
  } else if (hemis.length > 2) {
    return null
  } else if (/[,;/]/.test(s)) {
    const parts = s.split(/[,;/]/)
    if (parts.length !== 2) return null
    halves = [parts[0], parts[1]]
  } else {
    // Only spaces: split the numbers evenly (D D, DM DM or DMS DMS).
    const nums = [...s.matchAll(/[-+]?\d+(?:\.\d+)?/g)]
    if (!nums.length || nums.length > 6 || nums.length % 2) return null
    const cut = nums[nums.length / 2].index!
    halves = [s.slice(0, cut), s.slice(cut)]
  }
  let a = parseAngle(halves[0].replace(/^[\s,;/]+|[\s,;/]+$/g, ''))
  let b = parseAngle(halves[1].replace(/^[\s,;/]+|[\s,;/]+$/g, ''))
  if (!a || !b) return null
  if (a.axis === 'lon' || b.axis === 'lat') [a, b] = [b, a] // longitude written first
  if (a.axis && a.axis === b.axis) return null
  let lat = a.value
  let lon = b.value
  // Unlabelled "lon, lat" (GIS order): the first number can't be a latitude.
  if (!a.axis && !b.axis && Math.abs(lat) > 90 && Math.abs(lon) <= 90) [lat, lon] = [lon, lat]
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lon, lat] : null
}

/** Parse a typed coordinate in any supported format, or null. */
export function parseCoordinate(input: string): Position | null {
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[′’‘`´]/g, "'")
    .replace(/''/g, '"')
    .replace(/[″“”]/g, '"')
    .replace(/[º˚]/g, '°')
    .replace(/\s+/g, ' ')
  if (!s) return null
  return parseMgrs(s) ?? parseUtm(s) ?? parseAlbers(s) ?? parseLatLon(s)
}
