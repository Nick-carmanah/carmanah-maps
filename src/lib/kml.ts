/**
 * KML / KMZ reader → editable layers (layers.ts).
 *
 * Liberal in what it reads: Avenza Maps exports (Folder per layer,
 * <Schema>/<SchemaData> attributes, avenza:picklist, photos in images/ named
 * by pdfmaps_photos, gx:Track tracks), Google Earth / My Maps (<Data>,
 * StyleMap, files/ icons), QGIS/ArcGIS (SchemaData on placemarks only, HTML
 * descriptions), and our own exports (carmanah: metadata for symbols and
 * geofences). Elements are matched by local name, so KML 2.0/2.1/no-namespace
 * files work too. See docs/avenza-layers.md for the format notes.
 */
import { unzipSync } from 'fflate'
import type { Geometry, Position } from 'geojson'
import {
  attrTypeFromName,
  DEFAULT_LAYER_COLOR,
  ImportBuilder,
  normalizeToSchema,
  type AttrField,
  type ImportResult,
  type Layer,
  type LayerStyle,
} from './layers'
import type { UserFeature } from './features'
import { colorFromIconName, ICON_PREFIX, symbolKeyFromName } from './symbols'

export const KML_NS = 'http://www.opengis.net/kml/2.2'
export const GX_NS = 'http://www.google.com/kml/ext/2.2'
/** Avenza's extension namespace (picklists in Document <ExtendedData>). */
export const AVENZA_NS = 'http://www.avenza.com'
/** Our own extension namespace, for what plain KML can't say (symbol keys,
 * geofences). Lives only in Document <ExtendedData>, which KML 2.2 allows
 * to hold any namespaced XML; other apps ignore it. */
export const CARMANAH_NS = 'https://carmanahwildfire.com/ns/maps/1'

/** Avenza's built-in schema fields: the placemark's notes and its photos. */
export const NOTES_FIELD = 'Description'
export const PHOTOS_FIELD = 'pdfmaps_photos'
/** Older Avenza versions also list photo names here (";"-separated, no extension). */
const PHOTO_NAME_FIELD = 'Photo Name'

type Files = Record<string, Uint8Array>

export interface KmlContext {
  fileName: string
  format: string
  url?: string
  /** KMZ entries (photos, icons) for resolving relative hrefs. */
  files?: Files
}

// ---------- DOM helpers (namespace-agnostic) ----------

const isEl = (n: Node): n is Element => n.nodeType === 1

function kids(el: Element | Document, name?: string): Element[] {
  const out: Element[] = []
  el.childNodes.forEach((n) => {
    if (isEl(n) && (!name || n.localName === name)) out.push(n)
  })
  return out
}

const kid = (el: Element, name: string): Element | undefined => kids(el, name)[0]

const txt = (el: Element | null | undefined): string => (el?.textContent ?? '').trim()

const all = (root: Document | Element, name: string): Element[] =>
  Array.from(root.getElementsByTagNameNS('*', name))

function attr(el: Element, name: string, ns?: string): string {
  return (
    (ns ? el.getAttributeNS(ns, name) : null) ||
    el.getAttribute(name) ||
    (ns ? el.getAttribute(`avenza:${name}`) : null) ||
    ''
  )
}

const stripHash = (s: string) => s.trim().replace(/^.*#/, '')

// ---------- Text decoding ----------

/** Decode XML bytes using the BOM or the encoding in the XML declaration. */
export function decodeXml(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
  const enc = /encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1]
  if (enc && !/^utf-?8$/i.test(enc)) {
    try {
      return new TextDecoder(enc).decode(bytes)
    } catch {
      // unknown label → fall through to UTF-8
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

export function parseXml(text: string, what: string): Document {
  const dom = new DOMParser().parseFromString(text, 'application/xml')
  if (dom.getElementsByTagName('parsererror').length) throw new Error(`Not a valid ${what} file`)
  return dom
}

// ---------- Colours and styles ----------

interface Rgba {
  hex: string
  alpha: number
}

/** KML aabbggrr (also tolerates bbggrr and a leading #). */
export function parseKmlColor(s: string | undefined): Rgba | undefined {
  const t = (s ?? '').trim().replace(/^#/, '').toLowerCase()
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(t)) return undefined
  const full = t.length === 6 ? `ff${t}` : t
  return {
    hex: `#${full.slice(6, 8)}${full.slice(4, 6)}${full.slice(2, 4)}`,
    alpha: Math.round((parseInt(full.slice(0, 2), 16) / 255) * 100) / 100,
  }
}

interface KmlStyle {
  iconHref?: string
  iconColor?: Rgba
  lineColor?: Rgba
  lineWidth?: number
  polyColor?: Rgba
  polyFill?: boolean
  polyOutline?: boolean
}

function parseStyleEl(el: Element): KmlStyle {
  const s: KmlStyle = {}
  const icon = kid(el, 'IconStyle')
  if (icon) {
    s.iconColor = parseKmlColor(txt(kid(icon, 'color')))
    const href = txt(kid(icon, 'Icon') ? kid(kid(icon, 'Icon')!, 'href') : undefined)
    if (href) s.iconHref = href
  }
  const line = kid(el, 'LineStyle')
  if (line) {
    s.lineColor = parseKmlColor(txt(kid(line, 'color')))
    const w = parseFloat(txt(kid(line, 'width')))
    if (Number.isFinite(w)) s.lineWidth = w
  }
  const poly = kid(el, 'PolyStyle')
  if (poly) {
    s.polyColor = parseKmlColor(txt(kid(poly, 'color')))
    const fill = txt(kid(poly, 'fill'))
    if (fill) s.polyFill = fill !== '0' && fill.toLowerCase() !== 'false'
    const outline = txt(kid(poly, 'outline'))
    if (outline) s.polyOutline = outline !== '0' && outline.toLowerCase() !== 'false'
  }
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as KmlStyle
}

/** Document styles by id: <Style> and <StyleMap> (its "normal" pair). */
function styleResolver(dom: Document) {
  const styles = new Map<string, Element>()
  const maps = new Map<string, Element>()
  for (const s of all(dom, 'Style')) if (s.getAttribute('id')) styles.set(s.getAttribute('id')!, s)
  for (const m of all(dom, 'StyleMap')) if (m.getAttribute('id')) maps.set(m.getAttribute('id')!, m)
  const cache = new Map<string, KmlStyle>()
  const resolve = (url: string, depth = 0): KmlStyle => {
    const id = stripHash(url)
    if (!id || depth > 5) return {}
    if (cache.has(id)) return cache.get(id)!
    let out: KmlStyle = {}
    const style = styles.get(id)
    if (style) out = parseStyleEl(style)
    else {
      const map = maps.get(id)
      const pair =
        map && (kids(map, 'Pair').find((p) => txt(kid(p, 'key')) === 'normal') ?? kids(map, 'Pair')[0])
      if (pair) {
        const inline = kid(pair, 'Style')
        out = inline ? parseStyleEl(inline) : resolve(txt(kid(pair, 'styleUrl')), depth + 1)
      }
    }
    cache.set(id, out)
    return out
  }
  /** Shared style (styleUrl) overlaid with any inline <Style>. */
  return (el: Element): KmlStyle => {
    const shared = resolve(txt(kid(el, 'styleUrl')))
    const inline = kids(el, 'Style').map(parseStyleEl)
    return Object.assign({}, shared, ...inline)
  }
}

// ---------- Geometry ----------

function parseCoords(text: string): Position[] {
  return text
    .replace(/\s*,\s*/g, ',')
    .trim()
    .split(/\s+/)
    .map((t) => t.split(',').map(Number))
    .filter((p) => p.length >= 2 && p.every(Number.isFinite))
    .map((p) => (p.length > 3 ? p.slice(0, 3) : p))
}

interface ParsedGeom {
  geometry: Geometry
  /** Per-vertex times for gx:Track (per part for gx:MultiTrack). */
  times?: number[] | number[][]
}

function parseTrack(el: Element): { coords: Position[]; times?: number[] } {
  const coords = kids(el, 'coord')
    .map((c) => txt(c).split(/\s+/).map(Number))
    .filter((p) => p.length >= 2 && p.every(Number.isFinite))
  const times = kids(el, 'when').map((w) => Date.parse(txt(w)))
  return {
    coords,
    times: times.length === coords.length && times.every(Number.isFinite) ? times : undefined,
  }
}

function parseGeometry(el: Element): ParsedGeom | null {
  switch (el.localName) {
    case 'Point': {
      const c = parseCoords(txt(kid(el, 'coordinates')))[0]
      return c ? { geometry: { type: 'Point', coordinates: c } } : null
    }
    case 'LineString':
    case 'LinearRing':
      return { geometry: { type: 'LineString', coordinates: parseCoords(txt(kid(el, 'coordinates'))) } }
    case 'Polygon': {
      const ring = (b: Element) =>
        kids(b, 'LinearRing').map((r) => parseCoords(txt(kid(r, 'coordinates'))))
      const outer = kids(el, 'outerBoundaryIs').flatMap(ring)[0]
      if (!outer) return null
      const inner = kids(el, 'innerBoundaryIs').flatMap(ring)
      return { geometry: { type: 'Polygon', coordinates: [outer, ...inner] } }
    }
    case 'Track': {
      const t = parseTrack(el)
      return { geometry: { type: 'LineString', coordinates: t.coords }, times: t.times }
    }
    case 'MultiTrack': {
      const parts = kids(el, 'Track').map(parseTrack)
      const times = parts.every((p) => p.times) ? parts.map((p) => p.times!) : undefined
      return {
        geometry: { type: 'MultiLineString', coordinates: parts.map((p) => p.coords) },
        times,
      }
    }
    case 'MultiGeometry': {
      const parts = kids(el).map(parseGeometry).filter((g): g is ParsedGeom => !!g)
      return parts.length ? { geometry: { type: 'GeometryCollection', geometries: parts.map((p) => p.geometry) } } : null
    }
  }
  return null
}

const GEOMETRY_NAMES = new Set(['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiGeometry', 'Track', 'MultiTrack'])

// ---------- Descriptions and photos ----------

/** Plain text from an HTML-ish KML description. */
export function htmlToText(html: string): string {
  if (!/[<&]/.test(html)) return html.trim()
  const marked = html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
  let text: string
  try {
    text = new DOMParser().parseFromString(marked, 'text/html').body.textContent ?? ''
  } catch {
    text = marked.replace(/<[^>]+>/g, '')
  }
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i

/** <img src="…"> targets, plus bare image file names (some writers list them as text). */
function imageRefs(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) out.push(m[1])
  for (const tok of html.replace(/<[^>]+>/g, ' ').split(/\s+/)) if (IMAGE_EXT.test(tok)) out.push(tok)
  return out
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}

export function mimeFromName(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
}

/** Find an archive entry for a (relative, maybe URL-encoded) reference. */
function entryFinder(files: Files | undefined) {
  if (!files) return () => undefined
  const keys = Object.keys(files).filter((k) => !k.endsWith('/'))
  const lower = new Map(keys.map((k) => [k.toLowerCase(), k]))
  const byBase = new Map<string, string>()
  for (const k of keys) {
    const b = k.split('/').pop()!.toLowerCase()
    if (!byBase.has(b)) byBase.set(b, k)
  }
  return (ref: string): string | undefined => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return undefined // http:, file:, root:…
    const variants = new Set<string>()
    for (const r of [ref, safeDecode(ref)]) {
      const t = r.trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '')
      variants.add(t)
    }
    for (const v of variants) {
      if (files[v]) return v
      const k = lower.get(v.toLowerCase())
      if (k) return k
    }
    for (const v of variants) {
      const k = byBase.get(v.split('/').pop()!.toLowerCase())
      if (k) return k
    }
    return undefined
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// ---------- The reader ----------

export function parseKmlDocument(dom: Document, ctx: KmlContext): ImportResult {
  const root = dom.documentElement
  if (!root || !['kml', 'Document', 'Folder', 'Placemark'].includes(root.localName)) {
    throw new Error('Not a valid KML file')
  }
  const b = new ImportBuilder({ kind: 'import', fileName: ctx.fileName, format: ctx.format, url: ctx.url })
  const styleOf = styleResolver(dom)
  const findEntry = entryFinder(ctx.files)

  // Schemas by id (and by name: some writers point schemaUrl at the name).
  const schemas = new Map<string, AttrField[]>()
  for (const s of all(dom, 'Schema')) {
    const fields: AttrField[] = kids(s)
      .filter((f) => f.localName === 'SimpleField')
      .map((f) => ({ name: f.getAttribute('name') ?? '', type: attrTypeFromName(f.getAttribute('type')) }))
      .filter((f) => f.name && f.name !== NOTES_FIELD && f.name !== PHOTOS_FIELD)
    for (const key of [s.getAttribute('id'), s.getAttribute('name')]) if (key) schemas.set(key, fields)
  }
  // Avenza picklists: <avenza:picklist schemaUrl="schema1" avenza:field="X">
  for (const p of all(dom, 'picklist')) {
    const fields = schemas.get(stripHash(p.getAttribute('schemaUrl') ?? ''))
    const field = fields?.find((f) => f.name === attr(p, 'field', AVENZA_NS))
    const values = kids(p, 'picklistvalue').map((v) => txt(v)).filter(Boolean)
    if (field && values.length) field.picklist = values
  }
  // Our own metadata.
  const meta = new Map<string, Element>()
  for (const el of Array.from(dom.getElementsByTagNameNS(CARMANAH_NS, '*'))) {
    const ref = el.getAttribute('ref')
    if (ref) meta.set(`${el.localName}:${ref}`, el)
  }

  // Icons: one asset per archive entry; plain dot and our symbols by name.
  const iconCache = new Map<string, { symbol?: string; remote?: string; color?: string }>()
  let missingIcons = 0
  const resolveIcon = (href: string) => {
    if (iconCache.has(href)) return iconCache.get(href)!
    let out: { symbol?: string; remote?: string; color?: string } = {}
    const base = (href.split(/[?#]/)[0].split('/').pop() ?? '').toLowerCase()
    const known = symbolKeyFromName(href)
    if (base === 'dot.png') out = {}
    else if (known) out = { symbol: known }
    else if (/^https?:/i.test(href)) out = { remote: href, color: colorFromIconName(href) }
    else {
      const entry = findEntry(href)
      if (entry) {
        const id = crypto.randomUUID()
        b.icons.push({ id, name: entry, blob: new Blob([files(entry)], { type: mimeFromName(entry) }) })
        out = { symbol: ICON_PREFIX + id }
      } else if (!/^root:/i.test(href)) missingIcons++
    }
    iconCache.set(href, out)
    return out
  }
  const files = (entry: string) => ctx.files![entry] as Uint8Array<ArrayBuffer>

  const toLayerStyle = (s: KmlStyle): LayerStyle | undefined => {
    const color = s.lineColor?.hex ?? s.iconColor?.hex ?? s.polyColor?.hex
    const icon = s.iconHref ? resolveIcon(s.iconHref) : {}
    if (!color && !icon.symbol) return undefined
    const style: LayerStyle = { color: color ?? icon.color ?? DEFAULT_LAYER_COLOR }
    if (s.lineWidth !== undefined) style.width = s.lineWidth
    if (s.polyColor) {
      style.fill = s.polyColor.hex
      style.fillOpacity = s.polyFill === false ? 0 : s.polyColor.alpha
    }
    if (icon.symbol) style.symbol = icon.symbol
    return style
  }

  /** Fields each layer's placemarks used via SchemaData, in first-seen order. */
  const usedSchema = new Map<string, AttrField[]>()
  const styledLayers = new Set<string>()

  const folderLayer = (el: Element, parentId: string | undefined): Layer => {
    const name = txt(kid(el, 'name')) || 'Layer'
    const style = toLayerStyle(styleOf(el))
    const schemaUrl = kid(el, 'ExtendedData')
      ? kids(kid(el, 'ExtendedData')!, 'SchemaData')[0]?.getAttribute('schemaUrl')
      : undefined
    const schema = schemaUrl ? (schemas.get(stripHash(schemaUrl)) ?? []) : []
    const layer = b.addLayer(name, parentId, {
      visible: txt(kid(el, 'visibility')) !== '0',
      schema: schema.map((f) => ({ ...f })),
      ...(style ? { style } : {}),
    })
    if (style) styledLayers.add(layer.id)
    const m = meta.get(`layer:${el.getAttribute('id')}`)
    const metaSymbol = m?.getAttribute('symbol')
    if (metaSymbol && !metaSymbol.startsWith(ICON_PREFIX)) layer.style.symbol = metaSymbol
    return layer
  }

  const docEl = root.localName === 'kml' ? (kid(root, 'Document') ?? root) : root
  const docName =
    (docEl !== root || root.localName !== 'kml' ? txt(kid(docEl, 'name')) : '') ||
    ctx.fileName.replace(/\.(kml|kmz|zip|xml)$/i, '')
  let looseLayer: Layer | undefined
  let skippedOverlays = 0
  let skippedLinks = 0

  const placemark = (pm: Element, layer: Layer) => {
    const geomEl = kids(pm).find((c) => GEOMETRY_NAMES.has(c.localName))
    const parsed = geomEl ? parseGeometry(geomEl) : null
    const descHtml = kid(pm, 'description')?.textContent ?? ''

    // Attributes: SchemaData (typed, schema fields) then Data (per-feature).
    const schemaVals: [string, string][] = []
    const dataVals: [string, string][] = []
    const ext = kid(pm, 'ExtendedData')
    const used = usedSchema.get(layer.id) ?? []
    usedSchema.set(layer.id, used)
    for (const sd of ext ? kids(ext, 'SchemaData') : []) {
      const declared = schemas.get(stripHash(sd.getAttribute('schemaUrl') ?? '')) ?? []
      for (const f of declared) if (!used.some((u) => u.name === f.name)) used.push({ ...f })
      for (const v of kids(sd, 'SimpleData')) {
        const name = v.getAttribute('name') ?? ''
        if (!name) continue
        schemaVals.push([name, v.textContent ?? ''])
        if (name !== NOTES_FIELD && name !== PHOTOS_FIELD && !used.some((u) => u.name === name)) {
          used.push({ name, type: 'string' })
        }
      }
    }
    for (const d of ext ? kids(ext, 'Data') : []) {
      const name = d.getAttribute('name') ?? ''
      if (name) dataVals.push([name, kid(d, 'value')?.textContent ?? ''])
    }
    const take = (name: string): string | undefined => {
      for (const list of [schemaVals, dataVals]) {
        const i = list.findIndex(([k]) => k.toLowerCase() === name.toLowerCase())
        if (i >= 0) return list.splice(i, 1)[0][1]
      }
      return undefined
    }
    const notesAttr = take(NOTES_FIELD)
    const photosHtml = take(PHOTOS_FIELD) ?? ''
    const photoNames = [...schemaVals, ...dataVals].find(([k]) => k === PHOTO_NAME_FIELD)?.[1]
    const attributes: { k: string; v: string }[] = []
    for (const [k, v] of [...schemaVals, ...dataVals]) {
      if (v.trim() !== '' && !attributes.some((a) => a.k === k)) attributes.push({ k, v: v.trim() })
    }

    const when = txt(kid(pm, 'TimeStamp') ? kid(kid(pm, 'TimeStamp')!, 'when') : undefined) ||
      txt(kid(pm, 'TimeSpan') ? kid(kid(pm, 'TimeSpan')!, 'begin') : undefined)
    const createdAt = when ? Date.parse(when) : NaN

    const m = meta.get(`feature:${pm.getAttribute('id')}`)
    const fenceRadius = Number(m?.getAttribute('fence'))
    const features = b.addGeometry(layer.id, parsed?.geometry, {
      name: txt(kid(pm, 'name')),
      notes: notesAttr !== undefined ? notesAttr.trim() : htmlToText(descHtml),
      attributes: attributes.length ? attributes : undefined,
      times: parsed?.times,
      ...(Number.isFinite(createdAt) ? { createdAt, updatedAt: createdAt } : {}),
      ...(m && Number.isFinite(fenceRadius) && fenceRadius > 0
        ? { geofence: { enabled: m.getAttribute('fenceOn') !== '0', radiusM: fenceRadius } }
        : {}),
    })
    const style = styleOf(pm)
    for (const f of features) applyStyle(f, style, layer, m)

    // Photos: pdfmaps_photos (Avenza), <description> images, Photo Name list.
    if (features.length && ctx.files) {
      const refs = [...imageRefs(photosHtml), ...imageRefs(descHtml)]
      for (const n of (photoNames ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
        refs.push(IMAGE_EXT.test(n) ? `images/${n}` : `images/${n}.jpg`)
      }
      const seen = new Set<string>()
      for (const ref of refs) {
        const entry = findEntry(ref)
        if (!entry || seen.has(entry)) continue
        seen.add(entry)
        b.photos.push({
          featureId: features[0].id,
          name: entry,
          blob: new Blob([files(entry)], { type: mimeFromName(entry) }),
        })
      }
    }
  }

  const applyStyle = (f: UserFeature, s: KmlStyle, layer: Layer, m: Element | undefined) => {
    if (f.kind === 'pin') {
      const icon = s.iconHref ? resolveIcon(s.iconHref) : {}
      // White tint on someone else's icon means "no tint"; on our dot (or no
      // icon at all) it's a white pin.
      const tint =
        s.iconColor && !(s.iconColor.hex === '#ffffff' && (icon.remote || icon.symbol))
          ? s.iconColor.hex
          : undefined
      f.color = m?.getAttribute('color') || tint || icon.color || layer.style.color
      // Our metadata names built-in symbols; imported icons only come from files.
      const metaSymbol = m?.getAttribute('symbol')
      const symbol = (metaSymbol && !metaSymbol.startsWith(ICON_PREFIX) ? metaSymbol : '') || icon.symbol
      if (symbol) f.symbol = symbol
      if (icon.remote && !symbol) f.iconHref = icon.remote
      return
    }
    f.color = s.lineColor?.hex ?? (f.kind === 'area' ? s.polyColor?.hex : undefined) ?? layer.style.color
    if (s.lineWidth !== undefined) f.width = s.lineWidth
    if (s.polyOutline === false) f.width = 0
    if (f.kind === 'area') {
      if (s.polyColor) f.fill = s.polyColor.hex
      if (s.polyFill === false) f.fillOpacity = 0
      else if (s.polyColor) f.fillOpacity = s.polyColor.alpha
    }
  }

  const walk = (el: Element, layer: Layer | undefined) => {
    for (const c of kids(el)) {
      switch (c.localName) {
        case 'Folder':
        case 'Document':
          walk(c, folderLayer(c, layer?.id))
          break
        case 'Placemark':
          if (!layer) looseLayer ??= b.addLayer(docName)
          placemark(c, layer ?? looseLayer!)
          break
        case 'NetworkLink':
          skippedLinks++
          break
        case 'GroundOverlay':
        case 'PhotoOverlay':
        case 'ScreenOverlay':
          skippedOverlays++
          break
      }
    }
  }
  if (root.localName === 'Placemark') {
    looseLayer = b.addLayer(docName)
    placemark(root, looseLayer)
  } else if (root.localName === 'Folder') {
    walk(root, folderLayer(root, undefined))
  } else {
    walk(docEl, undefined)
  }

  // Schemas only declared on placemarks (QGIS, ArcGIS) become the layer's;
  // a layer with no style of its own takes its first feature's.
  for (const layer of b.layers) {
    const used = usedSchema.get(layer.id) ?? []
    for (const f of used) if (!layer.schema.some((s) => s.name === f.name)) layer.schema.push(f)
    const feats = b.features.filter((f) => f.layerId === layer.id)
    normalizeToSchema(feats, layer.schema)
    if (!styledLayers.has(layer.id) && feats.length) {
      const f = feats.find((x) => x.kind !== 'pin') ?? feats[0]
      layer.style = { color: f.color }
      if (f.width !== undefined) layer.style.width = f.width
      if (f.fill !== undefined) layer.style.fill = f.fill
      if (f.fillOpacity !== undefined) layer.style.fillOpacity = f.fillOpacity
    }
  }

  if (skippedOverlays) b.warnings.push(`${skippedOverlays} image overlay(s) not imported (use GeoPDF import for maps)`)
  if (skippedLinks) b.warnings.push(`${skippedLinks} network link(s) not followed`)
  if (missingIcons) b.warnings.push(`${missingIcons} icon image(s) not found in the file`)
  const result = b.result(docName)
  if (!result.features.length && !result.layers.some((l) => l.schema.length)) {
    throw new Error('KML contains no map features')
  }
  return result
}

export function parseKmlBytes(bytes: Uint8Array, ctx: KmlContext): ImportResult {
  return parseKmlDocument(parseXml(decodeXml(bytes), 'KML'), ctx)
}

/** KMZ: the main KML is doc.kml (or the first .kml); everything else in the
 * archive (images/, files/) is available for photos and icons. */
export function parseKmz(buffer: ArrayBuffer | Uint8Array, ctx: Omit<KmlContext, 'files'>): ImportResult {
  const files = unzipSync(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))
  const names = Object.keys(files)
  const entry =
    names.find((n) => n.toLowerCase() === 'doc.kml') ?? names.find((n) => n.toLowerCase().endsWith('.kml'))
  if (!entry) throw new Error('KMZ archive contains no KML document')
  return parseKmlBytes(files[entry], { ...ctx, files })
}
