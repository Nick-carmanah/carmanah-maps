/**
 * Synthetic image files with EXIF, built byte by byte for the EXIF reader
 * tests. No real photos: the "images" are an 8×8 grey square and every
 * position is a made-up round number.
 */

export interface Tag {
  tag: number
  /** TIFF type: 1 BYTE, 2 ASCII, 3 SHORT, 4 LONG, 5 RATIONAL. */
  type: 1 | 2 | 3 | 4 | 5
  value: string | number[] | [number, number][]
}

const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 } as const

function count(t: Tag): number {
  if (t.type === 2) return (t.value as string).length + 1
  return (t.value as unknown[]).length
}

const ifdSize = (tags: Tag[]) =>
  2 + 12 * tags.length + 4 +
  tags.reduce((s, t) => {
    const n = SIZE[t.type] * count(t)
    return s + (n > 4 ? n + (n & 1) : 0)
  }, 0)

/** A TIFF block: IFD0, plus an Exif IFD and a GPS IFD when given. */
export function buildTiff(opts: { le: boolean; ifd0?: Tag[]; exif?: Tag[]; gps?: Tag[] }): Uint8Array {
  const ifd0: Tag[] = [...(opts.ifd0 ?? [])]
  if (opts.exif) ifd0.push({ tag: 0x8769, type: 4, value: [0] })
  if (opts.gps) ifd0.push({ tag: 0x8825, type: 4, value: [0] })
  const ifds: Tag[][] = [ifd0, ...(opts.exif ? [opts.exif] : []), ...(opts.gps ? [opts.gps] : [])].map((t) =>
    [...t].sort((a, b) => a.tag - b.tag),
  )
  const offsets: number[] = []
  let at = 8
  for (const t of ifds) {
    offsets.push(at)
    at += ifdSize(t)
  }
  let k = 1
  for (const t of ifds[0]) {
    if (t.tag === 0x8769 || t.tag === 0x8825) t.value = [offsets[k++]]
  }

  const out = new Uint8Array(at)
  const dv = new DataView(out.buffer)
  const le = opts.le
  out.set(le ? [0x49, 0x49] : [0x4d, 0x4d], 0)
  dv.setUint16(2, 42, le)
  dv.setUint32(4, 8, le)

  ifds.forEach((tags, n) => {
    const start = offsets[n]
    dv.setUint16(start, tags.length, le)
    let data = start + 2 + 12 * tags.length + 4
    tags.forEach((t, i) => {
      const e = start + 2 + i * 12
      const c = count(t)
      const bytes = SIZE[t.type] * c
      dv.setUint16(e, t.tag, le)
      dv.setUint16(e + 2, t.type, le)
      dv.setUint32(e + 4, c, le)
      let p = e + 8
      if (bytes > 4) {
        dv.setUint32(e + 8, data, le)
        p = data
        data += bytes + (bytes & 1)
      }
      if (t.type === 2) {
        const s = t.value as string
        for (let j = 0; j < s.length; j++) out[p + j] = s.charCodeAt(j)
        out[p + s.length] = 0
      } else if (t.type === 5) {
        ;(t.value as [number, number][]).forEach(([a, b], j) => {
          dv.setUint32(p + j * 8, a, le)
          dv.setUint32(p + j * 8 + 4, b, le)
        })
      } else {
        ;(t.value as number[]).forEach((v, j) => {
          if (t.type === 1) out[p + j] = v
          else if (t.type === 3) dv.setUint16(p + j * 2, v, le)
          else dv.setUint32(p + j * 4, v, le)
        })
      }
    })
    dv.setUint32(start + 2 + 12 * tags.length, 0, le) // no next IFD
  })
  return out
}

/** Degrees → [deg, min, sec] rationals, as phones write them. */
export function dmsRationals(deg: number): [number, number][] {
  const a = Math.abs(deg)
  const d = Math.floor(a)
  const mFloat = (a - d) * 60
  const m = Math.floor(mFloat)
  const s = (mFloat - m) * 60
  return [
    [d, 1],
    [m, 1],
    [Math.round(s * 10000), 10000],
  ]
}

export interface GpsSpec {
  lat: number
  lon: number
  alt?: number
  belowSeaLevel?: boolean
  direction?: number
  directionRef?: 'T' | 'M'
  gpsDate?: string
  gpsTime?: [number, number, number]
  hError?: number
}

export function gpsTags(g: GpsSpec): Tag[] {
  const tags: Tag[] = [
    { tag: 0x0000, type: 1, value: [2, 3, 0, 0] }, // GPSVersionID
    { tag: 0x0001, type: 2, value: g.lat < 0 ? 'S' : 'N' },
    { tag: 0x0002, type: 5, value: dmsRationals(g.lat) },
    { tag: 0x0003, type: 2, value: g.lon < 0 ? 'W' : 'E' },
    { tag: 0x0004, type: 5, value: dmsRationals(g.lon) },
  ]
  if (g.alt !== undefined) {
    tags.push({ tag: 0x0005, type: 1, value: [g.belowSeaLevel ? 1 : 0] })
    tags.push({ tag: 0x0006, type: 5, value: [[Math.round(Math.abs(g.alt) * 100), 100]] })
  }
  if (g.gpsTime) {
    tags.push({
      tag: 0x0007,
      type: 5,
      value: g.gpsTime.map((v) => [Math.round(v * 100), 100] as [number, number]),
    })
  }
  if (g.direction !== undefined) {
    tags.push({ tag: 0x0010, type: 2, value: g.directionRef ?? 'T' })
    tags.push({ tag: 0x0011, type: 5, value: [[Math.round(g.direction * 1000), 1000]] })
  }
  if (g.gpsDate) tags.push({ tag: 0x001d, type: 2, value: g.gpsDate })
  if (g.hError !== undefined) tags.push({ tag: 0x001f, type: 5, value: [[Math.round(g.hError * 100), 100]] })
  return tags
}

export function exifTags(e: { dateTimeOriginal?: string; offset?: string }): Tag[] {
  const tags: Tag[] = [{ tag: 0x9000, type: 1, value: [0x30, 0x32, 0x33, 0x32] }] // ExifVersion (as BYTE)
  if (e.dateTimeOriginal) tags.push({ tag: 0x9003, type: 2, value: e.dateTimeOriginal })
  if (e.offset) tags.push({ tag: 0x9011, type: 2, value: e.offset })
  return tags
}

/** A complete TIFF block for a photo. */
export function photoTiff(
  le: boolean,
  gps: GpsSpec | null,
  exif: { dateTimeOriginal?: string; offset?: string } = {},
): Uint8Array {
  return buildTiff({
    le,
    ifd0: [
      { tag: 0x010f, type: 2, value: 'Synthetic' }, // Make
      { tag: 0x0112, type: 3, value: [1] }, // Orientation
    ],
    exif: exifTags(exif),
    gps: gps ? gpsTags(gps) : undefined,
  })
}

const seg = (marker: number, body: number[] | Uint8Array): number[] => {
  const len = body.length + 2
  return [0xff, marker, len >> 8, len & 0xff, ...body]
}
const bytes = (s: string) => [...s].map((c) => c.charCodeAt(0))

/**
 * A real (decodable) baseline JPEG: an 8×8 mid-grey square, with the given
 * TIFF block in an APP1 "Exif" segment. One-code Huffman tables: DC
 * category 0 and AC end-of-block are both the code "0", so the scan is the
 * bits 00 padded with ones (0x3F).
 */
export function buildJpeg(tiff: Uint8Array | null, opts: { xmpFirst?: boolean } = {}): Uint8Array {
  const out: number[] = [0xff, 0xd8]
  out.push(...seg(0xe0, [...bytes('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]))
  if (opts.xmpFirst) out.push(...seg(0xe1, [...bytes('http://ns.adobe.com/xap/1.0/\0'), ...bytes('<x:xmpmeta/>')]))
  if (tiff) out.push(...seg(0xe1, [...bytes('Exif\0\0'), ...tiff]))
  out.push(...seg(0xdb, [0, ...new Array(64).fill(1)])) // DQT
  out.push(...seg(0xc0, [8, 0, 8, 0, 8, 1, 1, 0x11, 0])) // SOF0 8×8, 1 component
  const oneCode = [1, ...new Array(15).fill(0), 0]
  out.push(...seg(0xc4, [0x00, ...oneCode])) // DHT DC0
  out.push(...seg(0xc4, [0x10, ...oneCode])) // DHT AC0
  out.push(...seg(0xda, [1, 1, 0x00, 0, 63, 0])) // SOS
  out.push(0x3f, 0xff, 0xd9)
  return new Uint8Array(out)
}

function box(type: string, ...parts: (number[] | Uint8Array)[]): number[] {
  const body = parts.flatMap((p) => [...p])
  const size = body.length + 8
  return [size >>> 24, (size >> 16) & 255, (size >> 8) & 255, size & 255, ...bytes(type), ...body]
}
const u16 = (v: number) => [v >> 8, v & 255]
const u32 = (v: number) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]

/**
 * A HEIF container the way iPhones lay it out: ftyp, meta (hdlr, iinf with an
 * "Exif" item, iloc pointing into mdat), then mdat. `gapBytes` inserts a free
 * box before mdat, to put the Exif item past the reader's first read.
 * (There is no image item: the reader only needs the Exif one.)
 */
export function buildHeic(tiff: Uint8Array, opts: { gapBytes?: number } = {}): Uint8Array {
  const payload = [...u32(6), ...bytes('Exif\0\0'), ...tiff]
  const ftyp = box('ftyp', bytes('heic'), u32(0), bytes('mif1'), bytes('heic'))
  const hdlr = box('hdlr', u32(0), u32(0), bytes('pict'), u32(0), u32(0), u32(0), [0])
  const infe = box('infe', [2, 0, 0, 0], u16(1), u16(0), bytes('Exif'), [0])
  const iinf = box('iinf', [0, 0, 0, 0], u16(1), infe)
  const iloc = (offset: number) =>
    box('iloc', [0, 0, 0, 0], [0x44, 0x00], u16(1), u16(1), u16(0), u16(1), u32(offset), u32(payload.length))
  const metaOf = (offset: number) => box('meta', [0, 0, 0, 0], hdlr, iinf, iloc(offset))
  const free = opts.gapBytes ? box('free', new Uint8Array(opts.gapBytes)) : []
  const before = ftyp.length + metaOf(0).length + free.length + 8 // + mdat header
  return new Uint8Array([...ftyp, ...metaOf(before), ...free, ...box('mdat', payload)])
}

/** PNG signature + IHDR + eXIf + IEND (CRCs zeroed: the reader skips them). */
export function buildPng(tiff: Uint8Array): Uint8Array {
  const chunk = (type: string, data: number[] | Uint8Array) => [...u32(data.length), ...bytes(type), ...data, 0, 0, 0, 0]
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(8), ...u32(8), 8, 0, 0, 0, 0]),
    ...chunk('eXIf', tiff),
    ...chunk('IEND', []),
  ])
}
