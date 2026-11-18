import type { RequestParameters, ResourceType } from 'maplibre-gl'
import { getSharedCache, setSharedCache } from '../storage/shared-db'
import { packRegistry, type PackRegistry } from './registry'
import type { PackSource } from './manifest'

/**
 * How the map reads offline packs: packs first, then the network.
 *
 * The style keeps its normal network URLs (OpenFreeMap's TileJSON and
 * tiles, AWS terrain), so everything else that reads them (elevation, the
 * PDF export) is unchanged. A `transformRequest` hook sends a tile to the
 * `carmanah-pack://` protocol when a pack may hold it, with the network URL
 * along as the fallback. The TileJSON always goes through the protocol:
 * without it the basemap can't start offline in the crew app, where there's
 * no service worker to keep a copy.
 */

export const PACK_PROTOCOL = 'carmanah-pack'
/** Same as src/map/basemap.ts (not imported: that pulls in the whole style). */
export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet'
const TILEJSON_CACHE_KEY = 'openfreemap-tilejson'
const TILEJSON_TIMEOUT_MS = 4000

// With or without the weekly build version (the service worker's cache keys drop it).
const BASEMAP_TILE = /^https:\/\/tiles\.openfreemap\.org\/planet\/(?:[^/]+\/)?(\d+)\/(\d+)\/(\d+)\.pbf$/
const TERRAIN_TILE = /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/
const PACK_URL = /^carmanah-pack:\/\/tile\/(basemap|terrain)\/(\d+)\/(\d+)\/(\d+)\?u=(.+)$/

/** Which pack source and tile a network tile URL is, or null. */
export function tileOfUrl(url: string): { source: PackSource; z: number; x: number; y: number } | null {
  const b = BASEMAP_TILE.exec(url)
  if (b) return { source: 'basemap', z: +b[1], x: +b[2], y: +b[3] }
  const t = TERRAIN_TILE.exec(url)
  if (t) return { source: 'terrain', z: +t[1], x: +t[2], y: +t[3] }
  return null
}

/**
 * MapLibre's transformRequest: send tiles a pack may hold, and the basemap
 * TileJSON, through the pack protocol. Before the pack list is read every
 * tile goes that way (the protocol waits for the list); after, only tiles
 * inside a pack's bounds do, so with no packs nothing changes.
 */
export function packTransformRequest(url: string, _type?: ResourceType, registry: PackRegistry = packRegistry): RequestParameters | undefined {
  if (url === TILEJSON_URL) return { url: `${PACK_PROTOCOL}://tilejson` }
  const tile = tileOfUrl(url)
  if (!tile) return undefined
  if (registry.ready && !registry.candidates(tile.source, tile.z, tile.x, tile.y).length) return undefined
  return { url: `${PACK_PROTOCOL}://tile/${tile.source}/${tile.z}/${tile.x}/${tile.y}?u=${encodeURIComponent(url)}` }
}

let lastTileJson: unknown

/** A TileJSON for offline starts, built from the newest pack's planet build. */
function tileJsonFromPacks(registry: PackRegistry): unknown {
  for (const pack of registry.packs) {
    const build = pack.files.find((f) => f.source === 'basemap')?.build
    if (build) {
      return {
        tilejson: '3.0.0',
        tiles: [`https://tiles.openfreemap.org/planet/${build}/{z}/{x}/{y}.pbf`],
        minzoom: 0,
        maxzoom: 14,
        attribution:
          '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
      }
    }
  }
  return null
}

export interface ProtocolDeps {
  registry: PackRegistry
  fetch: typeof fetch
  getCache: (key: string) => Promise<unknown>
  setCache: (key: string, value: unknown) => Promise<void>
}

const defaultDeps = (): ProtocolDeps => ({
  registry: packRegistry,
  fetch: (...args) => fetch(...args),
  getCache: getSharedCache,
  setCache: setSharedCache,
})

async function tileJson(abort: AbortController, deps: ProtocolDeps): Promise<unknown> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), TILEJSON_TIMEOUT_MS)
  const onAbort = () => timeout.abort()
  abort.signal.addEventListener('abort', onAbort)
  try {
    const res = await deps.fetch(TILEJSON_URL, { signal: timeout.signal })
    if (res.ok) {
      const json = (await res.json()) as { tiles?: unknown }
      if (Array.isArray(json.tiles) && json.tiles.length) {
        lastTileJson = json
        void deps.setCache(TILEJSON_CACHE_KEY, json).catch(() => {})
        return json
      }
    }
  } catch {
    // Offline, or no answer in time: use a saved copy.
  } finally {
    clearTimeout(timer)
    abort.signal.removeEventListener('abort', onAbort)
  }
  if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError')
  const saved = await savedTileJson(deps)
  if (saved) return saved
  throw new Error('The basemap needs signal the first time (or an offline map)')
}

/** The basemap TileJSON without the network: the last one fetched, or one built from the packs. */
export async function savedTileJson(deps: ProtocolDeps = defaultDeps()): Promise<{ tiles?: string[] } | null> {
  const saved = lastTileJson ?? (await deps.getCache(TILEJSON_CACHE_KEY).catch(() => undefined))
  if (saved) return saved as { tiles?: string[] }
  await deps.registry.load()
  return tileJsonFromPacks(deps.registry) as { tiles?: string[] } | null
}

/** The pack protocol: tiles from packs, then the network; the TileJSON with offline fallbacks. */
export async function handlePackRequest(
  params: { url: string },
  abort: AbortController,
  deps: ProtocolDeps = defaultDeps(),
): Promise<{ data: unknown }> {
  if (params.url === `${PACK_PROTOCOL}://tilejson`) return { data: await tileJson(abort, deps) }
  const m = PACK_URL.exec(params.url)
  if (!m) throw new Error(`bad pack URL: ${params.url}`)
  const [, source, z, x, y, encoded] = m
  const data = await deps.registry.tile(source as PackSource, +z, +x, +y)
  if (data) return { data }
  const res = await deps.fetch(decodeURIComponent(encoded), { signal: abort.signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return { data: await res.arrayBuffer() }
}

/** A tile from the packs for a network tile URL, or null (no network). For elevation and the PDF export. */
export async function packTileForUrl(url: string, registry: PackRegistry = packRegistry): Promise<ArrayBuffer | null> {
  const tile = tileOfUrl(url)
  return tile ? registry.tile(tile.source, tile.z, tile.x, tile.y) : null
}

let registered = false

/**
 * Register the protocol with MapLibre and start reading the pack list. Call
 * before creating a map that uses packTransformRequest. Safe to call again.
 * MapLibre is passed in so this module stays loadable without it (tests).
 */
export function registerPackProtocol(maplibre: {
  addProtocol: (name: string, load: (params: RequestParameters, abort: AbortController) => Promise<{ data: unknown }>) => void
}): void {
  if (registered) return
  registered = true
  maplibre.addProtocol(PACK_PROTOCOL, (params, abort) => handlePackRequest(params, abort))
  void packRegistry.load()
}
