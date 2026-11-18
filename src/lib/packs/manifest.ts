// pack.json (one offline pack) and catalog.json (what the bucket offers):
// the formats, and strict reading of files that came over the network or
// from another phone. docs/fire-packs.md describes both.
//
// No DOM or Node imports; see area.ts.

import { simplifyRing, type Bbox, type LonLat } from './area.ts'

export const PACK_FORMAT = 'carmanah-pack'
export const PACK_VERSION = 1
export const CATALOG_FORMAT = 'carmanah-catalog'
export const CATALOG_VERSION = 1

/** Which map source a pack file feeds: the style's `openmaptiles`/`terrain` (and later satellite). */
export type PackSource = 'basemap' | 'terrain' | 'satellite'

export interface PackFile {
  /** File name in the pack folder, e.g. `basemap.pmtiles`. */
  name: string
  source: PackSource
  /** Tile format: `mvt` vector tiles, or an image format. */
  format: 'mvt' | 'png' | 'webp' | 'jpg'
  encoding?: 'terrarium'
  minzoom: number
  maxzoom: number
  /** Tiles the file answers for. */
  tiles: number
  bytes: number
  sha256: string
  /** Data version: the OpenFreeMap planet build, or the terrain archive's version. */
  build?: string
  /** What it was cut from (archive URL or "aws-terrain-tiles"). */
  from?: string
  attribution: string
}

export interface PackManifest {
  format: typeof PACK_FORMAT
  version: typeof PACK_VERSION
  /** Folder name: lower-case letters, digits and `-`. */
  id: string
  name: string
  fireNumber?: string
  /** ISO time the pack was made. */
  created: string
  /** Area covered, buffer included: west, south, east, north. */
  bbox: Bbox
  bufferKm: number
  /** The perimeter it was cut around (simplified), or null for a box. */
  perimeter: { type: 'MultiPolygon'; coordinates: LonLat[][][] } | null
  /** Hectares inside the perimeter (or the box), buffer not included. */
  areaHa: number
  files: PackFile[]
  /** Sum of the files' bytes. */
  bytes: number
  /** Credits for everything in the pack, as shown on the map. */
  attribution: string
  madeBy: 'builder' | 'app'
}

export interface CatalogSource {
  /** Area name, e.g. `bc`. */
  area: string
  /** Archive URL, relative to the catalog. */
  url: string
  build?: string
  version?: string
  bounds: Bbox
  minzoom: number
  maxzoom: number
  bytes: number
  attribution?: string
}

export interface CatalogPack {
  id: string
  name: string
  fireNumber?: string
  bbox: Bbox
  bytes: number
  created: string
  /** pack.json URL, relative to the catalog. */
  url: string
}

export interface Catalog {
  format: typeof CATALOG_FORMAT
  version: typeof CATALOG_VERSION
  updated: string
  sources: { basemap: CatalogSource[]; terrain: CatalogSource[]; imagery?: CatalogSource[] }
  packs: CatalogPack[]
}

export const BASEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap'
export const TERRAIN_ATTRIBUTION =
  'Terrain: Mapzen/AWS Open Data. Contains information licensed under the Open Government Licence – Canada'

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const FILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}\.pmtiles$/
const SHA256_RE = /^[0-9a-f]{64}$/

export const isPackId = (v: unknown): v is string => typeof v === 'string' && PACK_ID_RE.test(v)

/** A file-name-safe id from a fire number or name and a date: `c40983-20261118`. */
export function packIdFor(label: string, created: Date | string): string {
  const day = (typeof created === 'string' ? created : created.toISOString()).slice(0, 10).replace(/-/g, '')
  const slug = label
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${slug || 'area'}-${day}`
}

class BadFile extends Error {
  constructor(what: string, why: string) {
    super(`${what}: ${why}`)
  }
}

const num = (v: unknown, what: string, min = 0): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) throw new BadFile(what, 'not a valid number')
  return v
}
const str = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new BadFile(what, 'missing or too long')
  return v
}
function bbox(v: unknown, what: string): Bbox {
  if (!Array.isArray(v) || v.length !== 4 || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new BadFile(what, 'bbox must be [west, south, east, north]')
  }
  const [w, s, e, n] = v as number[]
  if (w < -180 || e > 180 || s < -90 || n > 90 || w > e || s > n) throw new BadFile(what, 'bbox out of range')
  return [w, s, e, n]
}

/** Check a pack.json read from storage, a download or another phone. Throws with the reason. */
export function parseManifest(raw: unknown): PackManifest {
  const m = raw as Record<string, unknown>
  if (!m || typeof m !== 'object') throw new BadFile('pack.json', 'not an object')
  if (m.format !== PACK_FORMAT) throw new BadFile('pack.json', 'not a Carmanah map pack')
  if (m.version !== PACK_VERSION) throw new BadFile('pack.json', `version ${String(m.version)} isn't supported`)
  if (!isPackId(m.id)) throw new BadFile('pack.json', 'bad id')
  if (!Array.isArray(m.files) || !m.files.length) throw new BadFile('pack.json', 'no files')
  const names = new Set<string>()
  const files: PackFile[] = (m.files as Record<string, unknown>[]).map((f, i) => {
    const what = `pack.json files[${i}]`
    if (typeof f?.name !== 'string' || !FILE_NAME_RE.test(f.name) || names.has(f.name)) throw new BadFile(what, 'bad file name')
    names.add(f.name)
    if (f.source !== 'basemap' && f.source !== 'terrain' && f.source !== 'satellite') throw new BadFile(what, 'unknown source')
    if (!['mvt', 'png', 'webp', 'jpg'].includes(f.format as string)) throw new BadFile(what, 'unknown format')
    if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256)) throw new BadFile(what, 'bad sha256')
    const minzoom = num(f.minzoom, what)
    const maxzoom = num(f.maxzoom, what)
    if (maxzoom > 22 || minzoom > maxzoom) throw new BadFile(what, 'bad zoom range')
    return {
      name: f.name,
      source: f.source,
      format: f.format as PackFile['format'],
      ...(f.encoding === 'terrarium' ? { encoding: 'terrarium' as const } : {}),
      minzoom,
      maxzoom,
      tiles: num(f.tiles, what),
      bytes: num(f.bytes, what, 1),
      sha256: f.sha256,
      ...(typeof f.build === 'string' ? { build: f.build.slice(0, 64) } : {}),
      ...(typeof f.from === 'string' ? { from: f.from.slice(0, 300) } : {}),
      attribution: typeof f.attribution === 'string' ? f.attribution.slice(0, 500) : '',
    }
  })
  const perimeter = m.perimeter as PackManifest['perimeter']
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    id: m.id,
    name: str(m.name, 'pack.json name'),
    ...(typeof m.fireNumber === 'string' && m.fireNumber.trim() ? { fireNumber: m.fireNumber.trim().slice(0, 20) } : {}),
    created: str(m.created, 'pack.json created', 40),
    bbox: bbox(m.bbox, 'pack.json bbox'),
    bufferKm: num(m.bufferKm, 'pack.json bufferKm'),
    perimeter:
      perimeter && perimeter.type === 'MultiPolygon' && Array.isArray(perimeter.coordinates) ? perimeter : null,
    areaHa: num(m.areaHa ?? 0, 'pack.json areaHa'),
    files,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    attribution: typeof m.attribution === 'string' ? m.attribution.slice(0, 1000) : '',
    madeBy: m.madeBy === 'app' ? 'app' : 'builder',
  }
}

function source(raw: unknown, what: string): CatalogSource {
  const s = raw as Record<string, unknown>
  return {
    area: str(s?.area, `${what} area`, 64),
    url: str(s?.url, `${what} url`, 500),
    ...(typeof s.build === 'string' ? { build: s.build } : {}),
    ...(typeof s.version === 'string' ? { version: s.version } : {}),
    bounds: bbox(s.bounds, `${what} bounds`),
    minzoom: num(s.minzoom, `${what} minzoom`),
    maxzoom: num(s.maxzoom, `${what} maxzoom`),
    bytes: num(s.bytes, `${what} bytes`),
    ...(typeof s.attribution === 'string' ? { attribution: s.attribution } : {}),
  }
}

/** Check a catalog.json. Bad entries are dropped, not fatal: one typo mustn't stop every download. */
export function parseCatalog(raw: unknown): Catalog {
  const c = raw as Record<string, unknown>
  if (!c || typeof c !== 'object' || c.format !== CATALOG_FORMAT) throw new BadFile('catalog.json', 'not a Carmanah catalog')
  if (c.version !== CATALOG_VERSION) throw new BadFile('catalog.json', `version ${String(c.version)} isn't supported`)
  const keep = <T>(list: unknown, read: (v: unknown, what: string) => T, what: string): T[] =>
    (Array.isArray(list) ? list : []).flatMap((v, i) => {
      try {
        return [read(v, `${what}[${i}]`)]
      } catch {
        return []
      }
    })
  const sources = (c.sources ?? {}) as Record<string, unknown>
  return {
    format: CATALOG_FORMAT,
    version: CATALOG_VERSION,
    updated: typeof c.updated === 'string' ? c.updated : '',
    sources: {
      basemap: keep(sources.basemap, source, 'basemap'),
      terrain: keep(sources.terrain, source, 'terrain'),
      imagery: keep(sources.imagery, source, 'imagery'),
    },
    packs: keep(
      c.packs,
      (v, what) => {
        const p = v as Record<string, unknown>
        if (!isPackId(p?.id)) throw new BadFile(what, 'bad id')
        return {
          id: p.id,
          name: str(p.name, `${what} name`),
          ...(typeof p.fireNumber === 'string' ? { fireNumber: p.fireNumber } : {}),
          bbox: bbox(p.bbox, `${what} bbox`),
          bytes: num(p.bytes, `${what} bytes`),
          created: str(p.created, `${what} created`, 40),
          url: str(p.url, `${what} url`, 500),
        }
      },
      'packs',
    ),
  }
}

export function emptyCatalog(): Catalog {
  return {
    format: CATALOG_FORMAT,
    version: CATALOG_VERSION,
    updated: new Date(0).toISOString(),
    sources: { basemap: [], terrain: [], imagery: [] },
    packs: [],
  }
}

/** A perimeter for pack.json: simplified to ~20 m and rounded to ~1 m, so the file stays small. */
export function perimeterOf(rings: LonLat[][], toleranceM = 20): PackManifest['perimeter'] {
  if (!rings.length) return null
  const round = (v: number) => Math.round(v * 1e5) / 1e5
  return {
    type: 'MultiPolygon',
    coordinates: rings.map((r) => [simplifyRing(r, toleranceM).map(([x, y]) => [round(x), round(y)] as LonLat)]),
  }
}

/** pack.json text: readable, with the perimeter's coordinates on one line. */
export function manifestJson(m: PackManifest): string {
  const text = JSON.stringify({ ...m, perimeter: m.perimeter ? '@perimeter' : null }, null, 2)
  return `${text.replace('"@perimeter"', JSON.stringify(m.perimeter))}\n`
}
