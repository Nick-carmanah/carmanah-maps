import maplibregl from 'maplibre-gl'
import type { PMTiles, RangeResponse, Source } from 'pmtiles'
import type { FileStore } from '../storage/files'

/**
 * MapLibre reads library maps' tiles through a custom protocol:
 * `carmanah-map://<mapId>/{z}/{x}/{y}`. Each map is one PMTiles archive in
 * the owner's file store, read by byte range (OPFS/IndexedDB on the web; a
 * Capacitor store would use a Range fetch, docs/native-storage-spike.md §5).
 * Nothing goes over the network, so it works offline with no service worker.
 */
export const MAP_TILE_PROTOCOL = 'carmanah-map'

export const mapTileUrl = (mapId: string) => `${MAP_TILE_PROTOCOL}://${mapId}/{z}/{x}/{y}`

class FileStoreSource implements Source {
  constructor(
    private files: FileStore,
    private path: string,
  ) {}

  getKey() {
    return this.path
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: await this.files.readRange(this.path, offset, length) }
  }
}

type Resolve = (mapId: string) => { files: FileStore; path: string } | null

let resolve: Resolve = () => null
const archives = new Map<string, { path: string; pmtiles: PMTiles }>()
let registered = false

/** Point the protocol at the current owner's maps. Safe to call again. */
export function registerMapTileProtocol(resolver: Resolve): void {
  resolve = resolver
  archives.clear()
  if (registered) return
  registered = true
  maplibregl.addProtocol(MAP_TILE_PROTOCOL, async (params) => {
    const m = /^[a-z-]+:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(params.url)
    if (!m) throw new Error(`bad map tile URL: ${params.url}`)
    const [, mapId, z, x, y] = m
    const target = resolve(mapId)
    if (!target) throw new Error(`no such map: ${mapId}`)
    let archive = archives.get(mapId)
    if (!archive || archive.path !== target.path) {
      // The reader loads with the first tile (it's only needed once a tiled map is shown).
      const { PMTiles } = await import('pmtiles')
      archive = { path: target.path, pmtiles: new PMTiles(new FileStoreSource(target.files, target.path)) }
      archives.set(mapId, archive)
    }
    const tile = await archive.pmtiles.getZxy(Number(z), Number(x), Number(y))
    // No tile here (outside a rotated map's corners): MapLibre draws nothing.
    return { data: tile?.data ?? new ArrayBuffer(0) }
  })
}

/** Forget a map's archive (after delete or re-render). */
export function forgetMapTiles(mapId: string): void {
  archives.delete(mapId)
}
