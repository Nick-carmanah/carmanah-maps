/**
 * Cutting an area out of a PMTiles archive (src/lib/packs/archive.ts,
 * extract.ts): the same code the Mac builder and the phone use. Checked
 * with the `pmtiles` library's own reader against archives built by an
 * independent writer (test/helpers/pmtiles-fixture.ts) that look like
 * OpenFreeMap's planet: gzip directories, leaves, dedup and run-lengths.
 */
import { describe, expect, it } from 'vitest'
import { tileIdToZxy, zxyToTileId } from 'pmtiles'
import { coalesce, locateTiles, openArchive, parseDirectory } from '../src/lib/packs/archive'
import { outputOf, planExtract, resumeAt, type ExtractPlan } from '../src/lib/packs/extract'
import { concat, fixtureTiles, makeArchive, memoryReader, pmtilesOf } from './helpers/pmtiles-fixture'

// z4–z10 over a 64×64 block at z10: 5,461 tiles, so the fixture needs leaves.
const TILES = fixtureTiles(4, 10, 320, 704, 64)
const SOURCE = makeArchive(TILES, { leafSize: 400 })
const byId = new Map(TILES.map((t) => [zxyToTileId(t.z, t.x, t.y), t.data]))

/** Run a plan the way the downloader does: prefix, then each read's output in order. */
async function runPlan(plan: ExtractPlan, read: (o: number, l: number) => Promise<Uint8Array>, from = 0, parts: Uint8Array[] = [plan.prefix]) {
  for (let i = from; i < plan.reads.length; i++) {
    const r = plan.reads[i]
    parts.push(outputOf(plan, r, await read(r.offset, r.length)))
  }
  return concat(parts)
}

const info = (minZoom: number, maxZoom: number) => ({
  minZoom,
  maxZoom,
  bounds: [-120, 49, -119, 50] as [number, number, number, number],
  center: [-119.5, 49.5, 8] as [number, number, number],
  metadata: { name: 'cut' },
})

describe('archive index', () => {
  it('reads a gzip-directory archive with leaves and finds every tile, inside runs too', async () => {
    const { read } = memoryReader(SOURCE)
    const index = await openArchive(read)
    expect(index.header.internalCompression).toBe(2)
    expect(index.root.some((e) => e.runLength === 0)).toBe(true)
    const ids = [...byId.keys()].sort((a, b) => a - b)
    const found = await locateTiles(index, [...ids, zxyToTileId(10, 0, 0)])
    expect(found.map((f) => f.tileId)).toEqual(ids)
    for (const f of found.slice(0, 500)) {
      const bytes = await read(index.header.tileDataOffset + f.offset, f.length)
      expect(bytes).toEqual(byId.get(f.tileId))
    }
    expect(index.metadata).toMatchObject({ name: 'fixture' })
  })

  it('reads only the leaves it needs, merged into few reads', async () => {
    const reader = memoryReader(SOURCE)
    const index = await openArchive(reader.read)
    const before = reader.stats.reads
    const one = [zxyToTileId(10, 330, 710)]
    await locateTiles(index, one)
    expect(reader.stats.reads - before).toBe(1)
    expect(index.leaves.size).toBe(1)
  })

  it('parses the PMTiles spec example directory layout', () => {
    // 2 entries: ids 0 and 1, run 1, lengths 10 and 20, offsets 0 then "follows".
    expect(parseDirectory(Uint8Array.from([2, 0, 1, 1, 1, 10, 20, 1, 0]))).toEqual([
      { tileId: 0, offset: 0, length: 10, runLength: 1 },
      { tileId: 1, offset: 10, length: 20, runLength: 1 },
    ])
  })
})

describe('coalesce', () => {
  it('merges ranges closer than the gap, up to a maximum read', () => {
    const out = coalesce([[0, 10], [15, 10], [100, 10], [118, 10]], 5, 1000)
    expect(out.map((r) => [r.offset, r.length])).toEqual([[0, 25], [100, 10], [118, 10]])
    expect(out[0].parts).toEqual([[0, 10], [15, 10]])
    expect(coalesce([[0, 10], [10, 10], [20, 10]], 0, 20).map((r) => [r.offset, r.length])).toEqual([[0, 20], [20, 10]])
  })
})

describe('planExtract', () => {
  async function cut(ids: number[], opts = {}) {
    const reader = memoryReader(SOURCE)
    const index = await openArchive(reader.read)
    const locations = await locateTiles(index, ids)
    const plan = planExtract(index, locations, info(6, 10), opts)
    return { plan, reader, out: await runPlan(plan, reader.read) }
  }

  // An area: z10 tiles 330–345 × 710–725 and their parents down to z6.
  const wanted: number[] = []
  for (let z = 6; z <= 10; z++) {
    const s = 10 - z
    for (let x = 330 >> s; x <= 345 >> s; x++) for (let y = 710 >> s; y <= 725 >> s; y++) wanted.push(zxyToTileId(z, x, y))
  }
  wanted.sort((a, b) => a - b)

  it('writes a valid archive with exactly the wanted tiles, byte for byte', async () => {
    const { plan, out } = await cut(wanted)
    expect(out.length).toBe(plan.totalLength)
    const p = pmtilesOf(out)
    const h = await p.getHeader()
    expect([h.minZoom, h.maxZoom]).toEqual([6, 10])
    expect(h.numAddressedTiles).toBe(wanted.length)
    for (const id of wanted) {
      const [z, x, y] = tileIdToZxy(id)
      const t = await p.getZxy(z, x, y)
      expect(new Uint8Array(t!.data), `${z}/${x}/${y}`).toEqual(byId.get(id))
    }
    // Outside the area: nothing.
    expect(await p.getZxy(10, 320, 704)).toBeUndefined()
    expect(await p.getZxy(4, 5, 11)).toBeUndefined() // in the source, below the cut's min zoom
  })

  it('keeps shared tiles shared and runs as runs', async () => {
    const { plan, out } = await cut(wanted)
    const h = await pmtilesOf(out).getHeader()
    expect(h.numTileContents).toBe(plan.blobs.length)
    expect(h.numTileContents).toBeLessThan(h.numAddressedTiles)
    expect(h.numTileEntries).toBeLessThan(h.numAddressedTiles)
  })

  it('reads fewer, bigger ranges with a bigger gap allowance, same output', async () => {
    const tight = await cut(wanted, { maxGap: 0 })
    const loose = await cut(wanted, { maxGap: 64 * 1024 })
    expect(loose.plan.reads.length).toBeLessThan(tight.plan.reads.length)
    expect(loose.out).toEqual(tight.out)
    expect(loose.plan.readLength).toBeGreaterThanOrEqual(tight.plan.readLength)
  })

  it('splits reads at maxRead so a dropped connection loses little', async () => {
    const { plan } = await cut(wanted, { maxGap: 1e9, maxRead: 4096 })
    expect(plan.reads.length).toBeGreaterThan(5)
    expect(Math.max(...plan.reads.map((r) => r.length))).toBeLessThanOrEqual(4096 + 512)
  })
})

describe('resumeAt', () => {
  it('finds the next read from the size written, and refuses a size mid-read', async () => {
    const reader = memoryReader(SOURCE)
    const index = await openArchive(reader.read)
    const ids = [...byId.keys()].filter((id) => tileIdToZxy(id)[0] >= 8).sort((a, b) => a - b)
    const plan = planExtract(index, await locateTiles(index, ids), info(8, 10), { maxRead: 2048 })
    expect(plan.reads.length).toBeGreaterThan(10)
    expect(resumeAt(plan, plan.prefix.length)).toBe(0)
    expect(resumeAt(plan, plan.prefix.length - 1)).toBeNull()
    expect(resumeAt(plan, plan.reads[4].outEnd)).toBe(5)
    expect(resumeAt(plan, plan.reads[4].outEnd + 1)).toBeNull()
    expect(resumeAt(plan, plan.totalLength)).toBe(plan.reads.length)

    // Stop after 7 reads, "restart", carry on: same file as one go.
    const whole = await runPlan(plan, reader.read)
    const first = await runPlan({ ...plan, reads: plan.reads.slice(0, 7) }, reader.read)
    const next = resumeAt(plan, first.length)!
    expect(next).toBe(7)
    const resumed = await runPlan(plan, reader.read, next, [first])
    expect(resumed).toEqual(whole)
  })
})
