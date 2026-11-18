// Cutting an area out of a big PMTiles archive into a small one: the same
// job as `pmtiles extract`, written so the phone can do it too.
//
// planExtract() decides everything up front from the archive's index: the
// new file's header and directories (its "prefix"), which source bytes go
// into it, and the Range reads that fetch them. Then the caller writes the
// prefix and, read by read in order, outputOf(read) — appending as it goes.
// Because the plan is fixed, a download can stop after any read and resume
// from the size of the partly written file.

import { archivePrefix, type DirEntry, type PackHeaderInfo } from '../pmtiles-writer.ts'
import { coalesce, type ArchiveIndex, type TileLocation } from './archive.ts'

export interface ExtractRead {
  /** Source byte range to fetch. */
  offset: number
  length: number
  /** The blobs (unique tiles) it holds: plan.blobs[first .. first + count). */
  first: number
  count: number
  /** Size of the output file once this read's tiles are appended. */
  outEnd: number
}

export interface ExtractPlan {
  /** Header, root directory, metadata and leaf directories of the new file. Written first. */
  prefix: Uint8Array
  /** Unique tile byte ranges in the source file (absolute offsets), in the order they're written. */
  blobs: { offset: number; length: number }[]
  reads: ExtractRead[]
  /** Tiles the new file answers for (several may share one blob). */
  tiles: number
  dataLength: number
  totalLength: number
  /** Bytes fetched from the source, gaps between merged tiles included. */
  readLength: number
}

export interface ExtractInfo {
  minZoom: number
  maxZoom: number
  bounds: PackHeaderInfo['bounds']
  center: PackHeaderInfo['center']
  metadata: Record<string, unknown>
}

export interface ExtractOptions {
  /** Merge two tiles into one read if at most this many unneeded bytes lie between them. */
  maxGap?: number
  /** Largest single read. Smaller means less to redo after a dropped connection. */
  maxRead?: number
}

export function planExtract(
  index: ArchiveIndex,
  locations: TileLocation[],
  info: ExtractInfo,
  opts: ExtractOptions = {},
): ExtractPlan {
  // Unique blobs, in source order, and where each lands in the output.
  // Locations are relative to the source's tile-data section; blobs and
  // reads are absolute file offsets.
  const base = index.header.tileDataOffset
  const lengthAt = new Map<number, number>()
  for (const t of locations) if (!lengthAt.has(t.offset)) lengthAt.set(t.offset, t.length)
  const blobs = [...lengthAt.entries()].sort((a, b) => a[0] - b[0]).map(([offset, length]) => ({ offset: base + offset, length }))
  const outAt = new Map<number, number>()
  let dataLength = 0
  for (const b of blobs) {
    outAt.set(b.offset - base, dataLength)
    dataLength += b.length
  }

  // Directory entries, run-length merged where consecutive tiles share bytes.
  const entries: DirEntry[] = []
  let clustered = true
  let lastFirst = -1
  const seen = new Set<number>()
  for (const t of [...locations].sort((a, b) => a.tileId - b.tileId)) {
    const offset = outAt.get(t.offset)!
    const prev = entries[entries.length - 1]
    if (prev && prev.offset === offset && prev.tileId + prev.runLength === t.tileId) {
      prev.runLength++
      continue
    }
    entries.push({ tileId: t.tileId, offset, length: t.length, runLength: 1 })
    if (!seen.has(offset)) {
      seen.add(offset)
      if (offset < lastFirst) clustered = false
      lastFirst = offset
    }
  }

  const src = index.header
  const prefix = archivePrefix(
    entries,
    dataLength,
    {
      tileType: src.tileType as PackHeaderInfo['tileType'],
      tileCompression: src.tileCompression as PackHeaderInfo['tileCompression'],
      minZoom: info.minZoom,
      maxZoom: info.maxZoom,
      bounds: info.bounds,
      center: info.center,
      metadata: info.metadata,
    },
    { contents: blobs.length, clustered },
  )

  const merged = coalesce(
    blobs.map((b) => [b.offset, b.length]),
    opts.maxGap ?? 32 * 1024,
    opts.maxRead ?? 4 * 1024 * 1024,
  )
  const reads: ExtractRead[] = []
  let first = 0
  let outEnd = prefix.length
  let readLength = 0
  for (const m of merged) {
    for (const [, len] of m.parts) outEnd += len
    reads.push({ offset: m.offset, length: m.length, first, count: m.parts.length, outEnd })
    first += m.parts.length
    readLength += m.length
  }
  return {
    prefix,
    blobs,
    reads,
    tiles: locations.length,
    dataLength,
    totalLength: prefix.length + dataLength,
    readLength,
  }
}

/** The bytes to append for one read, cut from what the read returned. */
export function outputOf(plan: ExtractPlan, read: ExtractRead, bytes: Uint8Array): Uint8Array {
  if (bytes.length < read.length) throw new Error(`short read: ${bytes.length} of ${read.length} bytes`)
  if (read.count === 1 && plan.blobs[read.first].offset === read.offset && plan.blobs[read.first].length === bytes.length) {
    return bytes
  }
  let size = 0
  for (let i = read.first; i < read.first + read.count; i++) size += plan.blobs[i].length
  const out = new Uint8Array(size)
  let at = 0
  for (let i = read.first; i < read.first + read.count; i++) {
    const b = plan.blobs[i]
    out.set(bytes.subarray(b.offset - read.offset, b.offset - read.offset + b.length), at)
    at += b.length
  }
  return out
}

/**
 * Where to carry on after an interruption: the index of the first read not
 * yet written, given how many bytes the output file has. null when the size
 * doesn't fall on a read boundary (a write was cut short): start again.
 */
export function resumeAt(plan: ExtractPlan, writtenBytes: number): number | null {
  if (writtenBytes === plan.prefix.length) return 0
  if (writtenBytes < plan.prefix.length) return null
  let lo = 0
  let hi = plan.reads.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const end = plan.reads[mid].outEnd
    if (end === writtenBytes) return mid + 1
    if (end < writtenBytes) lo = mid + 1
    else hi = mid - 1
  }
  return null
}
