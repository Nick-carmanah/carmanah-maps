import type { RasterSourceSpecification } from 'maplibre-gl'

/**
 * Our own satellite imagery: Copernicus Sentinel-2 over BC (10 m, newest
 * quarterly cloud-free mosaic), one PMTiles file built by scripts/imagery
 * and hosted on R2. Its licence allows offline use and printing.
 *
 * This is the one setting: VITE_SATELLITE_PMTILES_URL, the file's public
 * https URL, given when the app is built. The website gets it from
 * .github/workflows/deploy.yml; the crew app's build passes it to
 * `npm run build:embedded` (docs/crew-app-handoff.md §1). Not set, or the
 * file not there yet: satellite is Esri World Imagery, online only.
 */
export const SATELLITE_PMTILES_URL: string = (import.meta.env.VITE_SATELLITE_PMTILES_URL ?? '').trim()

/** Esri World Imagery. Online only: its terms allow offline use only inside
 * Esri software, so the service worker doesn't cache these tiles and Save
 * offline doesn't download them (see src/lib/satellite-signal.ts). */
export const ESRI_IMAGERY_TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
export const ESRI_ATTRIBUTION = 'Imagery: Esri, Vantor, Earthstar Geographics, and the GIS User Community'

export type SatelliteKind = 'sentinel' | 'esri'

/** MapLibre protocol the Sentinel-2 file is read through (pmtiles://<url>). */
export const PMTILES_PROTOCOL = 'pmtiles'

export function initialSatelliteKind(url = SATELLITE_PMTILES_URL): SatelliteKind {
  return url ? 'sentinel' : 'esri'
}

export function satelliteSource(kind: SatelliteKind, url = SATELLITE_PMTILES_URL): RasterSourceSpecification {
  if (kind === 'sentinel' && url) {
    // Zooms, bounds and the credit ("Contains modified Copernicus Sentinel
    // data <year>") come from the file itself. Past its last zoom (13 for
    // 10 m data) MapLibre enlarges the last tiles.
    return { type: 'raster', url: `${PMTILES_PROTOCOL}://${url}`, tileSize: 256 }
  }
  return {
    type: 'raster',
    tiles: [ESRI_IMAGERY_TILE_URL],
    tileSize: 256,
    maxzoom: 19,
    attribution: ESRI_ATTRIBUTION,
  }
}

/**
 * Can the Sentinel-2 file be read? 'missing' means the server answered with
 * an error (the file isn't uploaded yet, or the URL is wrong): use Esri
 * online. 'unreachable' means no answer at all (no signal).
 */
export async function checkSentinelFile(
  url = SATELLITE_PMTILES_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'missing' | 'unreachable'> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetchImpl(url, {
      headers: { Range: 'bytes=0-126' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) return 'missing'
    const bytes = new Uint8Array(await res.arrayBuffer())
    // "PMTiles" magic, spec version 3.
    const magic = String.fromCharCode(...bytes.slice(0, 7))
    return magic === 'PMTiles' && bytes[7] === 3 ? 'ok' : 'missing'
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}
