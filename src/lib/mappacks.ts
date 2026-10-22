import type { LngLatBounds } from 'maplibre-gl'
import { GLYPHS_URL, MAP_FONT, SPRITE_URL, TILEJSON_URL } from '../map/basemap'

// Tiles are stored in the same Cache Storage bucket the service worker's
// CacheFirst handler reads from ('map-tiles'), so anything downloaded here is
// served automatically when offline.
const CACHE_NAME = 'map-tiles'

const TERRAIN_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

const MIN_Z = 6
/** Vector tiles stop at z14 and overzoom from there, so a saved area stays
 * sharp at any zoom. */
const BASEMAP_MAX_Z = 14
const TERRAIN_MAX_Z = 12
/** Refuse packs bigger than this — user should zoom in instead. Also
 * OpenFreeMap's per-download limit for offline areas. */
export const MAX_TILES = 3000
/** Rough average tile weight, for the size estimate shown to the user. */
export const AVG_TILE_KB = 30
/** Glyph ranges labels draw from: Latin, Latin extended, combining marks
 * (First Nations place names), punctuation. */
const GLYPH_RANGES = ['0-255', '256-511', '768-1023', '8192-8447']

/** OpenFreeMap tile URLs carry a weekly build version
 * (…/planet/20261018_080001_pt/14/2602/5629.pbf). Cache tiles without it so
 * saved areas keep matching after the version rolls over — the service
 * worker's cacheKeyWillBeUsed in vite.config.ts strips it the same way. */
function tileCacheKey(url: string): string {
  return url.replace(
    /^(https:\/\/tiles\.openfreemap\.org\/planet)\/[^/]+(\/\d+\/\d+\/\d+\.pbf)$/,
    '$1$2',
  )
}

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

function urlsForBounds(bounds: LngLatBounds, basemapTiles: string): string[] {
  const urls: string[] = []
  for (let z = MIN_Z; z <= BASEMAP_MAX_Z; z++) {
    const r = tileRange(bounds, z)
    for (let x = r.minX; x <= r.maxX; x++) {
      for (let y = r.minY; y <= r.maxY; y++) {
        urls.push(
          basemapTiles
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y)),
        )
        if (z <= TERRAIN_MAX_Z) urls.push(TERRAIN_URL(z, x, y))
      }
    }
  }
  return urls
}

/** Fonts and icons the basemap needs to draw labels and symbols offline. */
function styleAssetUrls(): string[] {
  const glyphs = GLYPH_RANGES.map((range) =>
    GLYPHS_URL.replace('{fontstack}', encodeURIComponent(MAP_FONT)).replace('{range}', range),
  )
  const sprites = ['', '@2x'].flatMap((ratio) => [
    `${SPRITE_URL}${ratio}.json`,
    `${SPRITE_URL}${ratio}.png`,
  ])
  return [...glyphs, ...sprites]
}

export function estimateTileCount(bounds: LngLatBounds): number {
  let count = 0
  for (let z = MIN_Z; z <= BASEMAP_MAX_Z; z++) {
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
  if (estimateTileCount(bounds) > MAX_TILES) {
    throw new Error('Area too large — zoom in further and try again')
  }
  const cache = await caches.open(CACHE_NAME)

  // Tile URLs carry this week's build version, so read them from the TileJSON —
  // and keep a copy so the map can find its tiles when it starts offline.
  const tilejson = await fetch(TILEJSON_URL).catch(() => undefined)
  if (!tilejson?.ok) {
    throw new Error('Can’t reach the map server — check your connection and try again')
  }
  const { tiles } = (await tilejson.clone().json()) as { tiles: string[] }
  await cache.put(TILEJSON_URL, tilejson)

  const urls = [...urlsForBounds(bounds, tiles[0]), ...styleAssetUrls()]
  const result: PackResult = { fetched: 0, alreadyCached: 0, failed: 0 }
  let done = 0
  let index = 0

  // OpenFreeMap's offline-download terms allow at most 4 parallel requests.
  const WORKERS = 4
  const worker = async () => {
    while (index < urls.length) {
      const url = urls[index++]
      const key = tileCacheKey(url)
      try {
        if (await cache.match(key)) {
          result.alreadyCached++
        } else {
          const res = await fetch(url)
          if (res.ok) {
            await cache.put(key, res)
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
