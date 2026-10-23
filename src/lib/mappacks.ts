import type { LngLatBounds } from 'maplibre-gl'

// Tiles are stored in the same Cache Storage bucket the service worker's
// CacheFirst handler reads from ('map-tiles'), so anything downloaded here is
// served automatically when offline.
const CACHE_NAME = 'map-tiles'

const OSM_URL = (z: number, x: number, y: number) =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
const TERRAIN_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

const MIN_Z = 6
const OSM_MAX_Z = 14
const TERRAIN_MAX_Z = 12
/** Refuse packs bigger than this — user should zoom in instead. */
export const MAX_TILES = 3000
/** Rough average tile weight, for the size estimate shown to the user. */
export const AVG_TILE_KB = 30

interface TileRange {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

function tileRange(bounds: LngLatBounds, z: number): TileRange {
  const n = 2 ** z
  const lonToX = (lon: number) => Math.floor(((lon + 180) / 360) * n)
  const latToY = (lat: number) => {
    const clamped = Math.max(-85.0511, Math.min(85.0511, lat))
    const rad = (clamped * Math.PI) / 180
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  }
  return {
    minX: Math.max(0, lonToX(bounds.getWest())),
    maxX: Math.min(n - 1, lonToX(bounds.getEast())),
    minY: Math.max(0, latToY(bounds.getNorth())),
    maxY: Math.min(n - 1, latToY(bounds.getSouth())),
  }
}

function urlsForBounds(bounds: LngLatBounds): string[] {
  const urls: string[] = []
  for (let z = MIN_Z; z <= OSM_MAX_Z; z++) {
    const r = tileRange(bounds, z)
    for (let x = r.minX; x <= r.maxX; x++) {
      for (let y = r.minY; y <= r.maxY; y++) {
        urls.push(OSM_URL(z, x, y))
        if (z <= TERRAIN_MAX_Z) urls.push(TERRAIN_URL(z, x, y))
      }
    }
  }
  return urls
}

export function estimateTileCount(bounds: LngLatBounds): number {
  let count = 0
  for (let z = MIN_Z; z <= OSM_MAX_Z; z++) {
    const r = tileRange(bounds, z)
    const cells = (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1)
    count += z <= TERRAIN_MAX_Z ? cells * 2 : cells
  }
  return count
}

export interface PackResult {
  fetched: number
  alreadyCached: number
  failed: number
}

export async function downloadMapPack(
  bounds: LngLatBounds,
  onProgress: (done: number, total: number) => void,
): Promise<PackResult> {
  const urls = urlsForBounds(bounds)
  if (urls.length > MAX_TILES) {
    throw new Error('Area too large — zoom in further and try again')
  }
  const cache = await caches.open(CACHE_NAME)
  const result: PackResult = { fetched: 0, alreadyCached: 0, failed: 0 }
  let done = 0
  let index = 0

  // Modest concurrency: OSM's usage policy allows at most 2 parallel downloads.
  const WORKERS = 2
  const worker = async () => {
    while (index < urls.length) {
      const url = urls[index++]
      try {
        if (await cache.match(url)) {
          result.alreadyCached++
        } else {
          const res = await fetch(url)
          if (res.ok) {
            await cache.put(url, res)
            result.fetched++
          } else {
            result.failed++
          }
        }
      } catch {
        result.failed++
      }
      onProgress(++done, urls.length)
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
  return result
}
