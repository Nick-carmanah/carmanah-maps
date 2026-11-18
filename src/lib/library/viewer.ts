import { ownerPrefKey, readStoredKey } from '../storage/prefs'

/**
 * Which map is open, Avenza style: pick a map on My Maps, then view only that
 * map. The choice and two viewer settings are remembered per person, as small
 * settings in localStorage (`carmanah-maps.<ownerId>.<name>`, storage/prefs.ts),
 * so deleteOwnerData() removes them with the rest of that person's data.
 */

/** The plain base map (no custom map), or one map from the library. */
export type MapChoice = { kind: 'base' } | { kind: 'map'; id: string }

export const BASE_MAP: MapChoice = { kind: 'base' }

export const LAST_MAP_PREF = 'lastMap'
export const BASEMAP_AROUND_PREF = 'basemapAroundMap'
export const MAPS_SORT_PREF = 'mapsSort'

export type MapsSort = 'folders' | 'nearest'

/** Library ids are UUIDs or legacy raster ids: plain, short tokens. */
const MAP_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export function serializeMapChoice(choice: MapChoice): string {
  return choice.kind === 'base' ? 'base' : `map:${choice.id}`
}

/** Read a stored choice; anything unexpected reads as nothing remembered. */
export function parseMapChoice(raw: string | null): MapChoice | null {
  if (raw === 'base') return BASE_MAP
  if (raw?.startsWith('map:')) {
    const id = raw.slice(4)
    if (MAP_ID_RE.test(id)) return { kind: 'map', id }
  }
  return null
}

export const sameChoice = (a: MapChoice, b: MapChoice) =>
  a.kind === b.kind && (a.kind === 'base' || a.id === (b as { id: string }).id)

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage full or blocked: it holds for this session only.
  }
}

/** The map this person last had open, if any. */
export function readLastMap(ownerId: string): MapChoice | null {
  return parseMapChoice(readStoredKey(ownerPrefKey(LAST_MAP_PREF, ownerId)))
}

export function saveLastMap(ownerId: string, choice: MapChoice | null): void {
  write(ownerPrefKey(LAST_MAP_PREF, ownerId), choice && serializeMapChoice(choice))
}

/** Show the base map around a custom map's edge (off by default, as in Avenza). */
export function readBasemapAround(ownerId: string): boolean {
  return readStoredKey(ownerPrefKey(BASEMAP_AROUND_PREF, ownerId)) === '1'
}

export function saveBasemapAround(ownerId: string, on: boolean): void {
  write(ownerPrefKey(BASEMAP_AROUND_PREF, ownerId), on ? '1' : '0')
}

export function readMapsSort(ownerId: string): MapsSort {
  return readStoredKey(ownerPrefKey(MAPS_SORT_PREF, ownerId)) === 'nearest' ? 'nearest' : 'folders'
}

export function saveMapsSort(ownerId: string, sort: MapsSort): void {
  write(ownerPrefKey(MAPS_SORT_PREF, ownerId), sort)
}

/**
 * Where the app opens: back in the last map, or on My Maps when nothing was
 * open before or that map has since been deleted. `mapIds` is null while the
 * library is still loading: a remembered map is trusted until it has loaded.
 */
export function startupChoice(last: MapChoice | null, mapIds: ReadonlySet<string> | null): MapChoice | null {
  if (!last) return null
  if (last.kind === 'base') return last
  if (mapIds && !mapIds.has(last.id)) return null
  return last
}
