/**
 * Builds PMTiles v3 archives for tests, independently of
 * src/lib/pmtiles-writer.ts, the way big real archives look: gzip-compressed
 * directories, leaf directories, deduplicated tiles and run-length entries
 * (like OpenFreeMap's planet file).
 */
import { gzipSync } from 'fflate'
import { PMTiles, zxyToTileId, type Source } from 'pmtiles'

export interface FixtureTile {
  z: number
  x: number
  y: number
  data: Uint8Array
}

function varints(out: number[], n: number) {
  while (n >= 128) {
    out.push((n % 128) | 0x80)
    n = Math.floor(n / 128)
  }
  out.push(n)
}

interface E {
  tileId: number
  offset: number
  length: number
  runLength: number
}

function serialize(entries: E[]): Uint8Array {
  const out: number[] = []
  varints(out, entries.length)
  let last = 0
  for (const e of entries) {
    varints(out, e.tileId - last)
    last = e.tileId
  }
  for (const e of entries) varints(out, e.runLength)
  for (const e of entries) varints(out, e.length)
  entries.forEach((e, i) => varints(out, i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length ? 0 : e.offset + 1))
  return Uint8Array.from(out)
}

export function makeArchive(
  tiles: FixtureTile[],
  opts: { gzipDirs?: boolean; leafSize?: number; tileType?: number; tileCompression?: number } = {},
): Uint8Array {
  const gz = opts.gzipDirs ?? true
  const pack = (b: Uint8Array) => (gz ? gzipSync(b) : b)
  const sorted = tiles.map((t) => ({ ...t, id: zxyToTileId(t.z, t.x, t.y) })).sort((a, b) => a.id - b.id)
  // Dedup by content; consecutive ids with the same content become one run.
  const offsets = new Map<string, number>()
  const blobs: Uint8Array[] = []
  let dataLen = 0
  const entries: E[] = []
  for (const t of sorted) {
    const key = Array.from(t.data).join(',')
    let offset = offsets.get(key)
    if (offset === undefined) {
      offset = dataLen
      offsets.set(key, offset)
      blobs.push(t.data)
      dataLen += t.data.length
    }
    const prev = entries[entries.length - 1]
    if (prev && prev.offset === offset && prev.tileId + prev.runLength === t.id) prev.runLength++
    else entries.push({ tileId: t.id, offset, length: t.data.length, runLength: 1 })
  }
  const leafSize = opts.leafSize ?? 0
  let root: Uint8Array
  let leaves: Uint8Array = new Uint8Array(0)
  if (leafSize && entries.length > leafSize) {
    const rootEntries: E[] = []
    const parts: Uint8Array[] = []
    let at = 0
    for (let i = 0; i < entries.length; i += leafSize) {
      const chunk = entries.slice(i, i + leafSize)
      const bytes = pack(serialize(chunk))
      rootEntries.push({ tileId: chunk[0].tileId, offset: at, length: bytes.length, runLength: 0 })
      parts.push(bytes)
      at += bytes.length
    }
    leaves = concat(parts)
    root = pack(serialize(rootEntries))
  } else {
    root = pack(serialize(entries))
  }
  const meta = pack(new TextEncoder().encode(JSON.stringify({ name: 'fixture', vector_layers: [] })))
  const header = new Uint8Array(127)
  const dv = new DataView(header.buffer)
  header.set(new TextEncoder().encode('PMTiles'), 0)
  header[7] = 3
  const rootOff = 127
  const metaOff = rootOff + root.length
  const leafOff = metaOff + meta.length
  const dataOff = leafOff + leaves.length
  const u64 = (pos: number, v: number) => dv.setBigUint64(pos, BigInt(v), true)
  u64(8, rootOff)
  u64(16, root.length)
  u64(24, metaOff)
  u64(32, meta.length)
  u64(40, leafOff)
  u64(48, leaves.length)
  u64(56, dataOff)
  u64(64, dataLen)
  u64(72, sorted.length)
  u64(80, entries.length)
  u64(88, blobs.length)
  header[96] = 1
  header[97] = gz ? 2 : 1
  header[98] = opts.tileCompression ?? 1
  header[99] = opts.tileType ?? 1
  header[100] = Math.min(...tiles.map((t) => t.z))
  header[101] = Math.max(...tiles.map((t) => t.z))
  dv.setInt32(102, -180e7, true)
  dv.setInt32(106, -85e7, true)
  dv.setInt32(110, 180e7, true)
  dv.setInt32(114, 85e7, true)
  return concat([header, root, meta, leaves, ...blobs])
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Reads from an in-memory archive, counting calls. */
export function memoryReader(bytes: Uint8Array) {
  const stats = { reads: 0, bytes: 0 }
  const read = async (offset: number, length: number) => {
    stats.reads++
    const out = bytes.slice(offset, Math.min(bytes.length, offset + length))
    stats.bytes += out.length
    return out
  }
  return { read, stats }
}

/** The `pmtiles` library's own reader over bytes in memory. */
export function pmtilesOf(bytes: Uint8Array): PMTiles {
  const source: Source = {
    getKey: () => 'memory',
    getBytes: async (offset, length) => ({ data: bytes.slice(offset, offset + length).buffer as ArrayBuffer }),
  }
  return new PMTiles(source)
}

/**
 * Deterministic pseudo-random tile contents. Aligned 2×2 blocks with x%4, y%4
 * < 2 are one shared "ocean" tile (consecutive ids: run-length entries); every
 * `dupEvery`th other tile is a shared "empty" tile (deduplicated, not a run).
 */
export function fixtureTiles(z0: number, z1: number, x0: number, y0: number, span: number, dupEvery = 5): FixtureTile[] {
  const out: FixtureTile[] = []
  const empty = Uint8Array.from([0xee, 0xee, 0xee])
  const ocean = Uint8Array.from([0x0c, 0xea, 0x40, 0x00, 0x11])
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31)
  for (let z = z0; z <= z1; z++) {
    const shift = z1 - z
    const xa = x0 >> shift
    const ya = y0 >> shift
    const s = Math.max(1, span >> shift)
    for (let x = xa; x < xa + s; x++) {
      for (let y = ya; y < ya + s; y++) {
        if (x % 4 < 2 && y % 4 < 2) {
          out.push({ z, x, y, data: ocean })
          continue
        }
        if ((x + y) % dupEvery === 0) {
          out.push({ z, x, y, data: empty })
          continue
        }
        const len = 20 + (rnd() % 400)
        const data = new Uint8Array(len)
        for (let i = 0; i < len; i++) data[i] = rnd() & 0xff
        data[0] = z
        out.push({ z, x, y, data })
      }
    }
  }
  return out
}
