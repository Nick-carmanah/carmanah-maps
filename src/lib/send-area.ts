import type { Position } from 'geojson'
import { namingProfile } from './naming'
import { shareNatively } from './export'
import { getUnitSettings } from './units'
import {
  buildGeoPdf,
  pageLayout,
  pixelRatioFor,
  type Dpi,
  type MapArea,
  type Orientation,
  type PageSizeId,
} from './geopdf-write'
import { renderArea, type PrintLayers, type TileCheck } from '../map/print-render'

/**
 * "Send this area as a map": the glue between the sheet (SendAreaSheet), the
 * hidden-map renderer (print-render) and the PDF writer (geopdf-write), plus
 * the share step.
 */

/**
 * Why satellite isn't offered here. Esri's terms for World Imagery (the
 * app's satellite layer) allow it offline only inside Esri software, through
 * Esri content packages, and forbid redistributing its tiles, so we can't
 * put it in a file that's built from cached tiles and passed to other people.
 * (Esri, "Frequently asked questions about items owned by Esri in ArcGIS
 * Online", April 2025; World Imagery item: "not intended to be used to
 * export tiles for offline".)
 */
export const SATELLITE_NOTE =
  "Satellite isn't available for shared maps: Esri's terms only allow its imagery offline inside Esri's own apps, and don't allow passing it on. This map uses the streets basemap with hillshade."

/** Data credits printed on every map. */
export function attributionLines(layers: PrintLayers): string[] {
  const lines = [
    'Map data © OpenStreetMap contributors (ODbL). Tiles: OpenFreeMap. Map style © OpenMapTiles (CC BY 4.0).',
    'Terrain: Mapzen Terrain Tiles on AWS. SRTM and GMTED2010 courtesy of the U.S. Geological Survey; ETOPO1: U.S. National Oceanic and Atmospheric Administration; Canada terrain data contains information licensed under the Open Government Licence – Canada; and other sources.',
  ]
  if (layers.liveFires) {
    const asOf = new Date(layers.liveFires.fetchedAt)
    lines.push(
      `Fire locations${layers.liveFires.perimeters ? ' and perimeters' : ''}: BC Wildfire Service, as of ${asOf.toISOString().slice(0, 16).replace('T', ' ')} UTC (Open Government Licence – British Columbia).`,
    )
  }
  return lines
}

/** "2026-11-18" in local time. */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Fire number, call sign and date ("K61067 2P14 2026-11-18"): from the crew
 * app's hand-off, else this app's profile (namingProfile). No fire number:
 * "Carmanah Maps" instead.
 */
export function defaultTitle(now = new Date()): string {
  const { fireNumber, callsign } = namingProfile()
  return [fireNumber || 'Carmanah Maps', callsign, localDate(now)].filter(Boolean).join(' ')
}

/** A file name Files, AirDrop and Avenza all accept; Avenza names the map after it. */
export function fileNameFor(title: string): string {
  const base = title
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${base || 'Carmanah Maps'}.pdf`
}

export interface AreaMapOptions {
  title: string
  size: PageSizeId
  orientation: Orientation
  dpi: Dpi
  area: MapArea
  grid: boolean
  layers: PrintLayers
  tiles: TileCheck
  signal?: AbortSignal
  onProgress?: (message: string) => void
  /** Test only: red crosshairs at known coordinates. */
  checkpoints?: { label: string; position: Position }[]
}

export interface AreaMap {
  file: File
  bytes: number
  ms: number
  pieces: number
  failedTiles: number
  incomplete: boolean
}

export async function createAreaMap(options: AreaMapOptions): Promise<AreaMap> {
  const started = performance.now()
  const layout = pageLayout(options.size, options.orientation)
  const generatedAt = new Date()
  const report = options.onProgress ?? (() => {})
  report('Drawing the map…')
  const rendered = await renderArea({
    area: options.area,
    pixelRatio: pixelRatioFor(options.dpi),
    layers: options.layers,
    tiles: options.tiles,
    // Lossless for the streets basemap's flat colours and text. JPEG is for
    // photo-like imagery, which this tool doesn't draw (no satellite).
    format: 'flate-rgb',
    signal: options.signal,
    onProgress: (done, total) =>
      report(total > 1 ? `Drawing the map, part ${Math.min(done + 1, total)} of ${total}…` : 'Drawing the map…'),
  })
  options.signal?.throwIfAborted()
  report('Building the PDF…')
  const pdf = await buildGeoPdf({
    title: options.title,
    layout,
    area: options.area,
    pieces: rendered.pieces,
    grid: options.grid,
    attribution: attributionLines(options.layers),
    generatedAt,
    units: { distance: getUnitSettings().distance, coords: getUnitSettings().coords },
    checkpoints: options.checkpoints,
  })
  const file = new File([pdf as Uint8Array<ArrayBuffer>], fileNameFor(options.title), {
    type: 'application/pdf',
    lastModified: generatedAt.getTime(),
  })
  return {
    file,
    bytes: pdf.byteLength,
    ms: Math.round(performance.now() - started),
    pieces: rendered.pieces.length,
    failedTiles: rendered.failedTiles,
    incomplete: rendered.incomplete,
  }
}

// ---- Sharing --------------------------------------------------------------------

function isCancel(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null
  return e?.name === 'AbortError' || /cancel/i.test(e?.message ?? '')
}

/**
 * Hand the file to the phone's share sheet (AirDrop, Quick Share, "Open in
 * Avenza"). In the crew app that's its own share sheet (shareNatively in
 * src/lib/export.ts); on the website it's the Web Share API, which must be
 * called from a tap: browsers only allow sharing during one.
 */
export async function shareMapFile(file: File): Promise<'shared' | 'cancelled' | 'unsupported'> {
  const native = await shareNatively(file)
  if (native) return native
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name })
      return 'shared'
    } catch (err) {
      if (isCancel(err)) return 'cancelled'
      throw err
    }
  }
  return 'unsupported'
}

/** Save the file the old way (Files on iPhone, Downloads elsewhere). */
export function downloadMapFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
