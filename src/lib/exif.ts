/**
 * Minimal EXIF reader for "Plot photos": GPS position, altitude, the
 * direction the camera faced and the time taken. Offline, no library.
 *
 * Finds the EXIF (TIFF) block in JPEG (APP1 "Exif"), HEIC/HEIF/AVIF (the
 * ISO-BMFF "Exif" item, as iPhones write), PNG (eXIf) and WebP (EXIF), then
 * reads only the tags below. Never throws on bad input: an unreadable file
 * is a photo without a position.
 */

export interface PhotoGeotag {
  lat: number
  lon: number
  /** Metres above sea level (negative below). */
  altitude?: number
  /** When the photo was taken, ms since 1970. */
  time?: number
  /** False when the camera clock had no time zone and `time` was read as
   * this device's local time. */
  timeZoneKnown?: boolean
  /** Direction the camera faced, degrees 0–360, from `directionRef` north. */
  direction?: number
  /** 'T' true north, 'M' magnetic north. */
  directionRef?: 'T' | 'M'
  /** GPSHPositioningError: the phone's horizontal error estimate, metres. */
  accuracyM?: number
}

/** The raw tags we read (exported for tests and debugging). */
export interface ExifTags {
  latRef?: string
  lat?: number[]
  lonRef?: string
  lon?: number[]
  altRef?: number
  alt?: number
  gpsTime?: number[]
  gpsDate?: string
  directionRef?: string
  direction?: number
  hError?: number
  dateTimeOriginal?: string
  offsetTimeOriginal?: string
  dateTime?: string
}

// ---- TIFF ----

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

const IFD0 = { exif: 0x8769, gps: 0x8825, dateTime: 0x0132 }
const EXIF = { dateTimeOriginal: 0x9003, offsetTimeOriginal: 0x9011 }
const GPS = {
  latRef: 0x0001,
  lat: 0x0002,
  lonRef: 0x0003,
  lon: 0x0004,
  altRef: 0x0005,
  alt: 0x0006,
  time: 0x0007,
  directionRef: 0x0010,
  direction: 0x0011,
  date: 0x001d,
  hError: 0x001f,
}

type Value = string | number[]

/** Read the tags we need from a TIFF block ("II*\0" or "MM\0*"). */
export function parseTiff(tiff: Uint8Array): ExifTags | null {
  if (tiff.length < 8) return null
  const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const order = String.fromCharCode(tiff[0], tiff[1])
  if (order !== 'II' && order !== 'MM') return null
  const le = order === 'II'
  if (dv.getUint16(2, le) !== 42) return null
  const u16 = (o: number) => dv.getUint16(o, le)
  const u32 = (o: number) => dv.getUint32(o, le)
  const fits = (o: number, n: number) => o >= 0 && o + n <= tiff.length

  const readIfd = (offset: number): Map<number, Value> | null => {
    if (!fits(offset, 2)) return null
    const count = u16(offset)
    if (!fits(offset + 2, count * 12)) return null
    const out = new Map<number, Value>()
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12
      const tag = u16(e)
      const type = u16(e + 2)
      const n = u32(e + 4)
      const size = TYPE_SIZE[type]
      if (!size || n > 1 << 16) continue
      const bytes = size * n
      const at = bytes <= 4 ? e + 8 : u32(e + 8)
      if (!fits(at, bytes)) continue
      if (type === 2) {
        let s = ''
        for (let j = 0; j < n; j++) s += String.fromCharCode(tiff[at + j])
        out.set(tag, s.replace(/\0[\s\S]*$/, '').trim())
      } else {
        const vals: number[] = []
        for (let j = 0; j < n; j++) {
          const o = at + j * size
          if (type === 1 || type === 7) vals.push(tiff[o])
          else if (type === 3) vals.push(u16(o))
          else if (type === 4) vals.push(u32(o))
          else if (type === 9) vals.push(dv.getInt32(o, le))
          else if (type === 5) vals.push(u32(o + 4) ? u32(o) / u32(o + 4) : NaN)
          else if (type === 10) vals.push(dv.getInt32(o + 4, le) ? dv.getInt32(o, le) / dv.getInt32(o + 4, le) : NaN)
        }
        out.set(tag, vals)
      }
    }
    return out
  }

  const ifd0 = readIfd(u32(4))
  if (!ifd0) return null
  const num = (m: Map<number, Value> | null, tag: number) => {
    const v = m?.get(tag)
    return Array.isArray(v) && Number.isFinite(v[0]) ? v[0] : undefined
  }
  const nums = (m: Map<number, Value> | null, tag: number) => {
    const v = m?.get(tag)
    return Array.isArray(v) ? v : undefined
  }
  const str = (m: Map<number, Value> | null, tag: number) => {
    const v = m?.get(tag)
    return typeof v === 'string' && v ? v : undefined
  }
  const sub = (tag: number) => {
    const p = num(ifd0, tag)
    return p ? readIfd(p) : null
  }
  const exif = sub(IFD0.exif)
  const gps = sub(IFD0.gps)
  return {
    latRef: str(gps, GPS.latRef),
    lat: nums(gps, GPS.lat),
    lonRef: str(gps, GPS.lonRef),
    lon: nums(gps, GPS.lon),
    altRef: num(gps, GPS.altRef),
    alt: num(gps, GPS.alt),
    gpsTime: nums(gps, GPS.time),
    gpsDate: str(gps, GPS.date),
    directionRef: str(gps, GPS.directionRef),
    direction: num(gps, GPS.direction),
    hError: num(gps, GPS.hError),
    dateTimeOriginal: str(exif, EXIF.dateTimeOriginal),
    offsetTimeOriginal: str(exif, EXIF.offsetTimeOriginal),
    dateTime: str(ifd0, IFD0.dateTime),
  }
}

// ---- Tags → geotag ----

function dms(v: number[] | undefined): number | undefined {
  if (!v?.length || !v.every(Number.isFinite)) return undefined
  return v[0] + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600
}

/** "YYYY:MM:DD HH:MM:SS" → parts, or null when blank or malformed. */
function exifDateParts(s: string | undefined): number[] | null {
  const m = s?.match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return null
  const p = m.slice(1).map(Number)
  return p[0] > 1900 && p[1] >= 1 && p[1] <= 12 && p[2] >= 1 ? p : null
}

function offsetMinutes(s: string | undefined): number | null {
  const m = s?.match(/^([+-])(\d{2}):?(\d{2})$/)
  if (!m) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

function photoTime(t: ExifTags): { time: number; timeZoneKnown: boolean } | null {
  const local = exifDateParts(t.dateTimeOriginal) ?? exifDateParts(t.dateTime)
  const offset = offsetMinutes(t.offsetTimeOriginal)
  if (local && offset != null) {
    const [y, mo, d, h, mi, s] = local
    return { time: Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60000, timeZoneKnown: true }
  }
  // GPS date + time are UTC.
  const gd = t.gpsDate?.match(/^(\d{4})[:-](\d{2})[:-](\d{2})/)
  if (gd && t.gpsTime?.length === 3 && t.gpsTime.every(Number.isFinite)) {
    const [h, mi, s] = t.gpsTime
    const ms = Date.UTC(Number(gd[1]), Number(gd[2]) - 1, Number(gd[3])) + ((h * 60 + mi) * 60 + s) * 1000
    if (Number.isFinite(ms)) return { time: Math.round(ms), timeZoneKnown: true }
  }
  if (local) {
    const [y, mo, d, h, mi, s] = local
    return { time: new Date(y, mo - 1, d, h, mi, s).getTime(), timeZoneKnown: false }
  }
  return null
}

/** Geotag from parsed tags; null when there is no usable GPS position. */
export function geotagFromTags(t: ExifTags): PhotoGeotag | null {
  const latAbs = dms(t.lat)
  const lonAbs = dms(t.lon)
  if (latAbs === undefined || lonAbs === undefined) return null
  const lat = (t.latRef?.toUpperCase().startsWith('S') ? -1 : 1) * latAbs
  const lon = (t.lonRef?.toUpperCase().startsWith('W') ? -1 : 1) * lonAbs
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  // Some cameras write 0,0 when they have no fix.
  if (lat === 0 && lon === 0) return null
  const out: PhotoGeotag = { lat, lon }
  if (t.alt !== undefined) out.altitude = t.altRef === 1 ? -t.alt : t.alt
  const when = photoTime(t)
  if (when) {
    out.time = when.time
    out.timeZoneKnown = when.timeZoneKnown
  }
  if (t.direction !== undefined && t.direction >= 0 && t.direction <= 360) {
    out.direction = t.direction % 360
    out.directionRef = t.directionRef?.toUpperCase().startsWith('M') ? 'M' : 'T'
  }
  if (t.hError !== undefined && t.hError >= 0) out.accuracyM = t.hError
  return out
}

// ---- Containers ----

const ascii = (b: Uint8Array, at: number, n: number) => {
  let s = ''
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i])
  return s
}

/** Where the EXIF block is: in these bytes, or (HEIC) at a file offset that
 * may lie beyond them. */
export type ExifLocation =
  | { tiff: Uint8Array }
  | { offset: number; length: number }

/** A TIFF block, skipping an optional "Exif\0\0" prefix. */
function tiffAt(b: Uint8Array, at: number, end: number): Uint8Array | null {
  if (ascii(b, at, 4) === 'Exif') at += 6
  return at < end && end <= b.length ? b.subarray(at, end) : null
}

function locateJpeg(b: Uint8Array): ExifLocation | null {
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++ // fill byte
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null // image data / end: no EXIF before it
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len < 2) return null
    if (marker === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
      const tiff = tiffAt(b, i + 4, i + 2 + len)
      return tiff ? { tiff } : null
    }
    i += 2 + len
  }
  return null
}

function locatePng(b: Uint8Array): ExifLocation | null {
  let i = 8
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
    const type = ascii(b, i + 4, 4)
    if (type === 'eXIf') {
      const tiff = tiffAt(b, i + 8, i + 8 + len)
      return tiff ? { tiff } : null
    }
    if (type === 'IEND') return null
    i += 12 + len
  }
  return null
}

function locateWebp(b: Uint8Array): ExifLocation | null {
  let i = 12
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4)
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0
    if (type === 'EXIF') {
      const tiff = tiffAt(b, i + 8, i + 8 + len)
      return tiff ? { tiff } : null
    }
    i += 8 + len + (len & 1)
  }
  return null
}

interface Box {
  type: string
  /** Start of the box's contents (after the header). */
  start: number
  end: number
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: Box[] = []
  let i = from
  while (i + 8 <= to) {
    let size = dv.getUint32(i)
    const type = ascii(b, i + 4, 4)
    let header = 8
    if (size === 1) {
      if (i + 16 > to) break
      size = dv.getUint32(i + 8) * 2 ** 32 + dv.getUint32(i + 12)
      header = 16
    } else if (size === 0) {
      size = to - i
    }
    if (size < header) break
    out.push({ type, start: i + header, end: Math.min(i + size, to) })
    i += size
  }
  return out
}

/** HEIC/HEIF/AVIF: the "Exif" item in the top-level meta box. */
function locateHeif(b: Uint8Array): ExifLocation | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta')
  if (!meta) return null
  const children = boxes(b, meta.start + 4, meta.end) // meta is a FullBox
  const iinf = children.find((x) => x.type === 'iinf')
  const iloc = children.find((x) => x.type === 'iloc')
  if (!iinf || !iloc) return null

  // Item id of the Exif item.
  const iinfVersion = b[iinf.start]
  const entriesAt = iinf.start + 4 + (iinfVersion === 0 ? 2 : 4)
  let exifId: number | null = null
  for (const infe of boxes(b, entriesAt, iinf.end)) {
    if (infe.type !== 'infe') continue
    const v = b[infe.start]
    if (v < 2) continue
    const id = v === 2 ? dv.getUint16(infe.start + 4) : dv.getUint32(infe.start + 4)
    const typeAt = infe.start + 4 + (v === 2 ? 2 : 4) + 2
    if (ascii(b, typeAt, 4) === 'Exif') {
      exifId = id
      break
    }
  }
  if (exifId === null) return null

  // Its extent in the file.
  const v = b[iloc.start]
  let p = iloc.start + 4
  const sizes = b[p++]
  const offsetSize = sizes >> 4
  const lengthSize = sizes & 15
  const sizes2 = b[p++]
  const baseSize = sizes2 >> 4
  const indexSize = v === 1 || v === 2 ? sizes2 & 15 : 0
  const read = (n: number): number => {
    if (p + n > iloc.end) throw new RangeError('iloc')
    let x = 0
    for (let k = 0; k < n; k++) x = x * 256 + b[p + k]
    p += n
    return x
  }
  try {
    const count = read(v < 2 ? 2 : 4)
    for (let k = 0; k < count; k++) {
      const id = read(v < 2 ? 2 : 4)
      const method = v === 1 || v === 2 ? read(2) & 15 : 0
      read(2) // data_reference_index
      const base = read(baseSize)
      const extents = read(2)
      let first: { offset: number; length: number } | null = null
      for (let e = 0; e < extents; e++) {
        if (indexSize) read(indexSize)
        const offset = read(offsetSize)
        const length = read(lengthSize)
        if (!first) first = { offset: base + offset, length }
      }
      if (id !== exifId || !first) continue
      if (method === 1) {
        // Stored inside the meta box's idat.
        const idat = children.find((x) => x.type === 'idat')
        if (!idat) return null
        return exifItem(b, idat.start + first.offset, first.length)
      }
      if (method !== 0) return null
      return first.offset + first.length <= b.length
        ? exifItem(b, first.offset, first.length)
        : { offset: first.offset, length: first.length }
    }
  } catch {
    return null
  }
  return null
}

/** An Exif item's payload: a 4-byte offset to the TIFF header, then the block. */
export function exifItem(b: Uint8Array, at: number, length: number): ExifLocation | null {
  if (length < 8 || at + length > b.length) return null
  const skip = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(at)
  const tiff = tiffAt(b, at + 4 + skip, at + length)
  return tiff ? { tiff } : null
}

/** Find the EXIF block in the first bytes of an image file. */
export function locateExif(b: Uint8Array): ExifLocation | null {
  try {
    if (b[0] === 0xff && b[1] === 0xd8) return locateJpeg(b)
    if (ascii(b, 0, 8) === '\x89PNG\r\n\x1a\n') return locatePng(b)
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return locateWebp(b)
    if (ascii(b, 4, 4) === 'ftyp') return locateHeif(b)
    if (ascii(b, 0, 2) === 'II' || ascii(b, 0, 2) === 'MM') return { tiff: b } // TIFF / raw
  } catch {
    return null
  }
  return null
}

/** Geotag from a whole image file's bytes (or enough of its start). */
export function readGeotag(bytes: Uint8Array): PhotoGeotag | null {
  const loc = locateExif(bytes)
  if (!loc || !('tiff' in loc)) return null
  const tags = parseTiff(loc.tiff)
  return tags ? geotagFromTags(tags) : null
}

/** EXIF sits near the start of every format we read; HEIC's Exif item can be
 * further in, and is then read on its own. */
const HEAD_BYTES = 512 * 1024

/** Geotag of a photo file; null when it has no GPS position (or isn't one). */
export async function readPhotoGeotag(file: Blob): Promise<PhotoGeotag | null> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer())
  let loc = locateExif(head)
  if (loc && 'offset' in loc) {
    if (loc.length > 4 * 1024 * 1024 || loc.offset + loc.length > file.size) return null
    const item = new Uint8Array(await file.slice(loc.offset, loc.offset + loc.length).arrayBuffer())
    loc = exifItem(item, 0, item.length)
  }
  if (!loc || !('tiff' in loc)) return null
  const tags = parseTiff(loc.tiff)
  return tags ? geotagFromTags(tags) : null
}
