/**
 * Exports for sharing My Data, written so Avenza Maps, Google Earth and QGIS
 * all read them:
 *
 * - KMZ: doc.kml + files/ (symbol icons) + images/ (photos). One <Folder> per
 *   layer (nested for sublayers), typed attributes as <Schema>/<SchemaData>,
 *   picklists as avenza:picklist, one shared <Style> per distinct look.
 *   Photos are referenced the way Avenza writes them: an <img> list in the
 *   "pdfmaps_photos" field, files under images/ — and in <description> too,
 *   for Google Earth.
 * - KML: the same without photos or icon files.
 * - GPX: placemarks as waypoints, lines/tracks (with times) and areas as tracks.
 * - CSV: placemarks only, one column per attribute.
 *
 * Plain KML 2.2 in XSD element order; the only extensions are gx:Track and
 * namespaced elements inside Document <ExtendedData> (allowed by KML 2.2).
 * Format notes and assumptions: docs/avenza-layers.md.
 */
import type { Position } from 'geojson'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { DEFAULT_FILL_OPACITY, DEFAULT_LINE_WIDTH, type UserFeature } from './features'
import { KML_TYPE, layerTree, type AttrField, type Layer } from './layers'
import { AVENZA_NS, CARMANAH_NS, GX_NS, KML_NS, NOTES_FIELD, PHOTOS_FIELD } from './kml'
import { dotPng, symbolLabel } from './symbols'
import { toCsv } from './csv'

export type ExportFormat = 'kmz' | 'kml' | 'gpx' | 'csv'

export interface ExportOptions {
  format: ExportFormat
  /** Layers to include. A layer's sublayers are only included if listed too. */
  layerIds: string[]
  /** KMZ: embed photos. */
  includePhotos: boolean
  /** Write recorded tracks as plain lines (KML LineString; GPX without times). */
  tracksAsLines: boolean
  docName: string
}

export interface ExportInput {
  layers: Layer[]
  features: UserFeature[]
  /** Photos per feature id, oldest first (KMZ). */
  photos?: Map<string, Blob[]>
  /** PNG for a pin symbol key (KMZ). Null = no icon file. */
  symbolPng?: (symbol: string) => Promise<Blob | null>
}

export interface ExportFile {
  filename: string
  mime: string
  content: string | Blob
}

// ---------- helpers ----------

const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

function esc(s: string): string {
  return s
    .replace(BAD_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const cdata = (s: string) => `<![CDATA[${s.replace(BAD_XML, '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`

/** '#rrggbb' + opacity (0–1) → KML aabbggrr. */
export function kmlColor(hex: string, opacity = 1): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  const a = Math.max(0, Math.min(255, Math.round(opacity * 255)))
    .toString(16)
    .padStart(2, '0')
  return (m ? `${a}${m[3]}${m[2]}${m[1]}` : `${a}ffffff`).toLowerCase()
}

const num = (n: number) => String(n)
const coordStr = (p: Position) => p.slice(0, 3).map(num).join(',')
const iso = (t: number) => new Date(t).toISOString()

function asciiSlug(s: string, fallback: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return out || fallback
}

function extFor(blob: Blob, fallback = 'jpg'): string {
  const t = blob.type.toLowerCase()
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('png')) return 'png'
  if (t.includes('gif')) return 'gif'
  if (t.includes('webp')) return 'webp'
  if (t.includes('heic')) return 'heic'
  if (t.includes('heif')) return 'heif'
  return fallback
}

const isTrack = (f: UserFeature) =>
  f.kind === 'line' && !!f.times && f.times.length === (f.coordinates as Position[]).length

/** The exported layer tree: chosen layers, a layer at the top if its parent
 * wasn't chosen. Features of chosen layers only. */
export function exportSelection(input: ExportInput, layerIds: string[]) {
  const chosen = new Set(layerIds)
  const layers = input.layers
    .filter((l) => chosen.has(l.id))
    .map((l) => (l.parentId && chosen.has(l.parentId) ? l : { ...l, parentId: undefined }))
  const tree = layerTree(layers)
  const features = input.features.filter((f) => chosen.has(f.layerId))
  return { layers, tree, features }
}

function pathsIn(tree: { layer: Layer; depth: number }[]): Map<string, string> {
  const byId = new Map(tree.map((t) => [t.layer.id, t.layer]))
  const out = new Map<string, string>()
  for (const { layer } of tree) {
    const names = [layer.name]
    let p = layer.parentId ? byId.get(layer.parentId) : undefined
    while (p) {
      names.unshift(p.name)
      p = p.parentId ? byId.get(p.parentId) : undefined
    }
    out.set(layer.id, names.join(' / '))
  }
  return out
}

// ---------- KML ----------

export interface KmlAssets {
  /** Icon file path in the KMZ for a symbol key, or 'dot' for a plain pin. */
  iconPath?: (symbol: string | 'dot') => string | undefined
  /** Photo paths (images/…) per feature id. */
  photoRefs?: Map<string, string[]>
}

export function featuresToKml(input: ExportInput, opts: ExportOptions, assets: KmlAssets = {}): string {
  const { tree, features } = exportSelection(input, opts.layerIds)
  const styles = new Map<string, string>() // body → id
  const styleId = (body: string) => {
    if (!styles.has(body)) styles.set(body, `style${styles.size}`)
    return styles.get(body)!
  }
  const iconStyle = (symbol: string | undefined, color: string, remoteHref?: string) => {
    const href = symbol
      ? assets.iconPath?.(symbol)
      : remoteHref ?? assets.iconPath?.('dot')
    // A plain dot is a white icon tinted to the pin colour; symbol and
    // remote icons keep their own colours.
    const tint = !symbol && !remoteHref ? `<color>${kmlColor(color)}</color>` : ''
    const icon = href
      ? `<Icon><href>${esc(href)}</href></Icon><hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/>`
      : ''
    return tint || icon ? `<IconStyle>${tint}${icon}</IconStyle>` : ''
  }
  const lineStyle = (color: string, width: number) =>
    `<LineStyle><color>${kmlColor(color)}</color><width>${num(width)}</width></LineStyle>`
  const polyStyle = (fill: string, opacity: number, outline: boolean) =>
    `<PolyStyle><color>${kmlColor(fill, opacity)}</color>${opacity === 0 ? '<fill>0</fill>' : ''}${
      outline ? '' : '<outline>0</outline>'
    }</PolyStyle>`

  const featureStyle = (f: UserFeature) => {
    const width = f.width ?? DEFAULT_LINE_WIDTH
    if (f.kind === 'pin') return styleId(iconStyle(f.symbol || undefined, f.color, f.iconHref))
    if (f.kind === 'line') return styleId(lineStyle(f.color, width))
    return styleId(
      lineStyle(f.color, width) +
        polyStyle(f.fill ?? f.color, f.fillOpacity ?? DEFAULT_FILL_OPACITY, width > 0),
    )
  }
  const layerStyle = (l: Layer) => {
    const s = l.style
    return styleId(
      iconStyle(s.symbol, s.color) +
        lineStyle(s.color, s.width ?? DEFAULT_LINE_WIDTH) +
        polyStyle(s.fill ?? s.color, s.fillOpacity ?? DEFAULT_FILL_OPACITY, true),
    )
  }

  // Schemas: one per layer, Avenza-style (built-in Description + Photos first).
  const schemaIds = new Map<string, string>()
  const schemaXml: string[] = []
  const picklists: string[] = []
  tree.forEach(({ layer }, i) => {
    const id = `schema${i}`
    schemaIds.set(layer.id, id)
    const fields = layer.schema.filter((f) => f.name && f.name !== NOTES_FIELD && f.name !== PHOTOS_FIELD)
    schemaXml.push(
      `    <Schema id="${id}" name="${id}">\n` +
        `      <SimpleField type="string" name="${NOTES_FIELD}"/>\n` +
        `      <SimpleField type="string" name="${PHOTOS_FIELD}"><displayName>Photos</displayName></SimpleField>\n` +
        fields.map((f) => `      <SimpleField type="${KML_TYPE[f.type]}" name="${esc(f.name)}"/>\n`).join('') +
        `    </Schema>`,
    )
    for (const f of fields) {
      if (!f.picklist?.length) continue
      picklists.push(
        `      <avenza:picklist schemaUrl="${id}" avenza:field="${esc(f.name)}">` +
          f.picklist.map((v) => `<avenza:picklistvalue>${cdata(v)}</avenza:picklistvalue>`).join('') +
          `</avenza:picklist>`,
      )
    }
  })

  const meta: string[] = []
  const placemarkIds = new Map(features.map((f, i) => [f.id, `f${i + 1}`]))
  const layerIds = new Map(tree.map(({ layer }, i) => [layer.id, `L${i + 1}`]))

  const placemark = (f: UserFeature, schema: AttrField[], indent: string) => {
    const pid = placemarkIds.get(f.id)!
    const photos = assets.photoRefs?.get(f.id) ?? []
    const imgs = photos.map((p) => `<img src="${esc(p)}" /><br />`).join('')
    const notesHtml = esc(f.notes).replace(/\r?\n/g, '<br/>')
    const desc = f.notes || photos.length
      ? `<description>${cdata([notesHtml, imgs].filter(Boolean).join('<br/>'))}</description>`
      : ''
    const inSchema = new Set(schema.map((s) => s.name))
    const attrs = (f.attributes ?? []).filter((a) => a.k && a.v !== '')
    const data = attrs
      .filter((a) => !inSchema.has(a.k))
      .map((a) => `<Data name="${esc(a.k)}"><value>${esc(a.v)}</value></Data>`)
    const simple = [
      ...(f.notes ? [`<SimpleData name="${NOTES_FIELD}">${esc(f.notes)}</SimpleData>`] : []),
      ...(imgs ? [`<SimpleData name="${PHOTOS_FIELD}">${cdata(imgs)}</SimpleData>`] : []),
      ...schema
        .map((s) => attrs.find((a) => a.k === s.name))
        .filter((a): a is { k: string; v: string } => !!a)
        .map((a) => `<SimpleData name="${esc(a.k)}">${esc(a.v)}</SimpleData>`),
    ]
    const ext =
      data.length || simple.length
        ? `<ExtendedData>${data.join('')}${
            simple.length ? `<SchemaData schemaUrl="#${schemaIds.get(f.layerId)}">${simple.join('')}</SchemaData>` : ''
          }</ExtendedData>`
        : ''
    // What plain KML can't carry: our symbol key (and the pin colour behind
    // it), and geofence settings.
    // (Imported icons travel as files/ images instead: their ids are local.)
    const symbolPin = f.kind === 'pin' && !!f.symbol && !f.symbol.startsWith('icon-')
    if (symbolPin || f.geofence) {
      const a = [`ref="${pid}"`]
      if (symbolPin) a.push(`symbol="${esc(f.symbol!)}"`, `color="${esc(f.color)}"`)
      if (f.geofence) {
        a.push(`fence="${f.geofence.radiusM ?? 0}"`, `fenceOn="${f.geofence.enabled ? 1 : 0}"`)
      }
      meta.push(`      <carmanah:feature ${a.join(' ')}/>`)
    }
    let geom: string
    if (f.kind === 'pin') {
      geom = `<Point><coordinates>${coordStr(f.coordinates as Position)}</coordinates></Point>`
    } else if (f.kind === 'line' && isTrack(f) && !opts.tracksAsLines) {
      const pts = f.coordinates as Position[]
      geom =
        `<gx:Track>` +
        f.times!.map((t) => `<when>${iso(t)}</when>`).join('') +
        pts.map((p) => `<gx:coord>${num(p[0])} ${num(p[1])} ${num(p[2] ?? 0)}</gx:coord>`).join('') +
        `</gx:Track>`
    } else if (f.kind === 'line') {
      geom = `<LineString><tessellate>1</tessellate><coordinates>${(f.coordinates as Position[]).map(coordStr).join(' ')}</coordinates></LineString>`
    } else {
      const ring = (r: Position[]) =>
        `<LinearRing><coordinates>${[...r, r[0]].map(coordStr).join(' ')}</coordinates></LinearRing>`
      geom =
        `<Polygon><tessellate>1</tessellate><outerBoundaryIs>${ring(f.coordinates as Position[])}</outerBoundaryIs>` +
        (f.holes ?? []).map((h) => `<innerBoundaryIs>${ring(h)}</innerBoundaryIs>`).join('') +
        `</Polygon>`
    }
    return (
      `${indent}<Placemark id="${pid}"><name>${esc(f.name)}</name>${desc}` +
      `<TimeStamp><when>${iso(f.createdAt)}</when></TimeStamp>` +
      `<styleUrl>#${featureStyle(f)}</styleUrl>${ext}${geom}</Placemark>`
    )
  }

  const byLayer = new Map<string, UserFeature[]>()
  for (const f of features) {
    if (!byLayer.has(f.layerId)) byLayer.set(f.layerId, [])
    byLayer.get(f.layerId)!.push(f)
  }
  const children = (parentId: string | undefined) => tree.filter((t) => t.layer.parentId === parentId)
  const folder = (layer: Layer, depth: number): string => {
    const ind = '    ' + '  '.repeat(depth)
    if (layer.style.symbol && !layer.style.symbol.startsWith('icon-')) meta.push(`      <carmanah:layer ref="${layerIds.get(layer.id)}" symbol="${esc(layer.style.symbol)}"/>`)
    const items = [
      ...(byLayer.get(layer.id) ?? []).map((f) => placemark(f, layer.schema, ind + '  ')),
      ...children(layer.id).map((c) => folder(c.layer, depth + 1)),
    ]
    return (
      `${ind}<Folder id="${layerIds.get(layer.id)}">\n` +
      `${ind}  <name>${esc(layer.name)}</name>\n` +
      (layer.visible ? '' : `${ind}  <visibility>0</visibility>\n`) +
      `${ind}  <styleUrl>#${layerStyle(layer)}</styleUrl>\n` +
      `${ind}  <ExtendedData><SchemaData schemaUrl="#${schemaIds.get(layer.id)}"/></ExtendedData>\n` +
      items.map((s) => s + '\n').join('') +
      `${ind}</Folder>`
    )
  }
  const folders = children(undefined).map((t) => folder(t.layer, 0))

  const styleXml = [...styles.entries()].map(
    ([body, id]) => `    <Style id="${id}">${body}</Style>`,
  )
  const extended =
    picklists.length || meta.length ? `    <ExtendedData>\n${[...picklists, ...meta].join('\n')}\n    </ExtendedData>\n` : ''

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="${KML_NS}" xmlns:gx="${GX_NS}" xmlns:avenza="${AVENZA_NS}" xmlns:carmanah="${CARMANAH_NS}">\n` +
    `  <Document>\n` +
    `    <name>${esc(opts.docName)}</name>\n` +
    styleXml.map((s) => s + '\n').join('') +
    extended +
    schemaXml.map((s) => s + '\n').join('') +
    folders.map((s) => s + '\n').join('') +
    `  </Document>\n` +
    `</kml>\n`
  )
}

/** KMZ: doc.kml first (Google Earth reads the first KML), then icons in
 * files/ and photos in images/. Images are stored, not re-compressed. */
export async function featuresToKmz(input: ExportInput, opts: ExportOptions): Promise<Blob> {
  const { tree, features } = exportSelection(input, opts.layerIds)
  const zip: Zippable = { 'doc.kml': new Uint8Array() }
  const store = async (path: string, blob: Blob) => {
    zip[path] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]
  }

  // Icons: one file per symbol used, plus the tintable dot.
  const iconPaths = new Map<string, string>()
  const symbols = new Set<string>()
  for (const f of features) if (f.kind === 'pin' && f.symbol) symbols.add(f.symbol)
  for (const { layer } of tree) if (layer.style.symbol) symbols.add(layer.style.symbol)
  for (const sym of symbols) {
    const png = await input.symbolPng?.(sym)
    if (!png) continue
    const path = `files/${asciiSlug(sym, 'icon').slice(0, 48)}.${extFor(png, 'png')}`
    await store(path, png)
    iconPaths.set(sym, path)
  }
  zip['files/dot.png'] = [dotPng(), { level: 0 }]
  iconPaths.set('dot', 'files/dot.png')

  // Photos: images/<feature name>.jpg, images/<feature name>_2.jpg …
  const photoRefs = new Map<string, string[]>()
  if (opts.includePhotos && input.photos) {
    const used = new Set<string>()
    for (const f of features) {
      const blobs = input.photos.get(f.id) ?? []
      const refs: string[] = []
      for (const blob of blobs) {
        const base = asciiSlug(f.name, 'photo')
        let path = `images/${base}.${extFor(blob)}`
        for (let n = 2; used.has(path.toLowerCase()); n++) path = `images/${base}_${n}.${extFor(blob)}`
        used.add(path.toLowerCase())
        await store(path, blob)
        refs.push(path)
      }
      if (refs.length) photoRefs.set(f.id, refs)
    }
  }

  zip['doc.kml'] = strToU8(
    featuresToKml(input, opts, { iconPath: (s) => iconPaths.get(s), photoRefs }),
  )
  const zipped = zipSync(zip)
  return new Blob([zipped as Uint8Array<ArrayBuffer>], { type: 'application/vnd.google-earth.kmz' })
}

// ---------- GPX ----------

export function featuresToGpx(input: ExportInput, opts: ExportOptions): string {
  const { features } = exportSelection(input, opts.layerIds)
  const pt = (tag: string, p: Position, time?: number, extra = '') =>
    `<${tag} lat="${num(p[1])}" lon="${num(p[0])}">` +
    (p[2] !== undefined ? `<ele>${num(p[2])}</ele>` : '') +
    (time !== undefined ? `<time>${iso(time)}</time>` : '') +
    extra +
    `</${tag}>`
  const wpts = features
    .filter((f) => f.kind === 'pin')
    .map((f) =>
      '  ' +
      pt(
        'wpt',
        f.coordinates as Position,
        f.createdAt,
        `<name>${esc(f.name)}</name>` +
          (f.notes ? `<desc>${esc(f.notes)}</desc>` : '') +
          (f.symbol ? `<sym>${esc(symbolLabel(f.symbol))}</sym>` : ''),
      ),
    )
  const trks = features
    .filter((f) => f.kind !== 'pin')
    .map((f) => {
      const pts = f.coordinates as Position[]
      const ring = f.kind === 'area' ? [...pts, pts[0]] : pts
      const times = isTrack(f) && !opts.tracksAsLines ? f.times : undefined
      const trkpts = ring.map((p, i) => `      ${pt('trkpt', p, times?.[i])}`).join('\n')
      return (
        `  <trk><name>${esc(f.name)}</name>${f.notes ? `<desc>${esc(f.notes)}</desc>` : ''}\n` +
        `    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>`
      )
    })
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Carmanah Maps" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata><name>${esc(opts.docName)}</name></metadata>\n` +
    [...wpts, ...trks].join('\n') +
    `\n</gpx>\n`
  )
}

// ---------- CSV ----------

const CSV_COLUMNS = ['Name', 'Latitude', 'Longitude', 'Altitude', 'Description', 'Layer', 'Symbol', 'Color', 'Created']

/** Placemarks only (like Avenza): one row each, one column per attribute. */
export function featuresToCsv(input: ExportInput, opts: ExportOptions): string {
  const { tree, features } = exportSelection(input, opts.layerIds)
  const paths = pathsIn(tree)
  const pins = features.filter((f) => f.kind === 'pin')
  const keys: string[] = []
  for (const { layer } of tree) for (const s of layer.schema) if (!keys.includes(s.name)) keys.push(s.name)
  for (const f of pins) for (const a of f.attributes ?? []) if (a.k && !keys.includes(a.k)) keys.push(a.k)
  const reserved = new Set(CSV_COLUMNS.map((c) => c.toLowerCase()))
  const header = [
    ...CSV_COLUMNS,
    ...keys.map((k) => (reserved.has(k.toLowerCase()) ? `${k} (attribute)` : k)),
  ]
  const rows = pins.map((f) => {
    const [lng, lat, alt] = f.coordinates as Position
    const attrs = new Map((f.attributes ?? []).map((a) => [a.k, a.v]))
    return [
      f.name,
      num(lat),
      num(lng),
      alt !== undefined ? num(alt) : '',
      f.notes,
      paths.get(f.layerId) ?? '',
      symbolLabel(f.symbol),
      f.color,
      iso(f.createdAt),
      ...keys.map((k) => attrs.get(k) ?? ''),
    ]
  })
  return toCsv([header, ...rows])
}

// ---------- One call for the UI ----------

export async function buildExport(input: ExportInput, opts: ExportOptions): Promise<ExportFile> {
  const stamp = new Date().toISOString().slice(0, 10)
  const base = `${asciiSlug(opts.docName, 'carmanah-maps').toLowerCase().replace(/_/g, '-')}-${stamp}`
  switch (opts.format) {
    case 'kmz':
      return {
        filename: `${base}.kmz`,
        mime: 'application/vnd.google-earth.kmz',
        content: await featuresToKmz(input, opts),
      }
    case 'kml':
      return {
        filename: `${base}.kml`,
        mime: 'application/vnd.google-earth.kml+xml',
        content: featuresToKml(input, opts),
      }
    case 'gpx':
      return { filename: `${base}.gpx`, mime: 'application/gpx+xml', content: featuresToGpx(input, opts) }
    case 'csv':
      return { filename: `${base}.csv`, mime: 'text/csv', content: featuresToCsv(input, opts) }
  }
}

// ---------- Sharing ----------
//
// In the crew app's store build (rebuild plan §0) files go to the phone's own
// share sheet through Capacitor's Filesystem and Share plugins, so AirDrop,
// Quick Share and "Open in Avenza Maps" work there; Android's web view has no
// Web Share at all. The plugins are reached through window.Capacitor (the
// crew app loads its /capacitor.js before this page's scripts): there is no
// Capacitor package in this app. Everywhere else, the Web Share API.

/** Each share's copy lives in Cache `shared/maps-<id>/`, removed once the
 * share ends. The crew app clears Cache `shared/` as well when it starts and
 * when someone signs out, so nobody's files wait there for the next person. */
const SHARE_DIR = 'shared'
/** After a completed share the copy stays this long: on Android the app it
 * went to gets a link to the file and may read it after the person is back. */
const SHARE_COPY_KEEP_MS = 2 * 60 * 1000
/** Bytes per bridge call. A multiple of 3, so each piece is whole base64;
 * pieces keep a large map original from becoming one huge string. */
const SHARE_CHUNK = 3 * 1024 * 1024

interface FilesystemPlugin {
  writeFile(o: { path: string; data: string; directory: 'CACHE'; recursive?: boolean }): Promise<{ uri: string }>
  appendFile(o: { path: string; data: string; directory: 'CACHE' }): Promise<void>
  rmdir(o: { path: string; directory: 'CACHE'; recursive?: boolean }): Promise<void>
}
interface SharePlugin {
  share(o: { title?: string; files?: string[] }): Promise<unknown>
}
interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  isPluginAvailable?: (name: string) => boolean
  registerPlugin?: (name: string) => unknown
  Plugins?: Record<string, unknown>
}

/** A Capacitor plugin by name, in the store app only (null on the website, or
 * when the app doesn't include it). Same lookup as the crew app's own. */
function nativePlugin<T>(name: string): T | null {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor
  try {
    if (!cap?.isNativePlatform?.()) return null
    const known = cap.Plugins?.[name]
    if (known) return known as T
    if (cap.isPluginAvailable && !cap.isPluginAvailable(name)) return null
    return (cap.registerPlugin?.(name) as T | undefined) ?? null
  } catch {
    return null
  }
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('Couldn’t read the file'))
    reader.readAsDataURL(blob)
  })
}

function shareId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A name the share sheet and the phone's file system both take. */
function shareFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim().slice(0, 120) || 'Carmanah Maps file'
}

const isCancel = (err: unknown) => {
  const e = err as { name?: string; message?: string } | null
  return e?.name === 'AbortError' || /cancel/i.test(String(e?.message ?? err ?? ''))
}

/**
 * Share through the store app's share sheet: write the file to Cache with the
 * Filesystem plugin, hand its file:// URI to the Share plugin, then delete
 * the copy (at once if the share was cancelled or failed, a little later if
 * it went through). Null when this isn't the store app. Throws if the file
 * couldn't be written or shared.
 */
export async function shareNatively(file: File): Promise<'shared' | 'cancelled' | null> {
  const filesystem = nativePlugin<FilesystemPlugin>('Filesystem')
  const share = nativePlugin<SharePlugin>('Share')
  if (!filesystem || !share) return null

  const folder = `${SHARE_DIR}/maps-${shareId()}`
  const path = `${folder}/${shareFileName(file.name)}`
  let outcome: 'shared' | 'cancelled' | 'failed' = 'failed'
  try {
    let uri = ''
    let offset = 0
    do {
      const data = await blobBase64(file.slice(offset, offset + SHARE_CHUNK))
      if (offset === 0) {
        uri = (await filesystem.writeFile({ path, data, directory: 'CACHE', recursive: true })).uri
      } else {
        await filesystem.appendFile({ path, data, directory: 'CACHE' })
      }
      offset += SHARE_CHUNK
    } while (offset < file.size)
    try {
      await share.share({ title: file.name, files: [uri] })
      outcome = 'shared'
    } catch (err) {
      if (!isCancel(err)) throw err
      outcome = 'cancelled'
    }
    return outcome
  } finally {
    const remove = () =>
      filesystem.rmdir({ path: folder, directory: 'CACHE', recursive: true }).catch(() => {
        // already gone (the crew app cleared it), or never written
      })
    if (outcome === 'shared') setTimeout(remove, SHARE_COPY_KEEP_MS)
    else void remove()
  }
}

/** Share via the OS share sheet when available (AirDrop to Avenza on
 * iPhone), otherwise download. In the store app: its own share sheet. */
export async function shareOrDownload(
  filename: string,
  mime: string,
  content: string | Blob,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([content], filename, { type: mime })
  const native = await shareNatively(file)
  if (native) return native
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch {
      // fall through to download (user cancelled or share failed)
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return 'downloaded'
}
