import { GUEST_OWNER, pageOwnerId } from './owner'

/**
 * Small personal settings (units, call sign profile) that must be readable
 * before anything else draws, so they stay in localStorage, one key per
 * person: `carmanah-maps.<ownerId>.<name>`. The prefix matches the person's
 * database name, and deleteOwnerData() removes every key under it.
 *
 * Settings saved before owners existed were made on the website, where
 * everyone is a guest, so the guest adopts them once. The old keys stay as
 * they were (a backup), and a marker outside every owner's prefix records the
 * adoption, so removing the guest's data doesn't bring the old values back.
 */

export const ownerPrefPrefix = (ownerId: string) => `carmanah-maps.${ownerId}.`
export const ownerPrefKey = (name: string, ownerId: string = pageOwnerId()) => ownerPrefPrefix(ownerId) + name

/** `_` names are never owners (see owner.ts), so this key belongs to nobody. */
const ADOPTED_KEY = 'carmanah-maps._legacy-prefs-adopted'

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // blocked (private mode on some browsers)
  }
}

export function readStoredKey(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

/** This page's person's setting, or null. */
export function readOwnerPref(name: string): string | null {
  return readStoredKey(ownerPrefKey(name))
}

/** Best effort: if storage is full or blocked, the setting holds for this session only. */
export function writeOwnerPref(name: string, value: string): void {
  try {
    storage()?.setItem(ownerPrefKey(name), value)
  } catch {
    // ignore
  }
}

function adopted(): string[] {
  try {
    const list: unknown = JSON.parse(readStoredKey(ADOPTED_KEY) ?? '[]')
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : []
  } catch {
    return []
  }
}

/**
 * True once per phone, for the guest only: this setting may be read from its
 * pre-owner keys. The caller saves what it reads with writeOwnerPref.
 */
export function adoptLegacyPref(name: string): boolean {
  if (pageOwnerId() !== GUEST_OWNER) return false
  const done = adopted()
  if (done.includes(name)) return false
  try {
    storage()?.setItem(ADOPTED_KEY, JSON.stringify([...done, name]))
  } catch {
    // Can't record it: adopting again next time is harmless.
  }
  return true
}

/** Remove every setting of one person. Other people's keys and the old ones stay. */
export function removeOwnerPrefs(ownerId: string): void {
  const store = storage()
  if (!store) return
  const prefix = ownerPrefPrefix(ownerId)
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (key?.startsWith(prefix)) keys.push(key)
  }
  for (const key of keys) store.removeItem(key)
}
