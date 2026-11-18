// Where the imagery comes from: STAC catalogue searches.
//
// cdse     Copernicus Sentinel-2 quarterly cloudless mosaics (the source we
//          ship). Free, full and open (Copernicus Sentinel data legal notice),
//          but the files need a free Copernicus Data Space account's S3 keys.
// aws-l2a  Single Sentinel-2 L2A scenes from the AWS Open Data registry
//          (Element 84 Earth Search). Same Copernicus data and licence, no
//          account. Used to test the pipeline; not cloud-free mosaics.

import { bboxTouchesArea, type Area } from './area.ts'
import { parseS3Url, presignGetUrl, type S3Credentials } from './s3-presign.ts'
import type { SourceSpec } from './types.ts'

export const CDSE_STAC = 'https://stac.dataspace.copernicus.eu/v1'
export const CDSE_COLLECTION = 'sentinel-2-global-mosaics'
export const CDSE_S3_ENDPOINT = 'https://eodata.dataspace.copernicus.eu'
export const EARTH_SEARCH_STAC = 'https://earth-search.aws.element84.com/v1'
export const EARTH_SEARCH_COLLECTION = 'sentinel-2-c1-l2a'

interface StacAsset {
  href: string
  'file:size'?: number
  'raster:bands'?: { nodata?: number; scale?: number; offset?: number; data_type?: string }[]
  nodata?: number
  data_type?: string
}

export interface StacItem {
  id: string
  bbox: [number, number, number, number]
  properties: Record<string, unknown> & { datetime: string }
  assets: Record<string, StacAsset>
}

interface StacPage {
  features: StacItem[]
  links?: { rel: string; href: string; method?: string; body?: unknown; merge?: boolean }[]
}

/** POST /search, following "next" links. */
export async function stacSearch(api: string, body: Record<string, unknown>): Promise<StacItem[]> {
  const items: StacItem[] = []
  let url = `${api}/search`
  let request: Record<string, unknown> = body
  for (let page = 0; page < 100; page++) {
    let res: Response
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json' },
        body: JSON.stringify(request),
      })
      // Catalogues rate-limit (CDSE answers 429): wait and try again.
      if ((res.status !== 429 && res.status < 500) || attempt >= 5) break
      await res.text().catch(() => '')
      const wait = Number(res.headers.get('retry-after')) || 5 * 2 ** attempt
      await new Promise((r) => setTimeout(r, wait * 1000))
    }
    if (!res.ok) throw new Error(`STAC search failed: HTTP ${res.status} ${await res.text()}`)
    const data = (await res.json()) as StacPage
    items.push(...data.features)
    const next = data.links?.find((l) => l.rel === 'next')
    if (!next || data.features.length === 0) break
    url = next.href
    request = next.merge ? { ...request, ...(next.body as object) } : ((next.body as Record<string, unknown>) ?? request)
  }
  return items
}

const epsgOf = (item: StacItem): number => {
  const code = (item.properties['proj:code'] as string | undefined) ?? `EPSG:${item.properties['proj:epsg']}`
  const n = Number(code.replace(/^EPSG:/, ''))
  if (!Number.isFinite(n)) throw new Error(`${item.id}: no projection`)
  return n
}

/** "2026-Q3" for a quarter's start date. */
export function quarterOf(datetime: string): string {
  const d = new Date(datetime)
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`
}

/** Start datetime of a quarter: "2026-Q3" → "2026-07-01T00:00:00Z". */
export function quarterStart(quarter: string): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter)
  if (!m) throw new Error(`quarter must look like 2026-Q3, not ${quarter}`)
  return `${m[1]}-${String((Number(m[2]) - 1) * 3 + 1).padStart(2, '0')}-01T00:00:00Z`
}

/** The quarter before: "2026-Q1" → "2025-Q4". */
export function previousQuarter(quarter: string): string {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarter)
  if (!m) throw new Error(`quarter must look like 2026-Q3, not ${quarter}`)
  const q = Number(m[2])
  return q === 1 ? `${Number(m[1]) - 1}-Q4` : `${m[1]}-Q${q - 1}`
}

/**
 * Mosaic tiles for an area and quarter ("latest" = the newest quarter that
 * has any tile over the area), plus `fillQuarters` earlier quarters with a
 * lower priority: where a quarter never had a clear view a pixel is empty,
 * and the build fills it from the quarter before. Without credentials the
 * specs keep s3:// band URLs (fine for --estimate, which only needs sizes).
 */
export async function cdseMosaicSources(
  area: Area,
  quarter: string,
  credentials: S3Credentials | null,
  fillQuarters = 0,
): Promise<{ quarter: string; sources: SourceSpec[] }> {
  const main = await cdseQuarter(area, quarter, credentials, 0)
  const sources = [...main.sources]
  let q = main.quarter
  for (let i = 1; i <= fillQuarters; i++) {
    q = previousQuarter(q)
    sources.push(...(await cdseQuarter(area, q, credentials, i)).sources)
  }
  return { quarter: main.quarter, sources }
}

async function cdseQuarter(
  area: Area,
  quarter: string,
  credentials: S3Credentials | null,
  priority: number,
): Promise<{ quarter: string; sources: SourceSpec[] }> {
  let start: string
  if (quarter === 'latest') {
    const [newest] = await stacSearch(CDSE_STAC, {
      collections: [CDSE_COLLECTION],
      bbox: area.bbox,
      limit: 1,
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    })
    if (!newest) throw new Error('No Sentinel-2 mosaic over this area')
    start = newest.properties.datetime
  } else {
    start = quarterStart(quarter)
  }
  const items = await stacSearch(CDSE_STAC, {
    collections: [CDSE_COLLECTION],
    bbox: area.bbox,
    datetime: start,
    limit: 500,
  })
  const q = quarterOf(start)
  const sources = items
    .filter((item) => bboxTouchesArea(item.bbox, area))
    .map((item): SourceSpec => {
      const bands = (['B04', 'B03', 'B02'] as const).map((b) => {
        const href = item.assets[b]?.href
        if (!href) throw new Error(`${item.id}: no ${b}`)
        if (!credentials) return href
        const { bucket, key } = parseS3Url(href)
        return presignGetUrl({
          endpoint: CDSE_S3_ENDPOINT,
          bucket,
          key,
          region: 'default',
          credentials,
          expiresSeconds: 7 * 24 * 3600, // SigV4's maximum
        })
      }) as [string, string, string]
      return {
        id: item.id,
        epsg: epsgOf(item),
        bands,
        // Reflectance × 10000 as int16; -32768 = no valid observation.
        encoding: { scale: 1e-4, offset: 0, signed: true, nodata: -32768 },
        bbox: item.bbox,
        date: q,
        bytes: (['B04', 'B03', 'B02'] as const).reduce((n, b) => n + (item.assets[b]['file:size'] ?? 0), 0),
        priority,
      }
    })
  return { quarter: q, sources }
}

/**
 * The clearest L2A scene for each 100 km grid square over the area, between
 * two dates. Grid squares are ordered clearest first.
 */
export async function awsL2aSources(area: Area, dates: string, maxCloud: number): Promise<SourceSpec[]> {
  const items = await stacSearch(EARTH_SEARCH_STAC, {
    collections: [EARTH_SEARCH_COLLECTION],
    bbox: area.bbox,
    datetime: dates,
    query: { 'eo:cloud_cover': { lt: maxCloud } },
    limit: 200,
  })
  const score = (i: StacItem) =>
    Number(i.properties['eo:cloud_cover'] ?? 100) + Number(i.properties['s2:nodata_pixel_percentage'] ?? 0)
  const best = new Map<string, StacItem>()
  for (const item of items.filter((i) => bboxTouchesArea(i.bbox, area))) {
    const square = String(item.properties['grid:code'] ?? item.id.split('_')[1])
    const current = best.get(square)
    if (!current || score(item) < score(current)) best.set(square, item)
  }
  return [...best.values()]
    .sort((a, b) => score(a) - score(b))
    .map((item): SourceSpec => {
      const band = (name: string) => {
        const asset = item.assets[name]
        if (!asset) throw new Error(`${item.id}: no ${name} band`)
        return asset
      }
      const red = band('red')
      const rb = red['raster:bands']?.[0] ?? {}
      return {
        id: item.id,
        epsg: epsgOf(item),
        bands: [red.href, band('green').href, band('blue').href],
        encoding: { scale: rb.scale ?? 1e-4, offset: rb.offset ?? 0, signed: false, nodata: rb.nodata ?? 0 },
        bbox: item.bbox,
        date: item.properties.datetime.slice(0, 10),
        bytes: ['red', 'green', 'blue'].reduce((n, b) => n + (item.assets[b]['file:size'] ?? 0), 0),
      }
    })
}
