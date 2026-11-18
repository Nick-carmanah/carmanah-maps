// Reading a PMTiles archive's index (header and directories) by byte range,
// to find where a set of tiles sit without reading the tiles themselves.
// Works on any byte source: a hosted file over HTTP Range requests (the
// app, the Mac builder) or a local file (tests, the builder).
//
// No DOM or Node imports; see area.ts.

import { bytesToHeader, findTile, type Entry, type Header } from 'pmtiles'
import { gunzipSync } from 'fflate'

/** Reads `length` bytes from `offset`. Must return exactly that many (or fewer only at end of file). */
export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>

export interface ArchiveIndex {
  header: Header
  metadata: Record<string, unknown>
  root: Entry[]
  read: ReadRange
  /** Leaf directories read so far, by offset in the leaf section. */
  leaves: Map<number, Entry[]>
}

/** A tile's bytes in the source archive. */
export interface TileLocation {
  tileId: number
  offset: number
  length: number
}

const HEADER_AND_ROOT = 16384

function decompress(bytes: Uint8Array, compression: number): Uint8Array {
  if (compression === 1 || compression === 0) return bytes
  if (compression === 2) return gunzipSync(bytes)
  throw new Error(`unsupported PMTiles directory compression ${compression}`)
}

/** Parse a serialized PMTiles v3 directory (spec §4). */
export function parseDirectory(bytes: Uint8Array): Entry[] {
  let pos = 0
  const varint = (): number => {
    let result = 0
    let shift = 1
    for (;;) {
      if (pos >= bytes.length) throw new Error('truncated PMTiles directory')
      const b = bytes[pos++]
      result += (b & 0x7f) * shift
      if (b < 0x80) return result
      shift *= 128
    }
  }
  const count = varint()
  const entries: Entry[] = new Array(count)
  let lastId = 0
  for (let i = 0; i < count; i++) {
    lastId += varint()
    entries[i] = { tileId: lastId, offset: 0, length: 0, runLength: 1 }
  }
  for (let i = 0; i < count; i++) entries[i].runLength = varint()
  for (let i = 0; i < count; i++) entries[i].length = varint()
  for (let i = 0; i < count; i++) {
    const v = varint()
    entries[i].offset = v === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : v - 1
  }
  return entries
}

/** Read the header, metadata and root directory. */
export async function openArchive(read: ReadRange): Promise<ArchiveIndex> {
  const head = await read(0, HEADER_AND_ROOT)
  if (head.length < 127 || new TextDecoder().decode(head.subarray(0, 7)) !== 'PMTiles') {
    throw new Error('not a PMTiles archive')
  }
  const header = bytesToHeader(head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength) as ArrayBuffer)
  if (header.specVersion !== 3) throw new Error(`PMTiles v${header.specVersion} isn't supported (need v3)`)
  const rootBytes =
    header.rootDirectoryOffset + header.rootDirectoryLength <= head.length
      ? head.subarray(header.rootDirectoryOffset, header.rootDirectoryOffset + header.rootDirectoryLength)
      : await read(header.rootDirectoryOffset, header.rootDirectoryLength)
  const root = parseDirectory(decompress(rootBytes, header.internalCompression))
  let metadata: Record<string, unknown> = {}
  if (header.jsonMetadataLength > 0) {
    const raw = await read(header.jsonMetadataOffset, header.jsonMetadataLength)
    try {
      metadata = JSON.parse(new TextDecoder().decode(decompress(raw, header.internalCompression)))
    } catch {
      metadata = {}
    }
  }
  return { header, metadata, root, read, leaves: new Map() }
}

/** Byte ranges to read, merged when they're close: [offset, length] pairs, ascending. */
export function coalesce(ranges: [number, number][], maxGap: number, maxLength: number): { offset: number; length: number; parts: [number, number][] }[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: { offset: number; length: number; parts: [number, number][] }[] = []
  for (const [off, len] of sorted) {
    const last = out[out.length - 1]
    if (last && off - (last.offset + last.length) <= maxGap && off + len - last.offset <= maxLength) {
      last.length = Math.max(last.length, off + len - last.offset)
      last.parts.push([off, len])
    } else {
      out.push({ offset: off, length: len, parts: [[off, len]] })
    }
  }
  return out
}

/**
 * Where each of `tileIds` (ascending) sits in the archive. Tiles the archive
 * doesn't have are left out. Reads only the leaf directories those tiles
 * need, a few at a time, merged into larger reads when close together.
 */
export async function locateTiles(
  index: ArchiveIndex,
  tileIds: number[],
  opts: { maxGap?: number; maxRead?: number; onRead?: (bytes: number) => void } = {},
): Promise<TileLocation[]> {
  const { header } = index
  const found: TileLocation[] = []
  let pending: { dir: Entry[]; ids: number[] }[] = [{ dir: index.root, ids: tileIds }]
  for (let depth = 0; pending.length && depth < 4; depth++) {
    const nextLeaves = new Map<number, { length: number; ids: number[] }>()
    for (const { dir, ids } of pending) {
      for (const id of ids) {
        const e = findTile(dir, id)
        if (!e) continue
        if (e.runLength > 0) {
          found.push({ tileId: id, offset: e.offset, length: e.length })
        } else {
          let leaf = nextLeaves.get(e.offset)
          if (!leaf) nextLeaves.set(e.offset, (leaf = { length: e.length, ids: [] }))
          leaf.ids.push(id)
        }
      }
    }
    // Read the leaves we don't have yet, merged into a few larger reads.
    const missing = [...nextLeaves.entries()].filter(([off]) => !index.leaves.has(off))
    const reads = coalesce(
      missing.map(([off, { length }]) => [off, length]),
      opts.maxGap ?? 64 * 1024,
      opts.maxRead ?? 4 * 1024 * 1024,
    )
    await Promise.all(
      reads.map(async (r) => {
        const bytes = await index.read(header.leafDirectoryOffset + r.offset, r.length)
        opts.onRead?.(bytes.length)
        for (const [off, len] of r.parts) {
          const slice = bytes.subarray(off - r.offset, off - r.offset + len)
          index.leaves.set(off, parseDirectory(decompress(slice, header.internalCompression)))
        }
      }),
    )
    pending = [...nextLeaves.entries()].map(([off, { ids }]) => ({ dir: index.leaves.get(off)!, ids }))
  }
  return found.sort((a, b) => a.tileId - b.tileId)
}
