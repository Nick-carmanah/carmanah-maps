// Minimal PMTiles v3 writer (https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md).
// Ported from native-harness/src/pmtiles-write.ts (the native storage spike),
// unchanged apart from formatting. No DOM or Capacitor imports.
//
// Layout written: header (127 B) | root directory | JSON metadata | leaf
// directories | tile data. Directories are uncompressed (internal compression
// "none"); tiles are stored as given, in tile-id order, so the archive is
// "clustered" and each zoom/area is contiguous on disk.

import { zxyToTileId } from 'pmtiles'

export const PmCompression = { Unknown: 0, None: 1, Gzip: 2 } as const
export const PmTileType = { Unknown: 0, Mvt: 1, Png: 2, Jpeg: 3, Webp: 4 } as const
type ValueOf<T> = T[keyof T]

export interface TileRef {
  z: number
  x: number
  y: number
  length: number
}

export interface PackHeaderInfo {
  tileType: ValueOf<typeof PmTileType>
  tileCompression: ValueOf<typeof PmCompression>
  minZoom: number
  maxZoom: number
  /** w, s, e, n */
  bounds: [number, number, number, number]
  /** lon, lat, zoom */
  center: [number, number, number]
  metadata: Record<string, unknown>
}

/** A directory entry: `runLength` consecutive tile ids share these bytes (0 = leaf pointer). */
export interface DirEntry {
  tileId: number
  offset: number
  length: number
  runLength: number
}

/** Where each tile goes in the tile-data section, in write order. */
export interface PlannedTile extends TileRef {
  tileId: number
  offset: number
}

export interface PackPlan {
  /** Header + root dir + metadata + leaf dirs. Write this first. */
  prefix: Uint8Array
  /** Tiles in the order their bytes must follow the prefix. */
  tiles: PlannedTile[]
  tileDataOffset: number
  tileDataLength: number
  totalLength: number
}

const HEADER_LEN = 127
const ROOT_MAX = 16384 - HEADER_LEN

function pushVarint(out: number[], n: number): void {
  // Values here stay well below 2^53; avoid 32-bit bitwise ops on purpose.
  while (n >= 128) {
    out.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}

function serializeDirectory(entries: DirEntry[]): Uint8Array {
  const out: number[] = []
  pushVarint(out, entries.length)
  let last = 0
  for (const e of entries) {
    pushVarint(out, e.tileId - last)
    last = e.tileId
  }
  for (const e of entries) pushVarint(out, e.runLength)
  for (const e of entries) pushVarint(out, e.length)
  entries.forEach((e, i) => {
    const prev = entries[i - 1]
    if (i > 0 && e.offset === prev.offset + prev.length) pushVarint(out, 0)
    else pushVarint(out, e.offset + 1)
  })
  return Uint8Array.from(out)
}

function concat(parts: Uint8Array[], total?: number): Uint8Array {
  const len = total ?? parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function buildRootAndLeaves(entries: DirEntry[], leafSize: number) {
  const rootEntries: DirEntry[] = []
  const leafParts: Uint8Array[] = []
  let leafBytes = 0
  for (let i = 0; i < entries.length; i += leafSize) {
    const chunk = entries.slice(i, i + leafSize)
    const ser = serializeDirectory(chunk)
    rootEntries.push({ tileId: chunk[0].tileId, offset: leafBytes, length: ser.length, runLength: 0 })
    leafParts.push(ser)
    leafBytes += ser.length
  }
  return { root: serializeDirectory(rootEntries), leaves: concat(leafParts, leafBytes) }
}

function optimizeDirectories(entries: DirEntry[]) {
  const whole = serializeDirectory(entries)
  if (whole.length <= ROOT_MAX) return { root: whole, leaves: new Uint8Array(0) }
  let leafSize = Math.max(4096, Math.ceil(entries.length / 3500))
  for (;;) {
    const r = buildRootAndLeaves(entries, leafSize)
    if (r.root.length <= ROOT_MAX) return r
    leafSize = Math.ceil(leafSize * 1.2)
  }
}

function writeHeader(
  h: {
    rootOffset: number
    rootLength: number
    metaOffset: number
    metaLength: number
    leafOffset: number
    leafLength: number
    dataOffset: number
    dataLength: number
    addressed: number
    entries: number
    contents: number
    clustered: boolean
  },
  info: PackHeaderInfo,
): Uint8Array {
  const buf = new Uint8Array(HEADER_LEN)
  const dv = new DataView(buf.buffer)
  buf.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73], 0) // "PMTiles"
  buf[7] = 3
  const u64 = (pos: number, v: number) => dv.setBigUint64(pos, BigInt(v), true)
  u64(8, h.rootOffset)
  u64(16, h.rootLength)
  u64(24, h.metaOffset)
  u64(32, h.metaLength)
  u64(40, h.leafOffset)
  u64(48, h.leafLength)
  u64(56, h.dataOffset)
  u64(64, h.dataLength)
  u64(72, h.addressed)
  u64(80, h.entries)
  u64(88, h.contents)
  buf[96] = h.clustered ? 1 : 0
  buf[97] = PmCompression.None // internal (directory) compression
  buf[98] = info.tileCompression
  buf[99] = info.tileType
  buf[100] = info.minZoom
  buf[101] = info.maxZoom
  const e7 = (v: number) => Math.round(v * 1e7)
  dv.setInt32(102, e7(info.bounds[0]), true)
  dv.setInt32(106, e7(info.bounds[1]), true)
  dv.setInt32(110, e7(info.bounds[2]), true)
  dv.setInt32(114, e7(info.bounds[3]), true)
  buf[118] = info.center[2]
  dv.setInt32(119, e7(info.center[0]), true)
  dv.setInt32(123, e7(info.center[1]), true)
  return buf
}

/**
 * Header, root directory, metadata and leaf directories for an archive whose
 * tile-data section (`dataLength` bytes, written right after this prefix)
 * is laid out as `entries` say. Entries must be sorted by tile id; several
 * may point at the same bytes (deduplicated tiles), and `runLength` > 1
 * covers consecutive tile ids.
 */
export function archivePrefix(
  entries: DirEntry[],
  dataLength: number,
  info: PackHeaderInfo,
  counts: { contents?: number; clustered?: boolean } = {},
): Uint8Array {
  const { root, leaves } = optimizeDirectories(entries)
  const meta = new TextEncoder().encode(JSON.stringify(info.metadata))
  const rootOffset = HEADER_LEN
  const metaOffset = rootOffset + root.length
  const leafOffset = metaOffset + meta.length
  const dataOffset = leafOffset + leaves.length
  const header = writeHeader(
    {
      rootOffset,
      rootLength: root.length,
      metaOffset,
      metaLength: meta.length,
      leafOffset,
      leafLength: leaves.length,
      dataOffset,
      dataLength,
      addressed: entries.reduce((n, e) => n + e.runLength, 0),
      entries: entries.length,
      contents: counts.contents ?? entries.length,
      clustered: counts.clustered ?? true,
    },
    info,
  )
  return concat([header, root, meta, leaves])
}

/**
 * Plan a PMTiles archive from tile sizes alone. The caller then writes
 * `plan.prefix` followed by each tile's bytes in `plan.tiles` order.
 */
export function planPack(tiles: TileRef[], info: PackHeaderInfo): PackPlan {
  const planned: PlannedTile[] = tiles
    .map((t) => ({ ...t, tileId: zxyToTileId(t.z, t.x, t.y), offset: 0 }))
    .sort((a, b) => a.tileId - b.tileId)
  let off = 0
  for (const t of planned) {
    t.offset = off
    off += t.length
  }
  const entries: DirEntry[] = planned.map((t) => ({ tileId: t.tileId, offset: t.offset, length: t.length, runLength: 1 }))
  const prefix = archivePrefix(entries, off, info)
  return {
    prefix,
    tiles: planned,
    tileDataOffset: prefix.length,
    tileDataLength: off,
    totalLength: prefix.length + off,
  }
}
