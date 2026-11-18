/**
 * GeoPDFs saved before the Maps library (a PNG and corners in the old shared
 * database, store.ts `rasters`) must keep showing: the guest library adopts
 * each one as a 'legacy' map, once, and nobody else's library sees them.
 *
 * Runs on an in-memory IndexedDB. No OPFS here, so files fall back to
 * IndexedDB, and no createImageBitmap, so adopted maps get no thumbnail
 * (which the library allows). Each "page load" re-imports the modules, since
 * they keep one open library per owner for the life of the page.
 */
import 'fake-indexeddb/auto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Position } from 'geojson'

type Corners = [Position, Position, Position, Position]
const CORNERS_A: Corners = [[-123.4, 48.5], [-123.3, 48.5], [-123.3, 48.4], [-123.4, 48.4]]
const CORNERS_B: Corners = [[-120.1, 50.2], [-120.0, 50.21], [-119.99, 50.11], [-120.09, 50.1]]
const png = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'image/png' })

async function pageLoad() {
  vi.resetModules()
  const store = await import('../src/lib/store')
  const { MapsLibrary, DEFAULT_OPACITY } = await import('../src/lib/library/library')
  return { store, MapsLibrary, DEFAULT_OPACITY }
}

describe('legacy GeoPDF adoption', () => {
  beforeAll(async () => {
    // What main saved before the library: two maps in the shared database.
    const { store } = await pageLoad()
    await store.saveRaster({ id: 'old-a', name: 'Old map A', addedAt: 1_000, corners: CORNERS_A, image: png(300) })
    await store.saveRaster({ id: 'old-b', name: 'Old map B', addedAt: 2_000, corners: CORNERS_B, image: png(500) })
  })

  it('gives every old map a guest library record, newest first', async () => {
    const { MapsLibrary, DEFAULT_OPACITY } = await pageLoad()
    const maps = await (await MapsLibrary.open('guest')).list()
    expect(maps.map((m) => m.id)).toEqual(['old-b', 'old-a'])
    expect(maps[1]).toEqual({
      id: 'old-a',
      name: 'Old map A',
      folder: '',
      addedAt: 1_000,
      corners: CORNERS_A,
      visible: true,
      opacity: DEFAULT_OPACITY,
      raster: { kind: 'legacy', rasterId: 'old-a' },
      thumb: undefined,
      storedBytes: 300,
    })
    // No original was kept back then, so there is nothing to share or sharpen.
    expect(maps.every((m) => m.originalPath === undefined && m.source === undefined)).toBe(true)
  })

  it('still draws the old image from where it was saved', async () => {
    const { MapsLibrary } = await pageLoad()
    const library = await MapsLibrary.open('guest')
    const [b] = await library.list()
    const image = await library.readImage(b)
    expect(image?.size).toBe(500)
    expect(await library.readOriginal(b)).toBeNull()
  })

  it('does not give old maps to a signed-in owner', async () => {
    const { MapsLibrary } = await pageLoad()
    expect(await (await MapsLibrary.open('u123')).list()).toEqual([])
  })

  it('adopts once: the next load adds nothing and keeps what the user changed', async () => {
    let { MapsLibrary } = await pageLoad()
    await (await MapsLibrary.open('guest')).update('old-a', { name: 'Renamed', folder: 'K61067', opacity: 0.5 })
    ;({ MapsLibrary } = await pageLoad())
    const maps = await (await MapsLibrary.open('guest')).list()
    expect(maps).toHaveLength(2)
    expect(maps.find((m) => m.id === 'old-a')).toMatchObject({ name: 'Renamed', folder: 'K61067', opacity: 0.5 })
  })

  it('drops a record whose old image has gone', async () => {
    let { store, MapsLibrary } = await pageLoad()
    await store.deleteRaster('old-b')
    ;({ MapsLibrary } = await pageLoad())
    expect((await (await MapsLibrary.open('guest')).list()).map((m) => m.id)).toEqual(['old-a'])
  })

  it('deleting an old map deletes its image from the old database too', async () => {
    const { store, MapsLibrary } = await pageLoad()
    const library = await MapsLibrary.open('guest')
    await library.remove('old-a')
    expect(await library.list()).toEqual([])
    expect(await store.listRasters()).toEqual([])
  })
})
