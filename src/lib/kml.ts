import { gpx, kml } from '@tmcw/togeojson'
import { unzipSync, strFromU8 } from 'fflate'
import type { FeatureCollection } from 'geojson'

export interface ParsedKml {
  name: string
  geojson: FeatureCollection
}

function parseKmlString(text: string, fallbackName: string): ParsedKml {
  const dom = new DOMParser().parseFromString(text, 'application/xml')
  const parseError = dom.querySelector('parsererror')
  if (parseError) {
    throw new Error('Not a valid KML file')
  }
  const geojson = kml(dom) as FeatureCollection
  if (!geojson.features.length) {
    throw new Error('KML contains no map features')
  }
  const docName =
    dom.querySelector('Document > name')?.textContent?.trim() ||
    dom.querySelector('kml > name')?.textContent?.trim()
  return { name: docName || fallbackName, geojson }
}

function parseKmz(buffer: ArrayBuffer, fallbackName: string): ParsedKml {
  const files = unzipSync(new Uint8Array(buffer))
  // KMZ convention: main document is doc.kml, but accept any .kml entry.
  const entry =
    files['doc.kml'] !== undefined
      ? 'doc.kml'
      : Object.keys(files).find((f) => f.toLowerCase().endsWith('.kml'))
  if (!entry) {
    throw new Error('KMZ archive contains no KML document')
  }
  return parseKmlString(strFromU8(files[entry]), fallbackName)
}

function parseGpxString(text: string, fallbackName: string): ParsedKml {
  const dom = new DOMParser().parseFromString(text, 'application/xml')
  if (dom.querySelector('parsererror')) {
    throw new Error('Not a valid GPX file')
  }
  const geojson = gpx(dom) as FeatureCollection
  if (!geojson.features.length) {
    throw new Error('GPX contains no map features')
  }
  return { name: fallbackName, geojson }
}

async function parseShapefile(buffer: ArrayBuffer, fallbackName: string): Promise<ParsedKml> {
  const { default: shp } = await import('shpjs')
  const parsed = await shp(buffer)
  // Zipped shapefiles can hold several layers — merge them into one overlay.
  const collections = Array.isArray(parsed) ? parsed : [parsed]
  const features = collections.flatMap((fc) => fc.features)
  if (!features.length) {
    throw new Error('Shapefile contains no map features')
  }
  return { name: fallbackName, geojson: { type: 'FeatureCollection', features } }
}

function stripExtension(filename: string): string {
  return filename.replace(/\.(kml|kmz|gpx|zip|shp)$/i, '')
}

/** Import any supported file: KML, KMZ, GPX, or (zipped) shapefile. */
export async function parseImportedFile(file: File): Promise<ParsedKml> {
  const fallbackName = stripExtension(file.name)
  const lower = file.name.toLowerCase()
  if (lower.endsWith('.kmz')) {
    return parseKmz(await file.arrayBuffer(), fallbackName)
  }
  if (lower.endsWith('.gpx')) {
    return parseGpxString(await file.text(), fallbackName)
  }
  if (lower.endsWith('.zip') || lower.endsWith('.shp')) {
    return parseShapefile(await file.arrayBuffer(), fallbackName)
  }
  return parseKmlString(await file.text(), fallbackName)
}

/** Fetch a KML/KMZ from a URL (e.g. decoded from a fire's QR code). */
export async function fetchKmlFromUrl(url: string): Promise<ParsedKml> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error(
      'Could not download from that link — the server may block in-app downloads. ' +
        'Download the file in your browser and use Import instead.',
    )
  }
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status})`)
  }
  const pathname = new URL(url, location.href).pathname
  const fallbackName = stripExtension(pathname.split('/').pop() || 'Imported map')
  const buffer = await response.arrayBuffer()
  // Zip magic bytes = KMZ; otherwise treat as KML text.
  const head = new Uint8Array(buffer.slice(0, 2))
  if (head[0] === 0x50 && head[1] === 0x4b) {
    return parseKmz(buffer, fallbackName)
  }
  return parseKmlString(new TextDecoder().decode(buffer), fallbackName)
}
