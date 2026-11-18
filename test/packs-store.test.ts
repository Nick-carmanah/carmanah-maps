/**
 * The file-store calls fire packs add (append, rename, list), on the
 * website's IndexedDB fallback and the crew app's native store, and the
 * shared pack store `maps/_packs/` (never a person's folder).
 */
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockCapacitor } from './helpers/mock-capacitor'

afterEach(() => vi.unstubAllGlobals())

const bytes = (...v: number[]) => new Uint8Array(v)

describe('append, rename, list', () => {
  it('work on the IndexedDB store', async () => {
    vi.resetModules()
    const { openFileStore } = await import('../src/lib/storage/files')
    const files = await openFileStore('packs-idb-1')
    expect(files.backend).toBe('idb')
    expect(await files.append('p/a.part', bytes(1, 2))).toBe(2)
    expect(await files.append('p/a.part', bytes(3))).toBe(3)
    await files.rename('p/a.part', 'p/a.bin')
    expect(new Uint8Array(await files.readRange('p/a.bin', 0, 3))).toEqual(bytes(1, 2, 3))
    expect(await files.size('p/a.part')).toBeNull()
    await files.write('p/sub/x.json', ['{}'])
    expect(await files.list('p')).toEqual(['a.bin', 'sub'])
    expect(await files.list('')).toEqual(['p'])
    expect(await files.list('nothing')).toEqual([])
  })

  it('work on the native store, in maps/_packs/ for the shared pack store', async () => {
    vi.resetModules()
    const cap = mockCapacitor()
    cap.install()
    const { openSharedPackFiles } = await import('../src/lib/storage/files')
    const files = (await openSharedPackFiles())!
    expect(files.backend).toBe('native')
    await files.append('c1/basemap.pmtiles.part', bytes(1, 2))
    await files.append('c1/basemap.pmtiles.part', bytes(3, 4))
    expect(await files.size('c1/basemap.pmtiles.part')).toBe(4)
    await files.write('c1/basemap.pmtiles', [bytes(9)]) // an older copy is replaced by the rename
    await files.rename('c1/basemap.pmtiles.part', 'c1/basemap.pmtiles')
    expect(cap.file('maps/_packs/c1/basemap.pmtiles')).toEqual(bytes(1, 2, 3, 4))
    expect(new Uint8Array(await files.readRange('c1/basemap.pmtiles', 1, 2))).toEqual(bytes(2, 3))
    expect(await files.list('')).toEqual(['c1'])
    expect(await files.list('c1')).toEqual(['basemap.pmtiles'])
    expect(cap.paths().every((p) => p.startsWith('maps/_packs/'))).toBe(true)
    expect(cap.calls.every((c) => c.options.directory === 'LIBRARY_NO_CLOUD' || c.method === 'rename')).toBe(true)
  })

  it('is null on a website without OPFS (packs need a real file store)', async () => {
    vi.resetModules()
    const { openSharedPackFiles } = await import('../src/lib/storage/files')
    expect(await openSharedPackFiles()).toBeNull()
  })
})
