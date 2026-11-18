/**
 * Every import lands in editable layers: KML/KMZ (kml.ts), GPX, CSV,
 * zipped shapefile and GeoJSON. Liberal in what it reads: the file
 * extension is only a hint, archives and text are sniffed.
 */
import { gpx } from '@tmcw/togeojson'
import { unzipSync } from 'fflate'
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'
import { parseCsv } from './csv'
import { decodeXml, htmlToText, parseKmlBytes, parseKmz, parseXml } from './kml'
import {
  attrToText,
  ImportBuilder,
  inferAttrType,
  normalizeToSchema,
  schemaFromFeatures,
  type ImportResult,
  type Layer,
  type LayerSource,
} from './layers'
import { parseCoordinate } from './coords'
import { symbolKeyFromName } from './symbols'

type Ctx = { fileName: string; url?: string }

const stripExtension = (name: string) =>
  name.replace(/\.(kml|kmz|gpx|zip|shp|csv|tsv|txt|geojson|json)$/i, '')

// ---------- GeoJSON (also shapefiles, and the old read-only overlays) ----------

/** Properties that carry style or bookkeeping, not attributes. */
const RESERVED = new Set([
  'time', 'timestamp', 'timespan', 'styleUrl', 'styleHash', 'styleMapHash', 'visibility', 'coordinateProperties',
  '@geometry-type', '_gpxType', 'links', 'sym', 'icon', 'icon-color', 'icon-opacity',
  'icon-scale', 'icon-offset', 'icon-offset-units', 'icon-heading', 'label-color',
  'label-opacity', 'label-scale', 'marker-color', 'marker-symbol', 'marker-size',
  'stroke', 'stroke-width', 'stroke-opacity', 'fill', 'fill-opacity',
])

const NAME_KEYS = ['name', 'Name', 'NAME', 'title', 'Title', 'TITLE', 'label', 'Label', 'LABEL']
const NOTES_KEYS = ['description', 'Description', 'DESCRIPTION', 'desc', 'notes', 'Notes', 'cmt']

function hexColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim()) ?? /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v.trim())
  if (!m) return undefined
  return m.length === 2
    ? `#${m[1].toLowerCase()}`
    : `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`.toLowerCase()
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

const toMs = (v: unknown): number | undefined => {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined
  const t = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/** Add GeoJSON features to a layer, keeping attributes, simplestyle styles,
 * names, descriptions and per-vertex times. Sets the layer schema from the
 * (typed) property values. */
export function addGeoJsonFeatures(b: ImportBuilder, layer: Layer, features: Feature[]) {
  const typed = new Map<string, unknown[]>()
  const added = []
  for (const f of features) {
    const p = (f.properties ?? {}) as Record<string, unknown>
    const nameKey = NAME_KEYS.find((k) => typeof p[k] === 'string' || typeof p[k] === 'number')
    const notesKey = NOTES_KEYS.find((k) => typeof p[k] === 'string')
    if (Array.isArray(p.links)) {
      const hrefs = (p.links as { href?: string }[]).map((l) => l.href).filter(Boolean)
      if (hrefs.length) p.Link = hrefs.join(' ')
    }
    const attributes: { k: string; v: string }[] = []
    for (const [k, v] of Object.entries(p)) {
      if (RESERVED.has(k) || k === nameKey || k === notesKey) continue
      if (!typed.has(k)) typed.set(k, [])
      typed.get(k)!.push(v)
      const text = attrToText(v).trim()
      if (text) attributes.push({ k, v: text })
    }
    const rawTimes = (p.coordinateProperties as { times?: unknown } | undefined)?.times
    const times = Array.isArray(rawTimes)
      ? Array.isArray(rawTimes[0])
        ? (rawTimes as unknown[][]).map((part) => part.map((t) => toMs(t) ?? NaN))
        : (rawTimes as unknown[]).map((t) => toMs(t) ?? NaN)
      : undefined
    const timesOk = times && times.flat().every(Number.isFinite)
    const desc = notesKey ? (p[notesKey] as string) : undefined
    const created = toMs(p.time ?? p.timestamp)
    const isPoint = f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint'
    const color = hexColor(isPoint ? (p['marker-color'] ?? p['icon-color']) : p.stroke) ?? hexColor(p.fill)
    const sym = symbolKeyFromName((p.sym ?? p['marker-symbol']) as string | undefined)
    const parts = b.addGeometry(layer.id, f.geometry as Geometry, {
      name: nameKey ? String(p[nameKey]) : '',
      notes: desc ? htmlToText(desc) : '',
      attributes: attributes.length ? attributes : undefined,
      times: timesOk ? times : undefined,
      ...(color ? { color } : {}),
      ...(sym ? { symbol: sym } : {}),
      ...(created !== undefined ? { createdAt: created, updatedAt: created } : {}),
    })
    for (const part of parts) {
      const w = num(p['stroke-width'])
      if (part.kind !== 'pin' && w !== undefined) part.width = w
      if (part.kind === 'area') {
        const fill = hexColor(p.fill)
        if (fill) part.fill = fill
        const fo = num(p['fill-opacity'])
        if (fo !== undefined) part.fillOpacity = fo
      }
    }
    added.push(...parts)
  }
  layer.schema = schemaFromFeatures(added, typed)
  normalizeToSchema(added, layer.schema)
  const first = added.find((f) => f.kind !== 'pin') ?? added[0]
  if (first) {
    layer.style = { color: first.color }
    if (first.width !== undefined) layer.style.width = first.width
  }
}

export function geojsonToImport(
  name: string,
  data: unknown,
  source: Omit<LayerSource, 'importedAt'> & { importedAt?: number },
): ImportResult {
  const b = new ImportBuilder(source)
  const layer = b.addLayer(name)
  addGeoJsonFeatures(b, layer, geojsonFeatures(data))
  return b.result(name)
}

function geojsonFeatures(data: unknown): Feature[] {
  const d = data as { type?: string; features?: Feature[]; geometry?: Geometry }
  if (d?.type === 'FeatureCollection') return d.features ?? []
  if (d?.type === 'Feature') return [d as Feature]
  if (d?.type && 'coordinates' in (d as object)) return [{ type: 'Feature', properties: {}, geometry: d as Geometry }]
  if (d?.type === 'GeometryCollection') return [{ type: 'Feature', properties: {}, geometry: d as Geometry }]
  throw new Error('Not a GeoJSON file')
}

// ---------- GPX ----------

export function parseGpxBytes(bytes: Uint8Array, ctx: Ctx): ImportResult {
  const dom = parseXml(decodeXml(bytes), 'GPX')
  const fc = gpx(dom) as FeatureCollection
  const meta = dom.getElementsByTagNameNS('*', 'metadata')[0]
  const metaName = meta
    ? Array.from(meta.childNodes).find((n) => (n as Element).localName === 'name')?.textContent?.trim()
    : undefined
  const name = metaName || stripExtension(ctx.fileName)
  const b = new ImportBuilder({ kind: 'import', fileName: ctx.fileName, format: 'gpx', url: ctx.url })
  const layer = b.addLayer(name)
  // GPX <type> is a free-text category; keep it as a "Type" attribute.
  for (const f of fc.features) {
    const p = f.properties ?? {}
    if (typeof p.type === 'string' && p.type) p.Type = p.type
    delete p.type
    delete p.keywords
  }
  addGeoJsonFeatures(b, layer, fc.features)
  const result = b.result(name)
  if (!result.features.length) throw new Error('GPX contains no map features')
  return result
}

// ---------- CSV ----------

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')

const LAT = ['lat', 'latitude', 'y', 'latdd', 'latitudedd', 'ycoord', 'ycoordinate', 'decimallatitude', 'gpslatitude', 'latwgs84', 'latitudewgs84', 'pointy']
const LON = ['lon', 'lng', 'long', 'longitude', 'x', 'londd', 'longdd', 'longitudedd', 'xcoord', 'xcoordinate', 'decimallongitude', 'gpslongitude', 'lonwgs84', 'longitudewgs84', 'pointx']
const COORD = ['coordinates', 'coordinate', 'coords', 'position', 'location', 'latlon', 'latlong', 'latlng', 'mgrs', 'utm', 'wkt', 'geometry', 'point']
const NAME = ['name', 'title', 'label', 'placemark', 'placemarkname', 'featurename', 'nom', 'nombre']
const NOTES = ['description', 'notes', 'note', 'desc', 'comment', 'comments', 'remarks']
const LAYER = ['layer', 'folder', 'layername']
const SYMBOL = ['symbol', 'sym', 'icon']
const COLOR = ['color', 'colour']
const CREATED = ['created', 'createdat', 'datecreated', 'date', 'datetime', 'time', 'timestamp']
const ALT = ['altitude', 'elevation', 'alt', 'ele', 'elev', 'z', 'altitudem', 'elevationm']
// Our pre-layers CSV export: "kind" and "measurement" were derived, and
// "attributes" held "k=v; k=v".
const KIND = ['kind', 'measurement']
const OLD_ATTRS = 'attributes'

function findCol(headers: string[], names: string[], prefix?: RegExp): number {
  const n = headers.map(norm)
  const exact = n.findIndex((h) => names.includes(h))
  if (exact >= 0 || !prefix) return exact
  return n.findIndex((h) => prefix.test(h))
}

/** One degree value: "49.25", "49,25", "49°15'30\"N", "N 49 15.5", "-123.1 W". */
export function parseDegrees(raw: string): number | undefined {
  const s = raw.trim().replace(/^(-?\d+),(\d+)$/, '$1.$2')
  if (!s) return undefined
  const n = Number(s)
  if (Number.isFinite(n)) return n
  const m =
    /^([NSEW])?\s*(-?\d+(?:\.\d+)?)(?:[°º:\s]+(\d+(?:\.\d+)?))?(?:['′:\s]+(\d+(?:\.\d+)?))?["″]?\s*([NSEW])?$/i.exec(
      s.replace(/''/g, '"'),
    )
  if (!m) return undefined
  let v = Math.abs(Number(m[2])) + Number(m[3] ?? 0) / 60 + Number(m[4] ?? 0) / 3600
  const hemi = (m[1] ?? m[5] ?? '').toUpperCase()
  if (Number(m[2]) < 0 || hemi === 'S' || hemi === 'W') v = -v
  return v
}

function parseWktPoint(s: string): Position | undefined {
  const m = /POINT\s*Z?\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\s*\)/i.exec(s)
  if (!m) return undefined
  return m[3] !== undefined ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[1]), Number(m[2])]
}

export function parseCsvText(text: string, ctx: Ctx): ImportResult {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('CSV has no rows')
  const headers = rows[0].map((h) => h.trim())
  const latI = findCol(headers, LAT, /^lat/)
  const lonI = findCol(headers, LON, /^(lon|lng)/)
  const coordI = latI < 0 || lonI < 0 ? findCol(headers, COORD) : -1
  const zoneI = findCol(headers, ['zone', 'utmzone'])
  const eastI = findCol(headers, ['easting', 'utmeasting', 'e'])
  const northI = findCol(headers, ['northing', 'utmnorthing', 'n'])
  const useUtm = latI < 0 && coordI < 0 && zoneI >= 0 && eastI >= 0 && northI >= 0
  if ((latI < 0 || lonI < 0) && coordI < 0 && !useUtm) {
    throw new Error('CSV needs latitude and longitude columns (or a coordinates, MGRS or UTM column)')
  }
  const nameI = findCol(headers, NAME)
  const notesI = findCol(headers, NOTES)
  const layerI = findCol(headers, LAYER)
  const symI = findCol(headers, SYMBOL)
  const colorI = findCol(headers, COLOR)
  const createdI = findCol(headers, CREATED)
  const altI = findCol(headers, ALT)
  const used = new Set([latI, lonI, coordI, nameI, notesI, layerI, symI, colorI, createdI, altI])
  if (useUtm) [zoneI, eastI, northI].forEach((i) => used.add(i))
  const oldFormat = findCol(headers, ['kind']) >= 0 && findCol(headers, ['measurement']) >= 0
  const kindCols = oldFormat
    ? headers.map((h, i) => (KIND.includes(norm(h)) ? i : -1)).filter((i) => i >= 0)
    : []
  const kindI = oldFormat ? findCol(headers, ['kind']) : -1
  const oldAttrI = oldFormat ? findCol(headers, [OLD_ATTRS]) : -1
  const attrCols = headers
    .map((h, i) => ({ h: h.replace(/ \(attribute\)$/, ''), i }))
    .filter(({ i }) => !used.has(i) && !kindCols.includes(i) && i !== oldAttrI)

  const fileLayerName = stripExtension(ctx.fileName)
  const b = new ImportBuilder({ kind: 'import', fileName: ctx.fileName, format: 'csv', url: ctx.url })
  const layersByPath = new Map<string, Layer>()
  const layerFor = (path: string): Layer => {
    const key = path.trim() || `\u0000${fileLayerName}`
    if (layersByPath.has(key)) return layersByPath.get(key)!
    let parent: Layer | undefined
    const names = path.trim() ? path.split(' / ') : [fileLayerName]
    let soFar = ''
    for (const n of names) {
      soFar = soFar ? `${soFar} / ${n}` : n
      const k = path.trim() ? soFar : key
      let l = layersByPath.get(k)
      if (!l) {
        l = b.addLayer(n, parent?.id)
        layersByPath.set(k, l)
      }
      parent = l
    }
    return parent!
  }

  let swapped = 0
  let oldShapes = 0
  for (const row of rows.slice(1)) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
    if (kindI >= 0 && /^(line|area)$/i.test(cell(kindI))) {
      oldShapes++
      continue
    }
    let pos: Position | undefined
    if (latI >= 0 && lonI >= 0) {
      const lat = parseDegrees(cell(latI))
      const lon = parseDegrees(cell(lonI))
      if (lat !== undefined && lon !== undefined) {
        pos = Math.abs(lat) > 90 && Math.abs(lon) <= 90 ? (swapped++, [lat, lon]) : [lon, lat]
      }
    } else if (coordI >= 0) {
      pos = parseWktPoint(cell(coordI)) ?? parseCoordinate(cell(coordI)) ?? undefined
    } else if (useUtm) {
      pos = parseCoordinate(`${cell(zoneI)} ${cell(eastI)} ${cell(northI)}`) ?? undefined
    }
    const alt = altI >= 0 ? Number(cell(altI)) : NaN
    if (pos && pos.length === 2 && cell(altI) !== '' && Number.isFinite(alt)) pos = [pos[0], pos[1], alt]
    const attributes = attrCols
      .map(({ h, i }) => ({ k: h, v: cell(i) }))
      .filter((a) => a.k && a.v !== '')
    for (const pair of oldAttrI >= 0 ? cell(oldAttrI).split('; ') : []) {
      const eqAt = pair.indexOf('=')
      if (eqAt > 0) attributes.push({ k: pair.slice(0, eqAt).trim(), v: pair.slice(eqAt + 1).trim() })
    }
    const created = createdI >= 0 ? Date.parse(cell(createdI)) : NaN
    const color = /^#[0-9a-f]{6}$/i.test(cell(colorI)) ? cell(colorI).toLowerCase() : undefined
    const sym = cell(symI) ? (symbolKeyFromName(cell(symI)) ?? undefined) : undefined
    const layer = layerFor(cell(layerI))
    b.addGeometry(layer.id, pos ? { type: 'Point', coordinates: pos } : null, {
      name: cell(nameI),
      notes: cell(notesI),
      attributes: attributes.length ? attributes : undefined,
      ...(color ? { color } : {}),
      ...(sym ? { symbol: sym } : {}),
      ...(Number.isFinite(created) ? { createdAt: created, updatedAt: created } : {}),
    })
  }
  for (const layer of b.layers) {
    const feats = b.features.filter((f) => f.layerId === layer.id)
    layer.schema = attrCols
      .map(({ h }) => ({
        name: h,
        type: inferAttrType(feats.map((f) => f.attributes?.find((a) => a.k === h)?.v ?? '')),
      }))
      .filter((s) => feats.some((f) => f.attributes?.some((a) => a.k === s.name)))
    // Old "k=v" pairs stay per-feature fields, as they were.
    normalizeToSchema(feats, layer.schema)
    if (feats[0]) layer.style = { color: feats[0].color }
  }
  if (swapped) b.warnings.push(`${swapped} row(s) had latitude and longitude swapped; fixed`)
  if (oldShapes) b.warnings.push(`${oldShapes} line/area row(s) skipped (CSV only holds their first point)`)
  const result = b.result(fileLayerName)
  if (!result.features.length) throw new Error('CSV has no rows with usable coordinates')
  return result
}

// ---------- Shapefile ----------

async function parseShapefile(buffer: ArrayBuffer, ctx: Ctx): Promise<ImportResult> {
  const { default: shp } = await import('shpjs')
  const parsed = await shp(buffer)
  const collections = (Array.isArray(parsed) ? parsed : [parsed]) as (FeatureCollection & {
    fileName?: string
  })[]
  const name = stripExtension(ctx.fileName)
  const b = new ImportBuilder({ kind: 'import', fileName: ctx.fileName, format: 'shp', url: ctx.url })
  // One shapefile → one layer; several in one zip → sublayers of the zip's layer.
  const root = b.addLayer(name)
  for (const fc of collections) {
    const layer =
      collections.length === 1 ? root : b.addLayer(fc.fileName?.split('/').pop() || 'Layer', root.id)
    addGeoJsonFeatures(b, layer, fc.features)
  }
  const result = b.result(name)
  if (!result.features.length) throw new Error('Shapefile contains no map features')
  return result
}

// ---------- Dispatch ----------

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b

function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = []
  unzipSync(bytes, {
    filter: (f) => {
      names.push(f.name)
      return false
    },
  })
  return names
}

async function parseBytes(bytes: Uint8Array, ctx: Ctx): Promise<ImportResult> {
  const ext = ctx.fileName.split('.').pop()?.toLowerCase() ?? ''
  if (isZip(bytes)) {
    const names = zipEntryNames(bytes).map((n) => n.toLowerCase())
    if (ext !== 'kmz' && names.some((n) => n.endsWith('.shp'))) {
      return parseShapefile(bytes.slice().buffer, ctx)
    }
    if (names.some((n) => n.endsWith('.kml'))) {
      return parseKmz(bytes, { fileName: ctx.fileName, url: ctx.url, format: 'kmz' })
    }
    const inner = names.find((n) => /\.(gpx|csv|geojson|json)$/.test(n))
    if (inner) {
      const files = unzipSync(bytes, { filter: (f) => f.name.toLowerCase() === inner })
      const [entry, data] = Object.entries(files)[0]
      return parseBytes(data, { ...ctx, fileName: entry.split('/').pop() ?? entry })
    }
    throw new Error('Archive has no KML, shapefile, GPX or CSV inside')
  }
  if (ext === 'shp') throw new Error('Shapefiles must be zipped with their .shx, .dbf and .prj files')
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return parseCsvText(decodeXml(bytes), ctx)
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^﻿/, '').trimStart()
  if (ext === 'geojson' || ext === 'json' || head.startsWith('{')) {
    let data: unknown
    try {
      data = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new Error('Not a valid GeoJSON file')
    }
    return geojsonToImport(stripExtension(ctx.fileName), data, {
      kind: 'import',
      fileName: ctx.fileName,
      format: 'geojson',
      url: ctx.url,
    })
  }
  if (ext === 'gpx' || /<gpx[\s>]/.test(head)) return parseGpxBytes(bytes, ctx)
  return parseKmlBytes(bytes, { fileName: ctx.fileName, url: ctx.url, format: 'kml' })
}

/** Import any supported file: KML, KMZ, GPX, CSV, GeoJSON or zipped shapefile. */
export async function parseImportedFile(file: File): Promise<ImportResult> {
  const result = await parseBytes(new Uint8Array(await file.arrayBuffer()), { fileName: file.name })
  return result
}

/** Fetch a layer file from a link (e.g. decoded from a fire's QR code). */
export async function fetchImportFromUrl(url: string): Promise<ImportResult> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error(
      'Could not download from that link — the server may block in-app downloads. ' +
        'Download the file in your browser and use Import instead.',
    )
  }
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`)
  const pathname = new URL(url, location.href).pathname
  const fileName = decodeURIComponent(pathname.split('/').pop() || 'Imported map')
  return parseBytes(new Uint8Array(await response.arrayBuffer()), { fileName, url })
}
