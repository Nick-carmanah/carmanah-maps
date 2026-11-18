import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import { PMTILES_PROTOCOL } from './satellite-source'

let registered = false

/**
 * Let MapLibre read pmtiles://<https URL> sources (our Sentinel-2 file) with
 * HTTP Range requests. With metadata on, the file's own credit and zooms go
 * into the source's TileJSON.
 *
 * Tiles inside the file's bounds but outside the area it covers (e.g. past
 * the BC border) aren't in the file. The reader answers those with no data,
 * which MapLibre never finishes loading for raster tiles, so they come back
 * as an empty image instead.
 */
export function registerSatelliteProtocol(): void {
  if (registered) return
  registered = true
  const protocol = new Protocol({ metadata: true })
  maplibregl.addProtocol(PMTILES_PROTOCOL, async (params, abortController) => {
    const res = await protocol.tilev4(params, abortController)
    if (params.type === 'json' || res.data) return res
    return { data: await createImageBitmap(new ImageData(1, 1)) }
  })
}
