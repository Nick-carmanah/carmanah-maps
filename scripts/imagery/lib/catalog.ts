// The bucket's catalog.json (docs/hosting-r2.md): imagery files are listed
// under "sources.imagery", shaped like the basemap and terrain entries. The
// bucket's LICENSE.txt points here for each imagery file's licence and credit.

export interface ImageryEntry {
  area: string
  /** e.g. s2-quarterly (Copernicus Sentinel-2 quarterly mosaic) */
  product: string
  /** e.g. 2026-q3 */
  period: string
  /** Bucket key, relative to the catalog: imagery/<product>/<area>/<period>.pmtiles */
  url: string
  bounds: [number, number, number, number]
  minzoom: number
  maxzoom: number
  bytes: number
  format: 'webp' | 'jpeg'
  attribution: string
  licence: string
}

export interface Catalog {
  format: 'carmanah-catalog'
  version: 1
  updated: string
  sources: { imagery?: ImageryEntry[]; [kind: string]: unknown[] | undefined }
  [key: string]: unknown
}

export const COPERNICUS_LICENCE =
  'Copernicus Sentinel data: free, full and open (Copernicus Sentinel Data Legal Notice, ' +
  'https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice)'

/** Imagery bucket key: imagery/<product>/<area>/<period>.pmtiles */
export function imageryKey(product: string, area: string, period: string): string {
  return `imagery/${product}/${area}/${period}.pmtiles`
}

/**
 * Add an imagery entry to a catalog (or a new one), replacing any entry for
 * the same area and product. Everything else in the catalog is kept as is.
 */
export function addImageryEntry(catalog: Catalog | null, entry: ImageryEntry, now = new Date()): Catalog {
  const base: Catalog = catalog ?? { format: 'carmanah-catalog', version: 1, updated: '', sources: {}, packs: [] }
  if (base.format !== 'carmanah-catalog' || base.version !== 1) {
    throw new Error(`catalog.json is ${base.format} v${base.version}, expected carmanah-catalog v1`)
  }
  const others = (base.sources.imagery ?? []).filter((e) => !(e.area === entry.area && e.product === entry.product))
  return {
    ...base,
    updated: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sources: { ...base.sources, imagery: [...others, entry] },
  }
}
