import { getSharedCache, setSharedCache } from '../storage/shared-db'
import type { Bbox } from './area.ts'
import { parseCatalog, type Catalog, type CatalogSource } from './manifest.ts'

/**
 * The hosted catalog (docs/hosting-r2.md §2): which area-wide archives and
 * ready-made packs the bucket offers. Its base URL is a build setting,
 * `VITE_PACKS_URL` (e.g. https://tiles.example.com/). Unset means no hosted
 * packs: the app then offers only small areas straight from OpenFreeMap.
 */
export const PACKS_URL: string = normalise((import.meta.env.VITE_PACKS_URL as string | undefined) ?? '')

function normalise(url: string): string {
  const u = url.trim()
  return !u ? '' : u.endsWith('/') ? u : `${u}/`
}

const CACHE_KEY = 'pack-catalog'

export interface LoadedCatalog {
  catalog: Catalog
  /** URL the catalog came from; its relative URLs resolve against it. */
  url: string
  /** False when this is the last saved copy (no signal). */
  fresh: boolean
}

/** The catalog from the bucket, or the last copy saved on this phone. null when hosting isn't set up. */
export async function loadCatalog(base = PACKS_URL, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<LoadedCatalog | null> {
  if (!base) return null
  const url = `${base}catalog.json`
  try {
    const res = await fetchImpl(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`)
    const catalog = parseCatalog(await res.json())
    void setSharedCache(CACHE_KEY, { catalog, url }).catch(() => {})
    return { catalog, url, fresh: true }
  } catch (err) {
    const saved = (await getSharedCache<{ catalog: unknown; url: string }>(CACHE_KEY).catch(() => undefined)) ?? undefined
    if (saved?.url === url) {
      try {
        return { catalog: parseCatalog(saved.catalog), url, fresh: false }
      } catch {
        // fall through
      }
    }
    throw err
  }
}

const contains = (outer: Bbox, inner: Bbox) =>
  inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
const overlaps = (a: Bbox, b: Bbox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

/** The archive to cut an area from: one that contains it, else the one that overlaps it. */
export function sourceFor(sources: CatalogSource[], bbox: Bbox): CatalogSource | null {
  return sources.find((s) => contains(s.bounds, bbox)) ?? sources.find((s) => overlaps(s.bounds, bbox)) ?? null
}

export const resolveUrl = (url: string, catalogUrl: string) => new URL(url, catalogUrl).href
