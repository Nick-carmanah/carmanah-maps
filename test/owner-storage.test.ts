/**
 * Shared phones (rebuild plan §0): every person's My Data, maps, files and
 * settings are their own, the website's pre-owner data moves into the guest
 * once without losing anything, and the crew app can remove one person.
 *
 * In-memory IndexedDB and localStorage, the crew app's native file store
 * mocked (test/helpers/mock-capacitor.ts). A "page load" re-imports the
 * modules, since the owner is fixed per page and stores are cached per page.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Layer } from '../src/lib/layers'
import type { UserFeature } from '../src/lib/features'
import { memoryStorage, mockCapacitor } from './helpers/mock-capacitor'

const NOW = Date.parse('2026-07-15T18:00:00Z')
const req = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

let storage = memoryStorage()
const signIn = (ownerId: string | null) => {
  if (ownerId === null) storage.removeItem('carmanah.mapsContext.v1')
  else storage.setItem('carmanah.mapsContext.v1', JSON.stringify({ ownerId, fireNumber: 'K61067' }))
}

/** One page load as whoever the hand-off names. */
async function pageLoad() {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  return {
    store: await import('../src/lib/store'),
    mydata: await import('../src/lib/mydata'),
    units: await import('../src/lib/units'),
    naming: await import('../src/lib/naming'),
    owner: await import('../src/lib/storage/owner'),
    files: await import('../src/lib/storage/files'),
    library: await import('../src/lib/library/library'),
    migration: await import('../src/lib/storage/legacy-migration'),
    deleteOwnerData: (await import('../src/lib/storage/delete-owner')).deleteOwnerData,
  }
}

const layer = (id: string, name: string): Layer =>
  ({ id, name, order: 0, visible: true, createdAt: NOW, style: { color: '#e11d1d' } }) as unknown as Layer
const pin = (id: string, layerId: string, name = id): UserFeature =>
  ({ id, kind: 'pin', name, notes: '', color: '#e11d1d', coordinates: [-123.36, 48.43], layerId, createdAt: NOW, updatedAt: NOW }) as UserFeature

async function databases() {
  return (await indexedDB.databases()).map((d) => d.name).sort()
}

async function rawAll(dbName: string, store: string) {
  const db = await req(indexedDB.open(dbName))
  try {
    if (!db.objectStoreNames.contains(store)) return []
    return await req(db.transaction(store).objectStore(store).getAll())
  } finally {
    db.close()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

/** What the website had saved before owners: the v6 shared database. */
const OLD = {
  layers: [layer('l-guards', 'Guards'), layer('l-perim', 'Perimeter')],
  features: [pin('f1', 'l-guards', 'Edge_JUL15'), pin('f2', 'l-perim', 'ICP')],
  photos: [{ id: 'p1', featureId: 'f1', blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), createdAt: NOW }],
  icons: [{ id: 'i1', name: 'files/hydrant.png', blob: new Blob([new Uint8Array(40).fill(9)], { type: 'image/png' }) }],
  overlays: [{ id: 'o1', name: 'Old perimeter', addedAt: NOW - 10, geojson: { type: 'FeatureCollection', features: [] } }],
  rasters: [
    {
      id: 'r1',
      name: 'Old map',
      addedAt: NOW - 5,
      corners: [[-123.4, 48.5], [-123.3, 48.5], [-123.3, 48.4], [-123.4, 48.4]],
      image: new Blob([new Uint8Array(300).fill(7)], { type: 'image/png' }),
    },
  ],
  kv: { 'migrated:layers-v1': true, livefires: { fetchedAt: NOW, points: { type: 'FeatureCollection', features: [] } } },
}

async function seedV6() {
  const open = indexedDB.open('carmanah-maps', 6)
  open.onupgradeneeded = () => {
    const db = open.result
    db.createObjectStore('overlays', { keyPath: 'id' })
    db.createObjectStore('kv')
    db.createObjectStore('features', { keyPath: 'id' })
    db.createObjectStore('photos', { keyPath: 'id' }).createIndex('byFeature', 'featureId')
    db.createObjectStore('rasters', { keyPath: 'id' })
    db.createObjectStore('layers', { keyPath: 'id' })
    db.createObjectStore('icons', { keyPath: 'id' })
  }
  const db = await req(open)
  const names = ['overlays', 'kv', 'features', 'photos', 'rasters', 'layers', 'icons']
  const tx = db.transaction(names, 'readwrite')
  for (const name of names) {
    if (name === 'kv') for (const [k, v] of Object.entries(OLD.kv)) tx.objectStore('kv').put(v, k)
    else for (const rec of OLD[name as keyof typeof OLD] as unknown[]) tx.objectStore(name).put(rec)
  }
  await new Promise((resolve) => (tx.oncomplete = resolve))
  db.close()
}

/** Add a record to the old database, as an older tab of the app still could. */
async function oldTabWrites(store: string, value: unknown) {
  const db = await req(indexedDB.open('carmanah-maps'))
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).put(value)
  await new Promise((resolve) => (tx.oncomplete = resolve))
  db.close()
}

describe('moving pre-owner data into the guest', () => {
  beforeAll(async () => {
    storage = memoryStorage()
    // The website's settings from before owners.
    storage.setItem('carmanah-unit-settings', JSON.stringify({ distance: 'chains', area: 'ac', coords: 'utm' }))
    storage.setItem('carmanah-profile', JSON.stringify({ callsign: '2P14', fireNumber: 'K61067' }))
    await seedV6()
  })

  it('copies every record into carmanah-maps.guest, field for field', async () => {
    signIn(null)
    const { store } = await pageLoad()
    expect(await store.listLayers()).toEqual(expect.arrayContaining(OLD.layers))
    expect(await store.listFeatures()).toEqual(OLD.features)
    const photos = await store.listPhotos('f1')
    expect(photos.map((p) => [p.id, p.blob.size, p.blob.type])).toEqual([['p1', 4, 'image/jpeg']])
    expect(new Uint8Array(await photos[0].blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect((await store.getIcon('i1'))?.blob.size).toBe(40)
    expect(await store.listOverlays()).toEqual(OLD.overlays)
    expect((await store.listRasters()).map((r) => [r.id, r.image.size])).toEqual([['r1', 300]])
    expect(await store.getCached('migrated:layers-v1')).toBe(true)
    for (const name of ['layers', 'features', 'photos', 'icons', 'overlays', 'rasters']) {
      expect((await rawAll('carmanah-maps.guest', name)).length, name).toBe((OLD[name as keyof typeof OLD] as unknown[]).length)
    }
  })

  it('keeps the live-fire cache shared, not in anyone\'s database', async () => {
    const { store } = await pageLoad()
    expect(await store.getCached('livefires')).toEqual(OLD.kv.livefires)
    expect((await rawAll('carmanah-maps.guest', 'kv'))).toEqual([true]) // only the layers flag
  })

  it('leaves the old database as it was, plus a mark naming every copied key', async () => {
    const db = await req(indexedDB.open('carmanah-maps'))
    expect(db.version).toBe(6)
    db.close()
    expect(await rawAll('carmanah-maps', 'features')).toEqual(OLD.features)
    expect(await rawAll('carmanah-maps', 'layers')).toHaveLength(2)
    const kvDb = await req(indexedDB.open('carmanah-maps'))
    const kv = kvDb.transaction('kv').objectStore('kv')
    expect((await req(kv.getAllKeys())).sort()).toEqual(['livefires', 'migrated:layers-v1', 'migrated:owner-v1'])
    const mark = (await req(kv.get('migrated:owner-v1'))) as { to: string; keys: Record<string, string[]> }
    kvDb.close()
    expect(mark.to).toBe('guest')
    expect(mark.keys).toEqual({
      layers: ['l-guards', 'l-perim'],
      features: ['f1', 'f2'],
      photos: ['p1'],
      icons: ['i1'],
      kv: ['migrated:layers-v1'],
      overlays: ['o1'],
      rasters: ['r1'],
    })
  })

  it('does nothing the second time: no duplicates, and what the guest changed stays changed', async () => {
    let { store, mydata } = await pageLoad()
    await store.saveFeature({ ...OLD.features[0], name: 'Renamed' })
    await store.deleteFeature('f2')
    ;({ store, mydata } = await pageLoad())
    const { features } = await mydata.loadMyData()
    expect(features.map((f) => [f.id, f.name])).toEqual([['f1', 'Renamed']])
    expect(await store.listLayers()).toHaveLength(2)
  })

  it('later picks up records an older tab added to the old database, and only those', async () => {
    await oldTabWrites('features', pin('f-late', 'l-guards', 'Added in an old tab'))
    await oldTabWrites('features', { ...OLD.features[0], name: 'Edited in an old tab' })
    const { store, migration } = await pageLoad()
    const names = (await store.listFeatures()).map((f) => [f.id, f.name]).sort()
    expect(names).toEqual([['f-late', 'Added in an old tab'], ['f1', 'Renamed']])
    expect((await migration.migrateLegacyData()).copied).toEqual({})
  })

  it("gives the website's old settings and profile to the guest, once", async () => {
    const { units, naming } = await pageLoad()
    expect(units.getUnitSettings()).toMatchObject({ distance: 'chains', area: 'ac', coords: 'utm' })
    expect(naming.getProfile()).toEqual({ callsign: '2P14', fireNumber: 'K61067' })
    expect(storage.getItem('carmanah-maps.guest.units')).toContain('chains')
    // The old keys stay as a backup.
    expect(storage.getItem('carmanah-unit-settings')).toContain('chains')
  })

  it('never gives pre-owner data to a signed-in person', async () => {
    signIn('u123')
    const { store, units, naming, library } = await pageLoad()
    expect(await store.listFeatures()).toEqual([])
    expect(await store.listLayers()).toEqual([])
    expect(await store.listRasters()).toEqual([])
    expect(await store.listOverlays()).toEqual([])
    expect(await store.getCached('migrated:layers-v1')).toBeUndefined()
    expect(units.getUnitSettings().distance).toBe('metric')
    expect(naming.getProfile()).toEqual({ callsign: '', fireNumber: '' })
    expect(await (await library.MapsLibrary.open('u123')).list()).toEqual([])
    signIn(null)
  })

  it("adopts old GeoPDF maps into the guest's library from the copied images", async () => {
    const { library } = await pageLoad()
    const maps = await (await library.MapsLibrary.open('guest')).list()
    expect(maps.map((m) => [m.id, m.raster])).toEqual([['r1', { kind: 'legacy', rasterId: 'r1' }]])
    expect((await (await library.MapsLibrary.open('guest')).readImage(maps[0]))?.size).toBe(300)
  })
})

describe('when the first copy fails', () => {
  beforeEach(() => {
    storage = memoryStorage()
  })
  afterEach(() => {
    vi.doUnmock('../src/lib/storage/legacy-migration')
  })

  async function failingMigration(firstCopy: boolean) {
    vi.resetModules()
    const real = await vi.importActual<typeof import('../src/lib/storage/legacy-migration')>('../src/lib/storage/legacy-migration')
    vi.doMock('../src/lib/storage/legacy-migration', () => ({
      ...real,
      migrateLegacyData: () => Promise.reject(new real.LegacyMigrationError(firstCopy, new Error('quota exceeded'))),
    }))
    vi.stubGlobal('localStorage', storage)
    return import('../src/lib/store')
  }

  it("doesn't answer with an empty My Data (which would hide the old data later)", async () => {
    const store = await failingMigration(true)
    await expect(store.listFeatures()).rejects.toThrow(/quota exceeded.*safe; reload/)
    await expect(store.writeBatch({ kv: { 'migrated:layers-v1': true } })).rejects.toThrow()
  })

  it('carries on if only a later top-up fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await failingMigration(false)
    await expect(store.listLayers()).resolves.toBeInstanceOf(Array)
  })
})

// ---------------------------------------------------------------------------

describe('two people on one phone', () => {
  let nativeFs: ReturnType<typeof mockCapacitor>

  beforeAll(async () => {
    nativeFs = mockCapacitor()
  })
  beforeEach(() => nativeFs.install())

  async function fillFor(ownerId: string) {
    signIn(ownerId)
    const p = await pageLoad()
    expect(p.owner.pageOwnerId()).toBe(ownerId)
    await p.store.writeBatch({
      layers: [layer(`l-${ownerId}`, `${ownerId} layer`)],
      features: [pin(`f-${ownerId}`, `l-${ownerId}`)],
      photos: [{ id: `p-${ownerId}`, featureId: `f-${ownerId}`, blob: new Blob(['x']), createdAt: NOW }],
      icons: [{ id: `i-${ownerId}`, name: 'i.png', blob: new Blob(['i']) }],
      kv: { [`flag-${ownerId}`]: ownerId },
    })
    await p.store.setCached('track-in-progress', { owner: ownerId })
    await p.store.saveRaster({ id: `r-${ownerId}`, name: 'r', addedAt: NOW, corners: OLD.rasters[0].corners as never, image: new Blob(['r']) })
    p.units.setUnitSettings({ distance: ownerId === 'alice' ? 'imperial' : 'nautical' })
    p.naming.saveProfile({ callsign: `${ownerId}-CS`, fireNumber: 'K61067' })
    const lib = await p.library.MapsLibrary.open(ownerId)
    expect(lib.files.backend).toBe('native')
    await lib.files.write('library/originals/a.pdf', [`pdf of ${ownerId}`])
    await lib.put({
      id: `m-${ownerId}`, name: `${ownerId} map`, folder: 'K61067', addedAt: NOW, corners: OLD.rasters[0].corners as never,
      visible: true, opacity: 1, raster: { kind: 'image', path: 'library/originals/a.pdf', width: 1, height: 1 }, storedBytes: 1,
    })
  }

  async function seenBy(ownerId: string | null) {
    signIn(ownerId)
    const p = await pageLoad()
    const lib = await p.library.MapsLibrary.open(p.owner.pageOwnerId())
    const original = await lib.files.read('library/originals/a.pdf')
    return {
      owner: p.owner.pageOwnerId(),
      layers: (await p.store.listLayers()).map((l) => l.id),
      features: (await p.store.listFeatures()).map((f) => f.id),
      photos: [...(await p.store.listPhotos('f-alice')), ...(await p.store.listPhotos('f-bob'))].map((x) => x.id),
      icons: [await p.store.getIcon('i-alice'), await p.store.getIcon('i-bob')].filter(Boolean).map((i) => i!.id),
      kv: [await p.store.getCached('flag-alice'), await p.store.getCached('flag-bob'), await p.store.getCached('track-in-progress')],
      rasters: (await p.store.listRasters()).map((r) => r.id),
      units: p.units.getUnitSettings().distance,
      profile: p.naming.getProfile().callsign,
      maps: (await lib.list()).map((m) => m.id),
      original: original ? await original.text() : null,
    }
  }

  it("shows each person only their own data, everywhere it's kept", async () => {
    await fillFor('alice')
    await fillFor('bob')
    expect(await seenBy('alice')).toEqual({
      owner: 'alice',
      layers: ['l-alice'],
      features: ['f-alice'],
      photos: ['p-alice'],
      icons: ['i-alice'],
      kv: ['alice', undefined, { owner: 'alice' }],
      rasters: ['r-alice'],
      units: 'imperial',
      profile: 'alice-CS',
      maps: ['m-alice'],
      original: 'pdf of alice',
    })
    expect(await seenBy('bob')).toMatchObject({ features: ['f-bob'], kv: [undefined, 'bob', { owner: 'bob' }], units: 'nautical', maps: ['m-bob'], original: 'pdf of bob' })
  })

  it("shows a signed-out phone (guest) neither person's data", async () => {
    // The guest here has the website's migrated data from the block above, and nothing else.
    const guest = await seenBy(null)
    expect(guest).toMatchObject({ owner: 'guest', photos: [], icons: [], kv: [undefined, undefined, undefined], original: null })
    const ids = [...guest.layers, ...guest.features, ...guest.rasters, ...guest.maps]
    expect(ids.filter((id) => /alice|bob/.test(id))).toEqual([])
    expect(ids.length).toBeGreaterThan(0)
    expect(guest.units).not.toMatch(/imperial|nautical/)
    expect(guest.profile).not.toMatch(/alice|bob/)
  })

  it("keeps each person's files in their own folder", () => {
    expect(nativeFs.paths()).toEqual(['maps/alice/library/originals/a.pdf', 'maps/bob/library/originals/a.pdf'])
  })

  it('falls back to guest for a hand-off that names a reserved or unsafe owner', async () => {
    for (const ownerId of ['_packs', '_x', '../bob', 'bob/..']) {
      signIn(ownerId)
      expect((await pageLoad()).owner.pageOwnerId(), ownerId).toBe('guest')
    }
  })

  it('fixes the owner for the page: a later hand-off change only counts after a reload', async () => {
    signIn('alice')
    const p = await pageLoad()
    expect(p.owner.pageOwnerId()).toBe('alice')
    signIn('bob')
    expect(p.owner.pageOwnerId()).toBe('alice')
    expect((await p.store.listFeatures()).map((f) => f.id)).toEqual(['f-alice'])
  })

  describe('deleteOwnerData', () => {
    beforeAll(async () => {
      // Shared things that must survive: a basemap pack and the live-fire cache.
      nativeFs.files.set('LIBRARY_NO_CLOUD/maps/_packs/bc-sample/pack.json', new TextEncoder().encode('{}'))
      nativeFs.files.set('LIBRARY_NO_CLOUD/maps/_packs/bc-sample/basemap.pmtiles', new Uint8Array(100))
      signIn('alice')
      await (await pageLoad()).store.setCached('livefires', { fetchedAt: NOW })
    })

    it("removes one person's database, files and settings", async () => {
      signIn(null) // the crew app has signed alice out
      const { deleteOwnerData } = await pageLoad()
      expect(await databases()).toContain('carmanah-maps.alice')
      await deleteOwnerData('alice')
      expect(await databases()).not.toContain('carmanah-maps.alice')
      expect(nativeFs.paths().filter((p) => p.startsWith('maps/alice'))).toEqual([])
      expect(Object.keys(Object.fromEntries(Array.from({ length: storage.length }, (_, i) => [storage.key(i)!, 1]))).filter((k) => k.includes('alice'))).toEqual([])
    })

    it('leaves everyone else and everything shared: other people, packs, live fires', async () => {
      expect(await databases()).toEqual(expect.arrayContaining(['carmanah-maps', 'carmanah-maps.bob']))
      expect(nativeFs.paths()).toEqual([
        'maps/_packs/bc-sample/basemap.pmtiles',
        'maps/_packs/bc-sample/pack.json',
        'maps/bob/library/originals/a.pdf',
      ])
      expect(storage.getItem('carmanah-maps.bob.units')).toContain('nautical')
      expect(await seenBy('bob')).toMatchObject({ features: ['f-bob'], maps: ['m-bob'], original: 'pdf of bob', profile: 'bob-CS' })
      expect(await (await pageLoad()).store.getCached('livefires')).toEqual({ fetchedAt: NOW })
    })

    it('shows the removed person a clean slate if they sign in again', async () => {
      expect(await seenBy('alice')).toEqual({
        owner: 'alice', layers: [], features: [], photos: [], icons: [], kv: [undefined, undefined, undefined],
        rasters: [], units: 'metric', profile: '', maps: [], original: null,
      })
    })

    it('is fine with someone who has no data, and refuses names that are not owners', async () => {
      const { deleteOwnerData } = await pageLoad()
      await expect(deleteOwnerData('nobody-here')).resolves.toBeUndefined()
      for (const id of ['_packs', '', '..', '../bob', 'a/b', 'maps']) {
        if (id === 'maps') continue // a valid (if odd) owner id: its folder would be maps/maps
        await expect(deleteOwnerData(id), id).rejects.toThrow(/not an owner id/)
      }
      expect(nativeFs.paths()).toContain('maps/_packs/bc-sample/pack.json')
    })

    it('lets go of a database another page still has open, so the removal finishes', async () => {
      signIn('bob')
      const open = await pageLoad()
      await open.store.listFeatures() // this "page" now holds carmanah-maps.bob open
      signIn(null)
      const { deleteOwnerData } = await pageLoad()
      await deleteOwnerData('bob')
      expect(await databases()).not.toContain('carmanah-maps.bob')
      expect(nativeFs.paths()).toEqual(['maps/_packs/bc-sample/basemap.pmtiles', 'maps/_packs/bc-sample/pack.json'])
    })

    it('still does the other steps if one fails, then says what failed', async () => {
      await fillFor('carol')
      signIn(null)
      const { deleteOwnerData } = await pageLoad()
      nativeFs.failNext('rmdir', () => new Error('disk busy'))
      await expect(deleteOwnerData('carol')).rejects.toThrow(/files: disk busy/)
      expect(await databases()).not.toContain('carmanah-maps.carol')
      expect(storage.getItem('carmanah-maps.carol.units')).toBeNull()
      nativeFs.failNext('rmdir', () => undefined)
      await deleteOwnerData('carol')
      expect(nativeFs.paths().filter((p) => p.startsWith('maps/carol'))).toEqual([])
    })
  })
})

describe('settings from before owners', () => {
  it('stay with the guest even when someone signed in opens the map first', async () => {
    storage = memoryStorage()
    storage.setItem('carmanah-unit-settings', JSON.stringify({ distance: 'nautical' }))
    storage.setItem('carmanah-profile', JSON.stringify({ callsign: 'OLD', fireNumber: '' }))
    signIn('u9')
    let p = await pageLoad()
    expect(p.units.getUnitSettings().distance).toBe('metric')
    expect(p.naming.getProfile().callsign).toBe('')
    signIn(null)
    p = await pageLoad()
    expect(p.units.getUnitSettings().distance).toBe('nautical')
    expect(p.naming.getProfile().callsign).toBe('OLD')
  })
})

describe('removing the guest', () => {
  it("doesn't bring the website's old data or settings back afterwards", async () => {
    // Continues from the first block's database: the guest has migrated data.
    storage = memoryStorage()
    storage.setItem('carmanah-unit-settings', JSON.stringify({ distance: 'chains' }))
    signIn(null)
    let p = await pageLoad()
    await p.store.listFeatures() // migrates (or finds the mark)
    expect(p.units.getUnitSettings().distance).toBe('chains')
    await p.deleteOwnerData('guest')
    p = await pageLoad()
    expect(await p.store.listFeatures()).toEqual([])
    expect(p.units.getUnitSettings().distance).toBe('metric')
    // The backup is still there, untouched.
    expect(await rawAll('carmanah-maps', 'features')).not.toEqual([])
  })
})
