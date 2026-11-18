/**
 * The crew app's file store: Capacitor Filesystem in LibraryNoCloud, under
 * `maps/<ownerId>/`, against an in-memory stand-in for the plugin and for
 * Capacitor's iOS scheme handler (test/helpers/mock-capacitor.ts).
 *
 * What must hold (docs/native-storage-spike.md §2, §5):
 *  - tiles come back by Range fetch, binary, checked for `206` and the right bytes;
 *  - a handler that ignores Range (`200`) or sends the wrong bytes is caught on
 *    a tiny probe file, and reads go through `readFile({ offset, length })`;
 *  - no request ever goes out without a Range header, and no whole-file
 *    response body is ever read;
 *  - writes go in chunks to a `.part` file that replaces the old one only
 *    when complete.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PMTiles } from 'pmtiles'
import { mockCapacitor, type RangeMode } from './helpers/mock-capacitor'
import { PmCompression, PmTileType, planPack } from '../src/lib/pmtiles-writer'

let owner = 0
/** A fresh owner per test, so each gets a fresh store (stores are cached per owner). */
const nextOwner = () => `u${++owner}`

async function nativeStore(opts: { rangeMode?: RangeMode; how?: 'plugins' | 'registerPlugin' | 'nativePromise' } = {}) {
  const cap = mockCapacitor(opts)
  cap.install()
  const { openFileStore } = await import('../src/lib/storage/files')
  const ownerId = nextOwner()
  const files = await openFileStore(ownerId)
  cap.calls.length = 0
  cap.fetches.length = 0
  return { cap, files, ownerId }
}

const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('choosing the native backend', () => {
  beforeEach(() => vi.resetModules())

  for (const how of ['plugins', 'registerPlugin', 'nativePromise'] as const) {
    it(`is used when Capacitor says native, with Filesystem reached via ${how}`, async () => {
      const { cap, files, ownerId } = await nativeStore({ how })
      expect(files.backend).toBe('native')
      await files.write('library/a.bin', [bytes(10)])
      expect(cap.paths()).toEqual([`maps/${ownerId}/library/a.bin`])
      expect(new Uint8Array(await files.readRange('library/a.bin', 2, 3))).toEqual(bytes(10).subarray(2, 5))
    })
  }

  it('keeps every file in LibraryNoCloud, never another directory', async () => {
    const { cap, files } = await nativeStore()
    await files.write('x/y.bin', [bytes(100)])
    await files.readRange('x/y.bin', 0, 10)
    await files.read('x/y.bin')
    await files.remove('x/y.bin')
    const dirs = new Set(cap.calls.map((c) => c.options.directory))
    expect([...dirs]).toEqual(['LIBRARY_NO_CLOUD'])
  })

  it('is not used on the website', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false, convertFileSrc: (s: string) => s })
    const { openFileStore } = await import('../src/lib/storage/files')
    expect((await openFileStore(nextOwner())).backend).toBe('idb') // Node has no OPFS
  })

  it("keeps a person's earlier web backend, so their files don't vanish", async () => {
    const ownerId = nextOwner()
    const { openFileStore } = await import('../src/lib/storage/files')
    const web = await openFileStore(ownerId)
    expect(web.backend).toBe('idb')
    await web.write('keep.bin', [bytes(5)])
    vi.resetModules()
    mockCapacitor().install()
    const again = await (await import('../src/lib/storage/files')).openFileStore(ownerId)
    expect(again.backend).toBe('idb')
    expect(await again.size('keep.bin')).toBe(5)
  })

  it('refuses owner ids that could reach the shared packs or outside the folder', async () => {
    mockCapacitor().install()
    const { openFileStore } = await import('../src/lib/storage/files')
    for (const id of ['_packs', '../x', 'a/b', '']) await expect(openFileStore(id), id).rejects.toThrow(/bad owner id/)
  })
})

describe('writing', () => {
  beforeEach(() => vi.resetModules())

  it('writes large files in chunks of at most 4 MB, through a .part file renamed into place', async () => {
    const { cap, files, ownerId } = await nativeStore()
    const big = bytes(9 * 1024 * 1024 + 123)
    // Mixed parts, as the tile writer and the PDF import pass them.
    const parts: BlobPart[] = [big.slice(0, 1000), new Blob([big.slice(1000, 5_000_000)]), big.slice(5_000_000)]
    expect(await files.write('library/maps/m1/map.pmtiles', parts)).toBe(big.length)
    const target = `maps/${ownerId}/library/maps/m1/map.pmtiles`
    expect(cap.file(target)).toEqual(big)
    expect(cap.paths()).toEqual([target])
    const writes = cap.calls.filter((c) => c.method === 'writeFile' || c.method === 'appendFile')
    expect(writes.map((c) => c.method)).toEqual(['writeFile', 'appendFile', 'appendFile'])
    expect(writes.every((c) => c.options.path === `${target}.part`)).toBe(true)
    for (const w of writes) expect(Buffer.from(String(w.options.data), 'base64').length).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(cap.calls.find((c) => c.method === 'rename')?.options).toMatchObject({ from: `${target}.part`, to: target })
  })

  it('replaces an existing file', async () => {
    const { cap, files, ownerId } = await nativeStore()
    await files.write('a.bin', [bytes(50, 1)])
    await files.readRange('a.bin', 0, 4) // caches the size and URL
    await files.write('a.bin', [bytes(20, 2)])
    expect(cap.file(`maps/${ownerId}/a.bin`)).toEqual(bytes(20, 2))
    expect(await files.size('a.bin')).toBe(20)
    expect(new Uint8Array((await files.readRange('a.bin', 0, 100)))).toEqual(bytes(20, 2))
  })

  it('writes an empty file', async () => {
    const { cap, files, ownerId } = await nativeStore()
    expect(await files.write('empty.bin', [])).toBe(0)
    expect(cap.file(`maps/${ownerId}/empty.bin`)).toEqual(new Uint8Array(0))
    expect(await files.size('empty.bin')).toBe(0)
  })

  it('leaves the old file whole, and no .part, when a write fails half way', async () => {
    const { cap, files, ownerId } = await nativeStore()
    await files.write('a.bin', [bytes(30, 1)])
    cap.failNext('appendFile', () => new Error('disk full'))
    await expect(files.write('a.bin', [bytes(5 * 1024 * 1024, 2)])).rejects.toThrow('disk full')
    expect(cap.paths()).toEqual([`maps/${ownerId}/a.bin`])
    expect(cap.file(`maps/${ownerId}/a.bin`)).toEqual(bytes(30, 1))
  })

  it('rejects paths that leave the owner folder', async () => {
    const { files } = await nativeStore()
    for (const p of ['../u2/a.bin', '/a.bin', 'a/../../b', '']) await expect(files.write(p, [bytes(1)]), p).rejects.toThrow(/bad storage path/)
  })
})

describe('reading by range', () => {
  beforeEach(() => vi.resetModules())

  it('fetches only the bytes asked for, with a Range header, and checks for 206', async () => {
    const { cap, files } = await nativeStore()
    const data = bytes(100_000)
    await files.write('p.pmtiles', [data])
    cap.calls.length = 0
    expect(new Uint8Array(await files.readRange('p.pmtiles', 40_000, 1234))).toEqual(data.subarray(40_000, 41_234))
    expect(cap.fetches).toEqual([
      { url: expect.stringMatching(/^capacitor:\/\/localhost\/_capacitor_file_\/.*\/maps\/u\d+\/p\.pmtiles$/), range: 'bytes=40000-41233', status: 206 },
    ])
    // No base64 bridge reads on this path.
    expect(cap.calls.filter((c) => c.method === 'readFile')).toEqual([])
  })

  it('handles a range running past the end of the file (the handler overstates it)', async () => {
    const { files } = await nativeStore()
    await files.write('p.bin', [bytes(1000)])
    expect(new Uint8Array(await files.readRange('p.bin', 900, 16_384))).toEqual(bytes(1000).subarray(900))
    expect((await files.readRange('p.bin', 1000, 10)).byteLength).toBe(0)
    expect((await files.readRange('p.bin', 5, 0)).byteLength).toBe(0)
  })

  it('reads a whole file a megabyte at a time, never in one unranged request', async () => {
    const { cap, files } = await nativeStore()
    const data = bytes(2.5 * 1024 * 1024)
    await files.write('orig.pdf', [data])
    const blob = await files.read('orig.pdf')
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(data)
    expect(cap.fetches.map((f) => f.range)).toEqual(['bytes=0-1048575', 'bytes=1048576-2097151', 'bytes=2097152-2621439'])
  })

  for (const [mode, why] of [
    ['200', 'ignores Range and sends the whole file'],
    ['from0', 'answers 206 with the whole file from byte 0'],
    ['shifted', 'answers 206 from byte 0 and says so'],
    ['lying', 'answers 206 from byte 0 but claims the asked-for range'],
    ['fail', 'fails every request'],
  ] as const) {
    it(`falls back to readFile({ offset, length }) when the handler ${why}`, async () => {
      const { cap, files } = await nativeStore({ rangeMode: mode })
      const data = bytes(300_000)
      await files.write('p.pmtiles', [data])
      cap.fetches.length = 0
      expect(new Uint8Array(await files.readRange('p.pmtiles', 123_456, 789))).toEqual(data.subarray(123_456, 124_245))
      // Found out on the probe file when the store opened: no fetch of the pack at all.
      expect(cap.fetches).toEqual([])
      const read = cap.calls.filter((c) => c.method === 'readFile')
      expect(read.map((c) => [c.options.offset, c.options.length])).toEqual([[123_456, 789]])
      expect(cap.wholeFileResponses.every((r) => !(r.arrayBuffer as unknown as { mock: { calls: unknown[] } }).mock.calls.length)).toBe(true)
    })
  }

  it('switches to the fallback if a later response ignores Range, without reading that body', async () => {
    const { cap, files } = await nativeStore()
    const data = bytes(50_000)
    await files.write('p.pmtiles', [data])
    cap.state.rangeMode = '200'
    expect(new Uint8Array(await files.readRange('p.pmtiles', 10_000, 100))).toEqual(data.subarray(10_000, 10_100))
    expect(cap.wholeFileResponses).toHaveLength(1)
    expect((cap.wholeFileResponses[0].arrayBuffer as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0)
    cap.fetches.length = 0
    await files.readRange('p.pmtiles', 0, 10)
    expect(cap.fetches).toEqual([]) // stays on the fallback
  })

  for (const mode of ['from0', 'shifted'] as const) {
    it(`checks every 206 too: a later ${mode} response switches to the fallback`, async () => {
      const { cap, files } = await nativeStore()
      const data = bytes(50_000)
      await files.write('p.pmtiles', [data])
      cap.state.rangeMode = mode
      expect(new Uint8Array(await files.readRange('p.pmtiles', 10_000, 100))).toEqual(data.subarray(10_000, 10_100))
      expect(cap.calls.filter((c) => c.method === 'readFile')).toHaveLength(1)
      cap.fetches.length = 0
      await files.readRange('p.pmtiles', 0, 10)
      expect(cap.fetches).toEqual([])
    })
  }

  it('never asks readFile for length 0 (which would read the whole file)', async () => {
    const { cap, files } = await nativeStore({ rangeMode: '200' })
    await files.write('p.bin', [bytes(100)])
    expect((await files.readRange('p.bin', 100, 50)).byteLength).toBe(0)
    expect((await files.readRange('p.bin', 150, 50)).byteLength).toBe(0)
    expect(new Uint8Array(await files.readRange('p.bin', 90, 50))).toEqual(bytes(100).subarray(90))
    expect(cap.calls.filter((c) => c.method === 'readFile').every((c) => Number(c.options.length) > 0)).toBe(true)
  })

  it('never sends a request without Range, on any path', async () => {
    for (const mode of ['206', '200', 'from0', 'shifted', 'lying'] as const) {
      vi.resetModules()
      const { cap, files } = await nativeStore({ rangeMode: mode })
      await files.write('p.bin', [bytes(3 * 1024 * 1024)])
      await files.read('p.bin')
      await files.readRange('p.bin', 5, 5)
      expect(cap.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).has('Range')), mode).toBe(true)
    }
  })

  it('reports missing files: null from read and size, an error from readRange', async () => {
    const { files } = await nativeStore()
    expect(await files.read('nope.bin')).toBeNull()
    expect(await files.size('nope.bin')).toBeNull()
    await expect(files.readRange('nope.bin', 0, 10)).rejects.toThrow(/file not found/)
  })
})

describe('without native base64 (iOS 15–18.1; Node before 25)', () => {
  beforeEach(() => vi.resetModules())

  it('writes and reads the same bytes through the btoa/atob fallback', async () => {
    const proto = Uint8Array.prototype as unknown as Record<string, unknown>
    const ctor = Uint8Array as unknown as Record<string, unknown>
    const saved = { to: proto.toBase64, from: ctor.fromBase64 }
    delete proto.toBase64
    delete ctor.fromBase64
    try {
      const { files } = await nativeStore({ rangeMode: '200' }) // offset reads decode base64 too
      const data = bytes(5 * 1024 * 1024 + 17)
      await files.write('b.bin', [data])
      expect(new Uint8Array(await files.readRange('b.bin', 4 * 1024 * 1024 - 3, 10))).toEqual(data.subarray(4 * 1024 * 1024 - 3, 4 * 1024 * 1024 + 7))
      expect(new Uint8Array(await (await files.read('b.bin'))!.arrayBuffer())).toEqual(data)
    } finally {
      if (saved.to) proto.toBase64 = saved.to
      if (saved.from) ctor.fromBase64 = saved.from
    }
  })
})

describe('removing', () => {
  beforeEach(() => vi.resetModules())

  it('removes files and folders, and is fine when they are already gone', async () => {
    const { cap, files, ownerId } = await nativeStore()
    await files.write('library/maps/m1/map.pmtiles', [bytes(10)])
    await files.write('library/maps/m2/map.pmtiles', [bytes(10)])
    await files.write('library/originals/o.pdf', [bytes(10)])
    await files.removeDir('library/maps/m1')
    await files.remove('library/originals/o.pdf')
    await files.remove('library/originals/o.pdf')
    await files.removeDir('library/maps/m1')
    expect(cap.paths()).toEqual([`maps/${ownerId}/library/maps/m2/map.pmtiles`])
    expect(await files.size('library/maps/m1/map.pmtiles')).toBeNull()
  })
})

describe('a tiled map on the native store, read the way the map view reads it', () => {
  beforeEach(() => vi.resetModules())

  it('writes a PMTiles pyramid and reads every tile back by range', async () => {
    const { cap, files } = await nativeStore()
    const tiles: { z: number; x: number; y: number; data: Uint8Array }[] = []
    for (let z = 10; z <= 13; z++) {
      const n = 2 ** (z - 10)
      for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
        tiles.push({ z, x: 160 * n + x, y: 350 * n + y, data: bytes(2000 + ((x * 7 + y * 3 + z) % 500), z * 100 + x + y) })
      }
    }
    const plan = planPack(
      tiles.map((t) => ({ z: t.z, x: t.x, y: t.y, length: t.data.length })),
      {
        tileType: PmTileType.Webp,
        tileCompression: PmCompression.None,
        minZoom: 10,
        maxZoom: 13,
        bounds: [-123.75, 48.4, -123.4, 48.7],
        center: [-123.5, 48.5, 11],
        metadata: { format: 'webp' },
      },
    )
    const byKey = new Map(tiles.map((t) => [`${t.z}/${t.x}/${t.y}`, t.data]))
    const parts: BlobPart[] = [plan.prefix as Uint8Array<ArrayBuffer>]
    for (const t of plan.tiles) parts.push(new Blob([byKey.get(`${t.z}/${t.x}/${t.y}`)! as Uint8Array<ArrayBuffer>]))
    const path = 'library/maps/m1/map.pmtiles'
    expect(await files.write(path, parts)).toBe(plan.totalLength)

    cap.fetches.length = 0
    const reader = new PMTiles({
      getKey: () => path,
      getBytes: async (offset, length) => ({ data: await files.readRange(path, offset, length) }),
    })
    for (const t of tiles) {
      const got = await reader.getZxy(t.z, t.x, t.y)
      expect(new Uint8Array(got!.data), `${t.z}/${t.x}/${t.y}`).toEqual(t.data)
    }
    expect(cap.fetches.length).toBeGreaterThan(tiles.length)
    expect(cap.fetches.every((f) => f.status === 206 && f.range)).toBe(true)
  })
})

describe('rangeIsExact', () => {
  it('accepts what the iOS handler sends, and rejects wrong starts and lengths', async () => {
    const { rangeIsExact } = await import('../src/lib/storage/files')
    expect(rangeIsExact('bytes 100-199/1000', 100, 100, 100)).toBe(true)
    expect(rangeIsExact('bytes 900-1023/1000', 900, 124, 100)).toBe(true) // end overstated, bytes right
    expect(rangeIsExact('bytes 900-1023/1000', 900, 124, 124)).toBe(false)
    expect(rangeIsExact('bytes 0-99/1000', 100, 100, 100)).toBe(false) // sent from the start
    expect(rangeIsExact('bytes 100-199/1000', 100, 100, 150)).toBe(false)
    expect(rangeIsExact('bytes 100-199/*', 100, 100, 100)).toBe(true)
    expect(rangeIsExact(null, 100, 100, 100)).toBe(true)
    expect(rangeIsExact(null, 100, 100, 99)).toBe(false)
    expect(rangeIsExact('garbage', 100, 100, 100)).toBe(false)
  })
})
