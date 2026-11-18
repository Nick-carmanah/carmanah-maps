/**
 * The layer model shared by drawn and imported data ("My Data").
 *
 * A layer has a name, an optional parent (sublayers), a saved visibility, a
 * default style for new features, and a typed attribute schema — the same
 * shape as an Avenza Maps layer, so KML/KMZ round-trips with Avenza keep
 * their structure. Features point at their layer by id (UserFeature.layerId).
 *
 * Pure: no DOM and no storage, so importers, exporters, the map and the
 * GeoPDF writer can all share it (and tests can run it anywhere).
 */
import type { Geometry, Position } from 'geojson'
import {
  DEFAULT_FILL_OPACITY,
  DEFAULT_LAYERS,
  DEFAULT_LINE_WIDTH,
  FEATURE_COLORS,
  FIRE_SYMBOLS,
  featureGeometry,
  type UserFeature,
} from './features'
import { NWCG_SYMBOLS } from './nwcg'
import { TRACK_TYPES } from './naming'
import type { FeaturePhoto, IconAsset } from './store'
import { startsOfParts } from './track'

/** Avenza's four attribute types ("String, Boolean, Real, Integer"). A
 * picklist is an optional list of suggested values on any of them. */
export type AttrType = 'string' | 'boolean' | 'integer' | 'real'

export const ATTR_TYPES: { type: AttrType; label: string }[] = [
  { type: 'string', label: 'Text' },
  { type: 'integer', label: 'Whole number' },
  { type: 'real', label: 'Decimal number' },
  { type: 'boolean', label: 'Yes / no' },
]

export interface AttrField {
  name: string
  type: AttrType
  /** Suggested values. Like Avenza, a value outside the list is allowed. */
  picklist?: string[]
}

/** Default style for features created in (or imported into) a layer. */
export interface LayerStyle {
  color: string
  width?: number
  fill?: string
  fillOpacity?: number
  /** Default pin symbol (see UserFeature.symbol). */
  symbol?: string
}

export interface LayerSource {
  kind: 'import' | 'migrated'
  /** File the layer came from, e.g. "Hazard trees.kmz". */
  fileName?: string
  /** Download link it came from (QR code / ?kml= deep link). */
  url?: string
  format?: string
  importedAt: number
}

export interface Layer {
  id: string
  name: string
  /** Parent layer id; undefined = top level. */
  parentId?: string
  /** Position among its siblings (ascending). */
  order: number
  /** Saved show/hide state. A layer is drawn only if it and every parent are visible. */
  visible: boolean
  style: LayerStyle
  schema: AttrField[]
  source?: LayerSource
  createdAt: number
  updatedAt: number
}

export const DEFAULT_LAYER_COLOR = FEATURE_COLORS[0]

export function newLayer(
  name: string,
  opts: Partial<Omit<Layer, 'id' | 'name'>> = {},
): Layer {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    name,
    order: 0,
    visible: true,
    style: { color: DEFAULT_LAYER_COLOR },
    schema: [],
    createdAt: now,
    updatedAt: now,
    ...opts,
  }
}

// ---- Tree helpers ----

export function childLayers(layers: Layer[], parentId: string | undefined): Layer[] {
  return layers
    .filter((l) => (l.parentId ?? undefined) === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
}

/** Depth-first, in display order. Layers whose parent is missing are shown at
 * the top level so nothing becomes unreachable. Cycle-safe. */
export function layerTree(layers: Layer[]): { layer: Layer; depth: number }[] {
  const ids = new Set(layers.map((l) => l.id))
  const roots = layers
    .filter((l) => !l.parentId || !ids.has(l.parentId) || l.parentId === l.id)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  const out: { layer: Layer; depth: number }[] = []
  const seen = new Set<string>()
  const visit = (layer: Layer, depth: number) => {
    if (seen.has(layer.id)) return
    seen.add(layer.id)
    out.push({ layer, depth })
    for (const child of childLayers(layers, layer.id)) visit(child, depth + 1)
  }
  roots.forEach((r) => visit(r, 0))
  // Anything left is in a parent cycle: show it at the top level.
  for (const l of layers) if (!seen.has(l.id)) visit(l, 0)
  return out
}

/** The layer and all its sublayers. */
export function subtreeIds(layers: Layer[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const l of layers) {
      if (l.parentId && out.has(l.parentId) && !out.has(l.id)) {
        out.add(l.id)
        grew = true
      }
    }
  }
  return out
}

/** Ids of layers that are not drawn: hidden themselves or under a hidden parent. */
export function hiddenLayerIds(layers: Layer[]): Set<string> {
  const byId = new Map(layers.map((l) => [l.id, l]))
  const hidden = new Set<string>()
  for (const l of layers) {
    let cur: Layer | undefined = l
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      if (!cur.visible) {
        hidden.add(l.id)
        break
      }
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  return hidden
}

/** "Parent / Child" */
export function layerPath(layers: Layer[], id: string): string {
  const byId = new Map(layers.map((l) => [l.id, l]))
  const names: string[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    names.unshift(cur.name)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return names.join(' / ')
}

/** Layer names the app files features into automatically (by kind, symbol or
 * track type). A feature sitting in one of these at the top level moves when
 * you pick a symbol; a feature in any other layer (an imported Avenza layer,
 * say) stays put. */
export const AUTO_LAYER_NAMES = new Set<string>([
  ...Object.values(DEFAULT_LAYERS),
  'Tracks',
  ...Object.values(FIRE_SYMBOLS).map((s) => s.layer),
  ...NWCG_SYMBOLS.map((s) => s.layer),
  ...TRACK_TYPES.map((t) => t.layer),
])

export function isAutoLayer(layer: Layer | undefined): boolean {
  return !layer || (!layer.parentId && !layer.source && AUTO_LAYER_NAMES.has(layer.name))
}

// ---- Styles ----

export interface ResolvedStyle {
  color: string
  width: number
  fill: string
  fillOpacity: number
  /** Pin symbol key; undefined = plain dot in `color`. */
  symbol?: string
}

export function resolveStyle(f: UserFeature): ResolvedStyle {
  return {
    color: f.color,
    width: f.width ?? DEFAULT_LINE_WIDTH,
    fill: f.fill ?? f.color,
    fillOpacity: f.fillOpacity ?? DEFAULT_FILL_OPACITY,
    symbol: f.kind === 'pin' && f.symbol ? f.symbol : undefined,
  }
}

export interface StyledFeature {
  feature: UserFeature
  layer: Layer
  /** GeoJSON geometry: areas closed, holes included. */
  geometry: Geometry
  style: ResolvedStyle
}

/**
 * Read API for anything that draws My Data elsewhere (e.g. the
 * send-area-as-GeoPDF writer): every feature whose layer and parents are
 * visible, in layer-tree order then creation order, with its style.
 */
export function visibleStyledFeatures(layers: Layer[], features: UserFeature[]): StyledFeature[] {
  const hidden = hiddenLayerIds(layers)
  const order = new Map(layerTree(layers).map(({ layer }, i) => [layer.id, i]))
  const byId = new Map(layers.map((l) => [l.id, l]))
  return features
    .filter((f) => byId.has(f.layerId) && !hidden.has(f.layerId))
    .sort(
      (a, b) =>
        (order.get(a.layerId) ?? 0) - (order.get(b.layerId) ?? 0) || a.createdAt - b.createdAt,
    )
    .map((f) => ({
      feature: f,
      layer: byId.get(f.layerId)!,
      geometry: featureGeometry(f) as Geometry,
      style: resolveStyle(f),
    }))
}

// ---- Attribute typing ----

/** KML SimpleField / any GIS type name → our type. Liberal. */
export function attrTypeFromName(name: string | null | undefined): AttrType {
  const t = (name ?? '').trim().toLowerCase()
  if (['bool', 'boolean', 'logical', 'yesno'].includes(t)) return 'boolean'
  if (['int', 'uint', 'short', 'ushort', 'integer', 'long', 'int32', 'int64', 'smallint'].includes(t))
    return 'integer'
  if (['float', 'double', 'real', 'number', 'numeric', 'decimal'].includes(t)) return 'real'
  return 'string'
}

/** Our type → KML 2.2 SimpleField type (Avenza writes these: string, bool,
 * int, double). */
export const KML_TYPE: Record<AttrType, string> = {
  string: 'string',
  boolean: 'bool',
  integer: 'int',
  real: 'double',
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on', 't'])
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'f'])

export function parseBool(v: string): boolean | undefined {
  const t = v.trim().toLowerCase()
  if (TRUE_WORDS.has(t)) return true
  if (FALSE_WORDS.has(t)) return false
  return undefined
}

/** Store values as text. Booleans become 'true'/'false'; everything else is
 * trimmed and kept as written, even if it doesn't match the type, so an odd
 * value is never dropped. */
export function normalizeAttrValue(type: AttrType, raw: string): string {
  const v = raw.trim()
  if (type === 'boolean') {
    const b = parseBool(v)
    return b === undefined ? v : String(b)
  }
  return v
}

/** Does this text fit the type? (For the edit form; import never rejects.) */
export function attrValueValid(type: AttrType, v: string): boolean {
  if (!v.trim()) return true
  if (type === 'integer') return /^[+-]?\d+$/.test(v.trim())
  if (type === 'real') return v.trim() !== '' && Number.isFinite(Number(v.trim()))
  if (type === 'boolean') return parseBool(v) !== undefined
  return true
}

/** Guess a type from imported values (DBF/GeoJSON numbers and booleans, CSV
 * text). Mixed or empty → string. */
export function inferAttrType(values: unknown[]): AttrType {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '')
  if (!present.length) return 'string'
  if (present.every((v) => typeof v === 'boolean')) return 'boolean'
  if (present.every((v) => typeof v === 'number' && Number.isFinite(v)))
    return present.every((v) => Number.isInteger(v)) ? 'integer' : 'real'
  if (present.every((v) => typeof v === 'string')) {
    const s = present as string[]
    if (s.every((v) => /^[+-]?(0|[1-9]\d*)$/.test(v.trim()))) return 'integer'
    if (s.every((v) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim()))) return 'real'
    if (s.every((v) => /^(true|false|yes|no)$/i.test(v.trim()))) return 'boolean'
  }
  return 'string'
}

export function attrToText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toISOString()
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// ---- Imports ----

export interface ImportedPhoto {
  featureId: string
  blob: Blob
  /** File name inside the source archive, for messages. */
  name: string
}

/** Everything one imported file adds to My Data. Ids are fresh. */
export interface ImportResult {
  /** Display name (document or file name). */
  name: string
  layers: Layer[]
  features: UserFeature[]
  photos: ImportedPhoto[]
  icons: IconAsset[]
  warnings: string[]
}

export function photoRecords(result: ImportResult): FeaturePhoto[] {
  const now = Date.now()
  return result.photos.map((p, i) => ({
    id: crypto.randomUUID(),
    featureId: p.featureId,
    blob: p.blob,
    // Keep the archive's order when the edit sheet sorts by createdAt.
    createdAt: now + i,
  }))
}

/** Feature fields an importer supplies (geometry comes separately). */
export type FeatureInit = Partial<
  Omit<UserFeature, 'id' | 'kind' | 'coordinates' | 'holes' | 'layerId' | 'times'>
> & {
  /** Per-vertex times (ms) for a line, or per part for multi-part lines. */
  times?: number[] | number[][]
}

const samePos = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1]

/** Unclose a ring and drop repeated closing vertices. */
function openRing(ring: Position[]): Position[] {
  const r = [...ring]
  while (r.length > 1 && samePos(r[0], r[r.length - 1])) r.pop()
  return r
}

const validPos = (p: unknown): p is Position =>
  Array.isArray(p) &&
  p.length >= 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]) &&
  Math.abs(p[1] as number) <= 90 &&
  Math.abs(p[0] as number) <= 540

/**
 * Collects layers and features for one import. Any GeoJSON geometry is split
 * into editable pins, lines and areas (multi-parts become separate features
 * with the same name and attributes; polygon holes are kept).
 */
export class ImportBuilder {
  layers: Layer[] = []
  features: UserFeature[] = []
  photos: ImportedPhoto[] = []
  icons: IconAsset[] = []
  warnings: string[] = []
  private dropped = 0
  private readonly now = Date.now()
  private readonly source: LayerSource

  constructor(source: Omit<LayerSource, 'importedAt'> & { importedAt?: number }) {
    this.source = { importedAt: this.now, ...source }
  }

  addLayer(name: string, parentId?: string, patch: Partial<Layer> = {}): Layer {
    const siblings = this.layers.filter((l) => l.parentId === parentId).length
    const layer = newLayer(name.trim() || 'Layer', {
      parentId,
      order: siblings,
      source: this.source,
      createdAt: this.now,
      updatedAt: this.now,
      ...patch,
    })
    this.layers.push(layer)
    return layer
  }

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id)
  }

  /** Add one geometry (any GeoJSON type) as one or more features. */
  addGeometry(layerId: string, geometry: Geometry | null | undefined, init: FeatureInit): UserFeature[] {
    if (!geometry) {
      this.dropped++
      return []
    }
    const out: UserFeature[] = []
    const layer = this.layer(layerId)
    const base = (kind: UserFeature['kind']): Omit<UserFeature, 'coordinates'> => {
      const { times: _times, ...rest } = init
      void _times
      return {
        createdAt: this.now,
        updatedAt: this.now,
        ...rest,
        id: crypto.randomUUID(),
        kind,
        layerId,
        name: init.name?.trim() || '',
        notes: init.notes ?? '',
        color: init.color ?? layer?.style.color ?? DEFAULT_LAYER_COLOR,
      }
    }
    const pin = (p: Position) => {
      if (!validPos(p)) return this.dropped++
      out.push({ ...base('pin'), coordinates: p })
    }
    const line = (coords: Position[], times?: number[]) => {
      const pts = coords.filter(validPos)
      if (pts.length < 2) return this.dropped++
      const f: UserFeature = { ...base('line'), coordinates: pts }
      if (times && times.length === coords.length && pts.length === coords.length) f.times = times
      out.push(f)
    }
    const area = (rings: Position[][]) => {
      const [outer, ...holes] = rings.map((r) => openRing(r.filter(validPos)))
      if (!outer || outer.length < 3) return this.dropped++
      const f: UserFeature = { ...base('area'), coordinates: outer }
      const keep = holes.filter((h) => h.length >= 3)
      if (keep.length) f.holes = keep
      out.push(f)
    }
    // A timed multi-part line (KML gx:MultiTrack, a GPX <trk> with several
    // <trkseg>) is one track with gaps, as a paused recording saves it.
    const track = (parts: Position[][], times: number[][]): boolean => {
      if (
        parts.length < 2 ||
        times.length !== parts.length ||
        parts.some((c, i) => c.length < 2 || times[i]?.length !== c.length || !c.every(validPos))
      ) {
        return false
      }
      out.push({
        ...base('line'),
        coordinates: parts.flat(),
        times: times.flat(),
        segmentStarts: startsOfParts(parts),
      })
      return true
    }
    const partTimes = (i: number): number[] | undefined => {
      const t = init.times
      if (!t?.length) return undefined
      return Array.isArray(t[0]) ? (t as number[][])[i] : i === 0 ? (t as number[]) : undefined
    }
    const visit = (g: Geometry) => {
      switch (g.type) {
        case 'Point':
          return pin(g.coordinates)
        case 'MultiPoint':
          return g.coordinates.forEach(pin)
        case 'LineString':
          return line(g.coordinates, partTimes(0))
        case 'MultiLineString':
          if (Array.isArray(init.times?.[0]) && track(g.coordinates, init.times as number[][])) return
          return g.coordinates.forEach((c, i) => line(c, partTimes(i)))
        case 'Polygon':
          return area(g.coordinates)
        case 'MultiPolygon':
          return g.coordinates.forEach(area)
        case 'GeometryCollection':
          return g.geometries.forEach(visit)
      }
    }
    visit(geometry)
    for (const f of out) stripFlatAltitude(f)
    this.features.push(...out)
    return out
  }

  /** Give unnamed features "<Kind> <n>" names, per layer. */
  private nameUnnamed() {
    const counts = new Map<string, number>()
    for (const f of this.features) {
      if (f.name) continue
      const label = { pin: 'Placemark', line: 'Line', area: 'Area' }[f.kind]
      const key = `${f.layerId}:${label}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      f.name = `${label} ${n}`
    }
  }

  result(name: string): ImportResult {
    this.nameUnnamed()
    if (this.dropped) {
      this.warnings.push(
        `${this.dropped} item${this.dropped === 1 ? '' : 's'} without usable coordinates skipped`,
      )
    }
    return {
      name,
      layers: this.layers,
      features: this.features,
      photos: this.photos,
      icons: this.icons,
      warnings: this.warnings,
    }
  }
}

/** Many tools write altitude 0 when they have none. If every vertex of a
 * feature is at exactly 0, drop the altitude so the feature stays 2-D. */
function stripFlatAltitude(f: UserFeature) {
  const all: Position[] =
    f.kind === 'pin'
      ? [f.coordinates as Position]
      : [...(f.coordinates as Position[]), ...(f.holes ?? []).flat()]
  if (!all.some((p) => p.length > 2)) return
  if (!all.every((p) => p.length < 3 || p[2] === 0)) return
  const flat = (p: Position): Position => [p[0], p[1]]
  if (f.kind === 'pin') f.coordinates = flat(f.coordinates as Position)
  else {
    f.coordinates = (f.coordinates as Position[]).map(flat)
    if (f.holes) f.holes = f.holes.map((h) => h.map(flat))
  }
}

/** Layer schema from the attribute values of its features: fields in first-
 * seen order, types inferred. `typed` supplies original typed values (DBF,
 * GeoJSON) where the text alone would be ambiguous. */
export function schemaFromFeatures(
  features: UserFeature[],
  typed?: Map<string, unknown[]>,
): AttrField[] {
  const values = new Map<string, unknown[]>()
  for (const f of features) {
    for (const a of f.attributes ?? []) {
      if (!values.has(a.k)) values.set(a.k, [])
      values.get(a.k)!.push(a.v)
    }
  }
  return [...values.entries()].map(([name, vals]) => ({
    name,
    type: inferAttrType(typed?.get(name) ?? vals),
  }))
}

/** Normalise booleans in features' values to match their layer schema. */
export function normalizeToSchema(features: UserFeature[], schema: AttrField[]) {
  const types = new Map(schema.map((s) => [s.name, s.type]))
  for (const f of features) {
    if (!f.attributes) continue
    f.attributes = f.attributes.map((a) => {
      const t = types.get(a.k)
      return t ? { k: a.k, v: normalizeAttrValue(t, a.v) } : a
    })
  }
}
