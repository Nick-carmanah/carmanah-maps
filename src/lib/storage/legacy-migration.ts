import { GUEST_OWNER } from './owner'
import { MY_DATA_STORES, openOwnerDb, type MyDataStore } from './owner-db'
import { openSharedDb, SHARED_CACHE_KEYS, type SharedDB } from './shared-db'

/**
 * Moving My Data from the shared `carmanah-maps` database (everything before
 * owners) into the guest's own `carmanah-maps.guest`, once per phone.
 *
 * Only the guest: data made before owners existed was made on the website,
 * where everyone is a guest. A signed-in person never sees it.
 *
 * Nothing is lost on the way:
 *  1. Read every record not copied before (all of them, the first time).
 *  2. Write them into the guest database in ONE transaction: all or nothing.
 *  3. Read them back and compare, record by record.
 *  4. Only then mark the old database: MIGRATED_KEY in its `kv` lists every
 *     key copied. The old records themselves stay, untouched, as a backup
 *     until a later release removes them (after checking this mark).
 *
 * Until the mark exists the old database is the only copy that was ever
 * used, so the first copy overwrites anything already in the guest's stores
 * (a copy that never got marked). After that the guest database is the live
 * one: later runs only add records that have appeared in the old database
 * since (an older tab of the app still writing there), never overwrite, and
 * never bring back something the guest deleted.
 */

export const MIGRATED_KEY = 'migrated:owner-v1'

export interface MigrationMark {
  to: typeof GUEST_OWNER
  at: number
  /** Every key copied so far, per store. */
  keys: Partial<Record<MyDataStore, IDBValidKey[]>>
}

export interface MigrationReport {
  /** Records copied this time, per store. */
  copied: Partial<Record<MyDataStore, number>>
  /** True if this run wrote or updated the mark. */
  marked: boolean
}

type Rec = { key: IDBValidKey; value: unknown }

/** kv keys in the old database that are not personal: they stay there. */
const isSharedKv = (key: IDBValidKey) =>
  typeof key === 'string' && (SHARED_CACHE_KEYS.has(key) || key === MIGRATED_KEY)

/**
 * Why a run failed, and whether it was the first copy. Until the first copy
 * has landed and been checked, the guest's database is incomplete and must
 * not be used (it would look empty, and code that saw nothing to migrate
 * could set flags that hide old data later). A later top-up failing only
 * delays records an older tab wrote since; the guest database is fine.
 */
export class LegacyMigrationError extends Error {
  constructor(
    readonly firstCopy: boolean,
    cause: unknown,
  ) {
    super(`couldn't move saved data into per-person storage: ${(cause as Error)?.message ?? cause}`, { cause })
  }
}

export async function migrateLegacyData(): Promise<MigrationReport> {
  let first = true
  try {
    const old = await openSharedDb()
    const mark = old.objectStoreNames.contains('kv')
      ? ((await old.get('kv', MIGRATED_KEY)) as MigrationMark | undefined)
      : undefined
    first = !mark
    return await copy(old, mark)
  } catch (err) {
    throw new LegacyMigrationError(first, err)
  }
}

async function copy(old: SharedDB, mark: MigrationMark | undefined): Promise<MigrationReport> {
  const first = !mark
  const stores = MY_DATA_STORES.filter((s) => old.objectStoreNames.contains(s))
  const report: MigrationReport = { copied: {}, marked: false }
  if (!stores.length) return report // a new phone: nothing from before owners

  // 1. Everything not copied yet, read in one transaction.
  const todo = new Map<MyDataStore, Rec[]>()
  const rtx = old.transaction(stores, 'readonly')
  await Promise.all(
    stores.map(async (name) => {
      const store = rtx.objectStore(name)
      const done = new Set(mark?.keys[name] ?? [])
      const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()])
      const recs: Rec[] = []
      keys.forEach((key, i) => {
        if (done.has(key) || (name === 'kv' && isSharedKv(key))) return
        recs.push({ key, value: values[i] })
      })
      if (recs.length) todo.set(name, recs)
    }),
  )
  await rtx.done

  if (!todo.size) {
    if (first) {
      // The old database has the stores but nothing in them: mark it anyway,
      // so from now on the guest database is the live one.
      await old.put('kv', { to: GUEST_OWNER, at: Date.now(), keys: {} } satisfies MigrationMark, MIGRATED_KEY)
      report.marked = true
    }
    return report
  }

  // 2. One transaction into the guest's database.
  const guest = await openOwnerDb(GUEST_OWNER)
  const names = [...todo.keys()]
  const written = new Map<MyDataStore, Rec[]>()
  const wtx = guest.transaction(names, 'readwrite')
  await Promise.all(
    names.map(async (name) => {
      const store = wtx.objectStore(name)
      const out: Rec[] = []
      for (const rec of todo.get(name)!) {
        // After the first run the guest database is live: never overwrite it.
        if (!first && (await store.count(rec.key as never)) > 0) continue
        if (store.keyPath === null) await store.put(rec.value as never, rec.key as never)
        else await store.put(rec.value as never)
        out.push(rec)
      }
      written.set(name, out)
    }),
  )
  await wtx.done

  // 3. Read back: what we wrote must be exactly there, and everything else present.
  const vtx = guest.transaction(names, 'readonly')
  const problems: string[] = []
  await Promise.all(
    names.map(async (name) => {
      const store = vtx.objectStore(name)
      const wrote = new Set(written.get(name)!.map((r) => r.key))
      for (const rec of todo.get(name)!) {
        const back = await store.get(rec.key as never)
        if (back === undefined) problems.push(`${name}/${String(rec.key)} missing`)
        else if (wrote.has(rec.key) && !sameValue(back, rec.value)) problems.push(`${name}/${String(rec.key)} differs`)
      }
    }),
  )
  await vtx.done
  if (problems.length) {
    throw new Error(`copy check failed (${problems.slice(0, 3).join(', ')}${problems.length > 3 ? ', …' : ''})`)
  }

  // 4. Mark the old records as copied.
  const keys: MigrationMark['keys'] = { ...mark?.keys }
  for (const [name, recs] of todo) keys[name] = [...(keys[name] ?? []), ...recs.map((r) => r.key)]
  await old.put('kv', { to: GUEST_OWNER, at: Date.now(), keys } satisfies MigrationMark, MIGRATED_KEY)
  for (const [name, recs] of written) report.copied[name] = recs.length
  report.marked = true
  return report
}

/**
 * Deep equality for stored records. Blobs compare by size and type (their
 * bytes are copied by the database, not by us); binary arrays by bytes.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Blob || b instanceof Blob) {
    return a instanceof Blob && b instanceof Blob && a.size === b.size && a.type === b.type
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  }
  const bytes = (v: object) =>
    v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null
  const ba = bytes(a)
  const bb = bytes(b)
  if (ba || bb) {
    if (!ba || !bb || ba.length !== bb.length || a.constructor !== b.constructor) return false
    return ba.every((x, i) => x === bb[i])
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue((a as never)[k], (b as never)[k]))
}
