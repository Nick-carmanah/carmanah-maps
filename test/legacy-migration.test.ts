/**
 * The edges of moving pre-owner data into the guest (storage/legacy-migration.ts):
 * a copy that landed but was never marked, records an older tab writes after
 * the move, and a database from the very first release.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const req = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

async function seedOld(version: number, stores: Record<string, { keyPath?: string; records: [unknown, string?][] }>) {
  const open = indexedDB.open('carmanah-maps', version)
  open.onupgradeneeded = () => {
    for (const [name, s] of Object.entries(stores)) open.result.createObjectStore(name, s.keyPath ? { keyPath: s.keyPath } : undefined)
  }
  const db = await req(open)
  const tx = db.transaction(Object.keys(stores), 'readwrite')
  for (const [name, s] of Object.entries(stores)) for (const [value, key] of s.records) tx.objectStore(name).put(value, key)
  await new Promise((resolve) => (tx.oncomplete = resolve))
  db.close()
}

async function raw(dbName: string, store: string, key?: string) {
  const db = await req(indexedDB.open(dbName))
  try {
    const s = db.transaction(store).objectStore(store)
    return key === undefined ? await req(s.getAll()) : await req(s.get(key))
  } finally {
    db.close()
  }
}

async function modules() {
  vi.resetModules()
  return {
    migration: await import('../src/lib/storage/legacy-migration'),
    ownerDb: await import('../src/lib/storage/owner-db'),
    store: await import('../src/lib/store'),
  }
}

async function wipe() {
  // Earlier "pages" still hold connections; their blocking handlers let go.
  for (const name of ['carmanah-maps', 'carmanah-maps.guest']) {
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(name)
      r.onsuccess = resolve
      r.onerror = () => reject(r.error)
    })
  }
}

const feature = (id: string, name: string) => ({ id, name, kind: 'pin', layerId: 'l1', createdAt: 1, updatedAt: 1 })

beforeEach(wipe)
afterEach(() => vi.restoreAllMocks())

describe('legacy migration edges', () => {
  it('overwrites a copy that landed but was never marked (the old database was still the live one)', async () => {
    await seedOld(6, { features: { keyPath: 'id', records: [[feature('f1', 'current')]] }, kv: { records: [] } })
    const { migration, ownerDb } = await modules()
    // A copy from a run whose check or mark failed, then edits in the old database.
    await (await ownerDb.openOwnerDb('guest')).put('features', feature('f1', 'stale') as never)
    const report = await migration.migrateLegacyData()
    expect(report).toEqual({ copied: { features: 1 }, marked: true })
    expect(await raw('carmanah-maps.guest', 'features', 'f1')).toMatchObject({ name: 'current' })
  })

  it('after the mark, never overwrites the guest, even for a key an older tab writes again', async () => {
    await seedOld(6, { features: { keyPath: 'id', records: [[feature('f1', 'a')]] }, kv: { records: [] } })
    const { migration, store } = await modules()
    await migration.migrateLegacyData()
    await store.setCached('some-flag', 'set by the new app')
    const db = await req(indexedDB.open('carmanah-maps'))
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put('set by an old tab', 'some-flag')
    await new Promise((resolve) => (tx.oncomplete = resolve))
    db.close()
    const report = await (await modules()).migration.migrateLegacyData()
    expect(report.copied).toEqual({ kv: 0 })
    expect(await raw('carmanah-maps.guest', 'kv', 'some-flag')).toBe('set by the new app')
    const mark = (await raw('carmanah-maps', 'kv', 'migrated:owner-v1')) as { keys: Record<string, string[]> }
    expect(mark.keys.kv).toEqual(['some-flag'])
  })

  it('marks an old database that has the stores but nothing in them, so the guest is live from then on', async () => {
    await seedOld(6, { features: { keyPath: 'id', records: [] }, kv: { records: [] } })
    const { migration } = await modules()
    expect(await migration.migrateLegacyData()).toEqual({ copied: {}, marked: true })
    expect(await raw('carmanah-maps', 'kv', 'migrated:owner-v1')).toMatchObject({ to: 'guest', keys: {} })
  })

  it('reads a database from the first release (overlays only, no kv), adding kv for the mark', async () => {
    const overlay = { id: 'o1', name: 'Perimeter', addedAt: 5, geojson: { type: 'FeatureCollection', features: [] } }
    await seedOld(1, { overlays: { keyPath: 'id', records: [[overlay]] } })
    const { store } = await modules()
    expect(await store.listOverlays()).toEqual([overlay])
    const db = await req(indexedDB.open('carmanah-maps'))
    expect([db.version, [...db.objectStoreNames].sort()]).toEqual([2, ['kv', 'overlays']])
    db.close()
    expect(await raw('carmanah-maps', 'overlays')).toEqual([overlay])
  })

  it('does nothing on a new phone, and leaves the shared database with only kv', async () => {
    const { store } = await modules()
    expect(await store.listFeatures()).toEqual([])
    const db = await req(indexedDB.open('carmanah-maps'))
    expect([...db.objectStoreNames]).toEqual(['kv'])
    db.close()
  })
})

describe('sameValue', () => {
  it('compares records deeply, Blobs by size and type, binary by bytes', async () => {
    const { sameValue } = await import('../src/lib/storage/legacy-migration')
    expect(sameValue({ a: [1, { b: 'x' }], c: undefined }, { a: [1, { b: 'x' }], c: undefined })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameValue([1, 2], { 0: 1, 1: 2 })).toBe(false)
    expect(sameValue(new Blob(['abc'], { type: 't' }), new Blob(['xyz'], { type: 't' }))).toBe(true)
    expect(sameValue(new Blob(['abc']), new Blob(['abcd']))).toBe(false)
    expect(sameValue(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(sameValue(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(sameValue(new Uint8Array([1, 2]), new Uint16Array([1, 2]))).toBe(false)
    expect(sameValue(new Date(5), new Date(5))).toBe(true)
    expect(sameValue(NaN, NaN)).toBe(true)
  })
})
