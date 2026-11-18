import type { Position } from 'geojson'
import { zlibSync } from 'fflate'
import { formatCoord, fromUtm, toUtm, type CoordFormat } from './coords'
import { M_PER_CHAIN, M_PER_FT, M_PER_MI, M_PER_NM, type DistanceUnit } from './units'

/**
 * "Send this area as a map": writes a georeferenced PDF (ISO 32000-2 §12.9)
 * of a map area, laid out like a printed field map, for Avenza Maps and any
 * other GeoPDF reader (our own importer included).
 *
 * The georeferencing is written the way ArcGIS writes it, which is what
 * Avenza is known to read: one /VP viewport on the page whose BBox is written
 * top edge first, LPTS as fractions of that BBox as written, GPTS as
 * (lat, lon) pairs, and a /Measure /GEO whose GCS is a PROJCS with WKT. The
 * map image is Web Mercator (EPSG:3857, what MapLibre draws), and the GCS
 * says so, so readers interpolate between the corner points in the same
 * projection the image is in.
 *
 * Everything here is plain maths plus pdf-lib (loaded on demand); the map
 * image itself comes from src/map/print-render.ts.
 */

// ---- Page layout -----------------------------------------------------------

export type PageSizeId = 'letter' | 'legal' | 'tabloid'
export type Orientation = 'portrait' | 'landscape'
export type Dpi = 150 | 300

/** Paper sizes in PDF points (1/72 in), portrait. */
export const PAGE_SIZES: Record<PageSizeId, { label: string; w: number; h: number }> = {
  letter: { label: 'Letter', w: 612, h: 792 },
  legal: { label: 'Legal', w: 612, h: 1008 },
  tabloid: { label: '11×17', w: 792, h: 1224 },
}

/**
 * The map is drawn at 96 map pixels per inch of paper, like a desktop
 * screen, so labels and line widths print at the size they have on screen
 * (a 12 px label is 9 pt). DPI only changes how many device pixels each map
 * pixel gets: 150 DPI → ×1.5625, 300 DPI → ×3.125.
 */
export const MAP_PX_PER_INCH = 96
const PT_PER_PX = 72 / MAP_PX_PER_INCH
/** Frame sizes are whole multiples of this many map pixels, so both DPIs land on whole device pixels. */
export const PX_STEP = 16

const MARGIN = 27 // 3/8 in: inside most printers' unprintable edge
const TITLE_H = 34
const EDGE_TB = 27 // above/below the frame: grid labels, then corner coordinates (two lines)
const EDGE_LR = 22 // left/right of the frame: northing labels
const FOOTER_H = 70

export interface PageLayout {
  size: PageSizeId
  orientation: Orientation
  pageW: number
  pageH: number
  /** Map frame in PDF user space: points, origin bottom-left, y up. */
  frame: { x: number; y: number; w: number; h: number }
  /** The same frame in map pixels (96 per inch). */
  framePx: { w: number; h: number }
}

export function pageLayout(size: PageSizeId, orientation: Orientation): PageLayout {
  const paper = PAGE_SIZES[size]
  const [pageW, pageH] = orientation === 'portrait' ? [paper.w, paper.h] : [paper.h, paper.w]
  const left = MARGIN + EDGE_LR
  const right = pageW - MARGIN - EDGE_LR
  const top = pageH - MARGIN - TITLE_H - EDGE_TB
  const bottom = MARGIN + FOOTER_H + EDGE_TB
  const snap = (pt: number) => Math.floor(pt / PT_PER_PX / PX_STEP) * PX_STEP
  const framePx = { w: snap(right - left), h: snap(top - bottom) }
  const w = framePx.w * PT_PER_PX
  const h = framePx.h * PT_PER_PX
  return {
    size,
    orientation,
    pageW,
    pageH,
    frame: { x: left + (right - left - w) / 2, y: bottom + (top - bottom - h) / 2, w, h },
    framePx,
  }
}

/** Device pixels per map pixel at a DPI. */
export function pixelRatioFor(dpi: Dpi): number {
  return dpi / MAP_PX_PER_INCH
}

// ---- Web Mercator ----------------------------------------------------------

/**
 * The area on the page, in MapLibre's world pixels: the whole Web Mercator
 * world is 512 · 2^zoom map pixels square. The frame's top-left corner sits
 * on whole pixels, so raster layers (hillshade) aren't shifted by MapLibre's
 * pixel snapping.
 */
export interface MapArea {
  zoom: number
  x0: number
  y0: number
  /** Frame size in map pixels. */
  w: number
  h: number
}

const EARTH_RADIUS = 6378137

export function worldSize(zoom: number): number {
  return 512 * 2 ** zoom
}

/** Same formulas as MapLibre's MercatorCoordinate. */
export function lngLatToWorld([lng, lat]: Position, zoom: number): [number, number] {
  const s = worldSize(zoom)
  const x = (180 + lng) / 360
  const y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
  return [x * s, y * s]
}

export function worldToLngLat(x: number, y: number, zoom: number): Position {
  const s = worldSize(zoom)
  const lng = (x / s) * 360 - 180
  const y2 = 180 - (y / s) * 360
  const lat = (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90
  return [lng, lat]
}

/** The area whose frame is centred on `center` at `zoom`. */
export function areaAt(center: Position, zoom: number, framePx: { w: number; h: number }): MapArea {
  const [cx, cy] = lngLatToWorld(center, zoom)
  return {
    zoom,
    x0: Math.round(cx - framePx.w / 2),
    y0: Math.round(cy - framePx.h / 2),
    w: framePx.w,
    h: framePx.h,
  }
}

/** [lng, lat] at a point of the frame, in map pixels from its top-left. */
export function framePointToLngLat(area: MapArea, fx: number, fy: number): Position {
  return worldToLngLat(area.x0 + fx, area.y0 + fy, area.zoom)
}

export function lngLatToFramePoint(area: MapArea, pos: Position): [number, number] {
  const [x, y] = lngLatToWorld(pos, area.zoom)
  return [x - area.x0, y - area.y0]
}

export function areaCorners(area: MapArea): { nw: Position; ne: Position; se: Position; sw: Position } {
  return {
    nw: framePointToLngLat(area, 0, 0),
    ne: framePointToLngLat(area, area.w, 0),
    se: framePointToLngLat(area, area.w, area.h),
    sw: framePointToLngLat(area, 0, area.h),
  }
}

/** Ground metres per map pixel at the frame's centre (Web Mercator scale varies with latitude). */
export function metresPerPx(area: MapArea): number {
  const [, lat] = framePointToLngLat(area, area.w / 2, area.h / 2)
  return (2 * Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180)) / worldSize(area.zoom)
}

/** Paper scale at the frame's centre when printed at full size, e.g. 24000 for 1:24,000. */
export function scaleDenominator(area: MapArea): number {
  return metresPerPx(area) / (0.0254 / MAP_PX_PER_INCH)
}

/** Ground size of the frame in metres, measured across its centre. */
export function groundSizeM(area: MapArea): { w: number; h: number } {
  const m = metresPerPx(area)
  return { w: area.w * m, h: area.h * m }
}

// ---- UTM grid --------------------------------------------------------------

export interface UtmGrid {
  zone: number
  band: string
  /** Metres between lines: 1 km, or 10 km for big areas (as the app's grid). */
  spacing: number
  /** Polylines in frame pixels (y down), not clipped to the frame. */
  lines: [number, number][][]
  /** Where lines cross the frame edges: `at` is map pixels along that edge. */
  labels: { edge: 'top' | 'bottom' | 'left' | 'right'; at: number; value: number }[]
  /** Grid north's angle from true north at the frame centre, degrees; positive = east. */
  convergenceDeg: number
}

/** The UTM grid over an area, in the zone of its centre, or null when the area is too big for one. */
export function utmGrid(area: MapArea, maxLines = 40): UtmGrid | null {
  const [clng, clat] = framePointToLngLat(area, area.w / 2, area.h / 2)
  const centre = toUtm(clat, clng)
  if (!centre) return null
  const { zone, band } = centre
  const utmAt = (fx: number, fy: number) => {
    const [lng, lat] = framePointToLngLat(area, fx, fy)
    return toUtm(lat, lng, zone)
  }

  // Sample the frame's edges: their UTM values give both the grid's extent
  // and where each line crosses the edge.
  const SAMPLES = 64
  const edges = {
    top: { pt: (t: number) => [t * area.w, 0], axis: 'easting', len: area.w },
    bottom: { pt: (t: number) => [t * area.w, area.h], axis: 'easting', len: area.w },
    left: { pt: (t: number) => [0, t * area.h], axis: 'northing', len: area.h },
    right: { pt: (t: number) => [area.w, t * area.h], axis: 'northing', len: area.h },
  } as const
  const samples: Record<keyof typeof edges, { at: number; v: number }[]> = {
    top: [],
    bottom: [],
    left: [],
    right: [],
  }
  let minE = Infinity
  let maxE = -Infinity
  let minN = Infinity
  let maxN = -Infinity
  for (const [name, edge] of Object.entries(edges) as [keyof typeof edges, (typeof edges)[keyof typeof edges]][]) {
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES
      const [fx, fy] = edge.pt(t)
      const u = utmAt(fx, fy)
      if (!u) return null
      minE = Math.min(minE, u.easting)
      maxE = Math.max(maxE, u.easting)
      minN = Math.min(minN, u.northing)
      maxN = Math.max(maxN, u.northing)
      samples[name].push({ at: t * edge.len, v: edge.axis === 'easting' ? u.easting : u.northing })
    }
  }

  const longest = Math.max(maxE - minE, maxN - minN)
  const spacing = [1000, 10000].find((s) => longest / s <= maxLines)
  if (!spacing) return null

  const toFrame = (e: number, n: number): [number, number] =>
    lngLatToFramePoint(area, fromUtm({ zone, band, easting: e, northing: n }))
  const lines: [number, number][][] = []
  const e0 = Math.floor(minE / spacing) * spacing
  const n0 = Math.floor(minN / spacing) * spacing
  const STEPS = 48
  for (let e = e0; e <= maxE + spacing; e += spacing) {
    const line: [number, number][] = []
    for (let i = 0; i <= STEPS; i++) line.push(toFrame(e, minN - spacing + ((maxN - minN + 2 * spacing) * i) / STEPS))
    lines.push(line)
  }
  for (let n = n0; n <= maxN + spacing; n += spacing) {
    const line: [number, number][] = []
    for (let i = 0; i <= STEPS; i++) line.push(toFrame(minE - spacing + ((maxE - minE + 2 * spacing) * i) / STEPS, n))
    lines.push(line)
  }

  const labels: UtmGrid['labels'] = []
  for (const name of Object.keys(samples) as (keyof typeof edges)[]) {
    const s = samples[name]
    for (let i = 0; i + 1 < s.length; i++) {
      const [a, b] = [s[i], s[i + 1]]
      const lo = Math.min(a.v, b.v)
      const hi = Math.max(a.v, b.v)
      for (let g = Math.ceil(lo / spacing) * spacing; g <= hi; g += spacing) {
        // A value exactly on a sample point would be found twice; keep the first.
        if (g === b.v && i + 2 < s.length) continue
        const t = b.v === a.v ? 0 : (g - a.v) / (b.v - a.v)
        labels.push({ edge: name, at: a.at + t * (b.at - a.at), value: g })
      }
    }
  }

  // Convergence: which way true north points on the grid at the centre.
  const north = toUtm(clat + 0.01, clng, zone)!
  const convergenceDeg = -(Math.atan2(north.easting - centre.easting, north.northing - centre.northing) * 180) / Math.PI

  return { zone, band, spacing, lines, labels, convergenceDeg }
}

/**
 * A grid line's label in km, split so the digits a crew reads off the app's
 * grid squares (the "1265"-style references) can be printed bold.
 */
export function gridLabelParts(value: number, spacing: number): [string, string, string] {
  const km = String(Math.round(value / 1000))
  if (spacing >= 10000) return [km.slice(0, -2), km.slice(-2, -1), km.slice(-1)]
  return [km.slice(0, -2), km.slice(-2), '']
}

// ---- Images ----------------------------------------------------------------

/** One piece of the map image, placed in frame pixels (it may overlap its right/bottom neighbours). */
export type MapImagePiece = { x: number; y: number; w: number; h: number } & (
  | { format: 'jpeg'; bytes: Uint8Array }
  | { format: 'flate-rgb'; bytes: Uint8Array; width: number; height: number }
)

/**
 * Lossless image data for a PDF: RGB rows with a PNG filter byte each, then
 * zlib, i.e. exactly what a PNG holds, for a FlateDecode stream with
 * /Predictor 15. Doing it here (fflate) avoids pdf-lib's embedPng, which
 * decodes and re-compresses a PNG in plain JS.
 */
export function encodeRgbFlate(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const rowLen = width * 3
  const out = new Uint8Array((rowLen + 1) * height)
  let prev = new Uint8Array(rowLen)
  let cur = new Uint8Array(rowLen)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0, s = y * width * 4, d = 0; x < width; x++, s += 4, d += 3) {
      cur[d] = rgba[s]
      cur[d + 1] = rgba[s + 1]
      cur[d + 2] = rgba[s + 2]
    }
    // libpng's heuristic: pick the filter whose output has the smallest sum
    // of absolute (signed) values.
    const sums = [0, 0, 0, 0, 0]
    for (let i = 0; i < rowLen; i++) {
      const a = i >= 3 ? cur[i - 3] : 0
      const b = prev[i]
      const c = i >= 3 ? prev[i - 3] : 0
      const v = cur[i]
      const signed = (n: number) => ((n & 0xff) < 128 ? n & 0xff : 256 - (n & 0xff))
      sums[0] += signed(v)
      sums[1] += signed(v - a)
      sums[2] += signed(v - b)
      sums[3] += signed(v - ((a + b) >> 1))
      sums[4] += signed(v - paeth(a, b, c))
    }
    let filter = 0
    for (let f = 1; f < 5; f++) if (sums[f] < sums[filter]) filter = f
    const o = y * (rowLen + 1)
    out[o] = filter
    for (let i = 0; i < rowLen; i++) {
      const a = i >= 3 ? cur[i - 3] : 0
      const b = prev[i]
      const c = i >= 3 ? prev[i - 3] : 0
      const v = cur[i]
      out[o + 1 + i] =
        filter === 0 ? v : filter === 1 ? v - a : filter === 2 ? v - b : filter === 3 ? v - ((a + b) >> 1) : v - paeth(a, b, c)
    }
    ;[prev, cur] = [cur, prev]
  }
  return zlibSync(out, { level: 6 })
}

// ---- The PDF ---------------------------------------------------------------

export interface GeoPdfInput {
  title: string
  layout: PageLayout
  area: MapArea
  pieces: MapImagePiece[]
  /** Draw the UTM grid with edge labels. */
  grid: boolean
  /** Data credits, one line each (wrapped to fit). */
  attribution: string[]
  generatedAt: Date
  /**
   * The user's unit settings (src/lib/units.ts): the first scale bar is in
   * `distance` (the second is metric, or imperial when that's metric), and
   * corner coordinates are in `coords`. Default: metric, DDM.
   */
  units?: { distance: DistanceUnit; coords: CoordFormat }
  /** Test only: red crosshairs with their true coordinates, drawn as vectors. */
  checkpoints?: { label: string; position: Position }[]
}

const COORD_NAMES: Record<CoordFormat, string> = {
  dd: 'decimal degrees',
  ddm: 'degrees and decimal minutes',
  dms: 'degrees, minutes and seconds',
  utm: 'UTM',
  mgrs: 'MGRS',
  bcalbers: 'BC Albers (EPSG:3005)',
}

/** A corner coordinate split over two lines (latitude over longitude, or easting over northing). */
export function cornerLines(pos: Position, fmt: CoordFormat): [string, string] {
  const s = formatCoord(pos, fmt)
  if (fmt === 'dd') {
    const [lat, lng] = s.split(', ')
    return [lat, lng]
  }
  if (fmt === 'mgrs') {
    const m = /^(\d{1,2}[A-Z])([A-Z]{2})(\d*)$/.exec(s)
    if (!m) return [s, '']
    const half = m[3].length / 2
    return [`${m[1]} ${m[2]}`, `${m[3].slice(0, half)} ${m[3].slice(half)}`]
  }
  const parts = s.split(' ')
  if (parts.length < 2) return [s, '']
  const cut = parts.length - 1
  return [parts.slice(0, cut).join(' '), parts[cut]]
}

/** ArcGIS's own WKT for Web Mercator (EPSG:3857). */
export const WEB_MERCATOR_WKT =
  'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]'

const ink = { black: [0, 0, 0], grey: [0.35, 0.35, 0.35], grid: [0.12, 0.12, 0.12], red: [0.82, 0, 0] } as const

export async function buildGeoPdf(input: GeoPdfInput): Promise<Uint8Array> {
  const lib = await import('pdf-lib')
  const {
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFString,
    StandardFonts,
    rgb,
    pushGraphicsState,
    popGraphicsState,
    concatTransformationMatrix,
    drawObject,
    rectangle,
    clip,
    endPath,
    moveTo,
    lineTo,
    stroke,
    setLineWidth,
    setStrokingRgbColor,
    setLineJoin,
    setLineCap,
    LineJoinStyle,
    LineCapStyle,
  } = lib
  const { layout, area } = input
  const { frame } = layout
  if (area.w !== layout.framePx.w || area.h !== layout.framePx.h) throw new Error('area and page layout disagree')

  const doc = await PDFDocument.create()
  doc.setTitle(input.title)
  doc.setSubject('Georeferenced map (GeoPDF)')
  doc.setCreator('Carmanah Maps')
  doc.setProducer('Carmanah Maps')
  doc.setCreationDate(input.generatedAt)
  doc.setModificationDate(input.generatedAt)
  const page = doc.addPage([layout.pageW, layout.pageH])
  // Paper white, for renderers that would otherwise show the page transparent.
  page.drawRectangle({ x: 0, y: 0, width: layout.pageW, height: layout.pageH, color: rgb(1, 1, 1) })
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  type Font = typeof font
  // The standard PDF fonts only cover Latin-1 (WinAnsi); swap anything else.
  const safe = (f: Font, s: string) =>
    [...s.normalize('NFC')]
      .map((ch) => {
        try {
          f.encodeText(ch)
          return ch
        } catch {
          return '?'
        }
      })
      .join('')
  const colour = (c: readonly number[]) => rgb(c[0], c[1], c[2])
  const text = (s: string, x: number, y: number, size: number, f: Font = font, c: readonly number[] = ink.black) => {
    const t = safe(f, s)
    page.drawText(t, { x, y, size, font: f, color: colour(c) })
    return f.widthOfTextAtSize(t, size)
  }
  const width = (s: string, size: number, f: Font = font) => f.widthOfTextAtSize(safe(f, s), size)

  // Frame pixels → page points.
  const toPt = (fx: number, fy: number): [number, number] => [
    frame.x + fx * PT_PER_PX,
    frame.y + frame.h - fy * PT_PER_PX,
  ]

  // ---- Map image, clipped to the frame.
  page.pushOperators(pushGraphicsState(), rectangle(frame.x, frame.y, frame.w, frame.h), clip(), endPath())
  for (const piece of input.pieces) {
    let ref
    if (piece.format === 'jpeg') {
      ref = (await doc.embedJpg(piece.bytes)).ref
    } else {
      const stream = doc.context.stream(piece.bytes, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: piece.width,
        Height: piece.height,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: piece.width },
      })
      ref = doc.context.register(stream)
    }
    const name = page.node.newXObject('Map', ref)
    const [x, yTop] = toPt(piece.x, piece.y)
    const w = piece.w * PT_PER_PX
    const h = piece.h * PT_PER_PX
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, yTop - h), drawObject(name), popGraphicsState())
  }

  // ---- UTM grid lines (still clipped).
  const grid = input.grid ? utmGrid(area) : null
  if (grid) {
    page.pushOperators(
      setStrokingRgbColor(ink.grid[0], ink.grid[1], ink.grid[2]),
      setLineWidth(0.45),
      setLineJoin(LineJoinStyle.Round),
      setLineCap(LineCapStyle.Butt),
    )
    for (const line of grid.lines) {
      line.forEach(([fx, fy], i) => {
        const [x, y] = toPt(fx, fy)
        page.pushOperators(i ? lineTo(x, y) : moveTo(x, y))
      })
    }
    page.pushOperators(stroke())
  }

  // ---- Test checkpoints (still clipped).
  for (const cp of input.checkpoints ?? []) {
    const [x, y] = toPt(...lngLatToFramePoint(area, cp.position))
    page.pushOperators(
      setStrokingRgbColor(ink.red[0], ink.red[1], ink.red[2]),
      setLineWidth(1.2),
      moveTo(x - 9, y),
      lineTo(x + 9, y),
      moveTo(x, y - 9),
      lineTo(x, y + 9),
      stroke(),
    )
  }
  page.pushOperators(popGraphicsState())
  for (const cp of input.checkpoints ?? []) {
    const [x, y] = toPt(...lngLatToFramePoint(area, cp.position))
    const label = `${cp.label}: ${formatCoord(cp.position, 'ddm')}`
    page.drawRectangle({ x: x + 4, y: y + 3, width: width(label, 7, bold) + 4, height: 10, color: rgb(1, 1, 1), opacity: 0.85 })
    text(label, x + 6, y + 5.5, 7, bold, ink.red)
  }

  // ---- Neatline.
  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, borderColor: rgb(0, 0, 0), borderWidth: 1.2 })

  // ---- Corner coordinates, in the user's format, on two lines at each
  // corner outside the frame, one line further out than the grid labels so
  // every grid line keeps its label.
  const units = input.units ?? { distance: 'metric', coords: 'ddm' }
  const corners = areaCorners(area)
  const CORNER_SIZE = 6.5
  const aboveY = frame.y + frame.h + 3.5 // grid label line next to the frame's top edge
  const belowY = frame.y - 3.5 - CORNER_SIZE // …and its bottom edge
  const LINE = CORNER_SIZE + 1.5
  for (const [pos, top, right] of [
    [corners.nw, true, false],
    [corners.ne, true, true],
    [corners.sw, false, false],
    [corners.se, false, true],
  ] as const) {
    const [first, second] = cornerLines(pos, units.coords)
    const lines = top
      ? [[first, aboveY + 2 * LINE], [second, aboveY + LINE]]
      : [[first, belowY - LINE], [second, belowY - 2 * LINE]]
    for (const [s, y] of lines as [string, number][]) {
      text(s, right ? frame.x + frame.w - width(s, CORNER_SIZE) : frame.x, y, CORNER_SIZE)
    }
  }

  // ---- Grid edge labels.
  if (grid) {
    const SIZE = 6.5
    const parts = (v: number) => gridLabelParts(v, grid.spacing)
    const partsWidth = (p: [string, string, string], size: number) =>
      width(p[0], size) + width(p[1], size + 1, bold) + width(p[2], size)
    const drawParts = (p: [string, string, string], x: number, y: number) => {
      x += text(p[0], x, y, SIZE)
      x += text(p[1], x, y, SIZE + 1, bold)
      text(p[2], x, y, SIZE)
    }
    for (const label of grid.labels) {
      const p = parts(label.value)
      const w = partsWidth(p, SIZE)
      if (label.edge === 'top' || label.edge === 'bottom') {
        const x = frame.x + label.at * PT_PER_PX - w / 2
        if (x < frame.x - 2 || x + w > frame.x + frame.w + 2) continue
        drawParts(p, x, label.edge === 'top' ? aboveY : belowY)
      } else {
        const y = frame.y + frame.h - label.at * PT_PER_PX - SIZE * 0.35
        if (y < frame.y + 2 || y > frame.y + frame.h - SIZE) continue
        drawParts(p, label.edge === 'left' ? frame.x - 3 - w : frame.x + frame.w + 3, y)
      }
    }
  }

  // ---- Title band.
  const scale = scaleDenominator(area)
  const paper = PAGE_SIZES[layout.size].label
  const titleY = layout.pageH - MARGIN - 15
  const titleSize = 15
  let title = safe(bold, input.title.trim() || 'Carmanah Maps')
  while (title.length > 1 && bold.widthOfTextAtSize(title, titleSize) > layout.pageW - 2 * MARGIN) title = title.slice(0, -2) + '…'
  text(title, MARGIN, titleY, titleSize, bold)
  const stamp = formatStamp(input.generatedAt)
  text(
    `Scale 1:${roundScale(scale).toLocaleString('en-US')} at the centre when printed on ${paper} ${layout.orientation} · WGS 84 / Web Mercator · ${stamp}`,
    MARGIN,
    titleY - 11,
    7,
    font,
    ink.grey,
  )

  // ---- Footer: scale bars, north arrow, notes and credits.
  const footerTop = MARGIN + FOOTER_H - 4
  const mPerPt = metresPerPx(area) / PT_PER_PX
  const barMax = Math.min(170, (layout.pageW - 2 * MARGIN) * 0.3)
  const drawBar = (y: number, unit: DistanceUnit) => {
    const bar = scaleBar(barMax * mPerPt, unit)
    const segPt = bar.metres / mPerPt / 4
    for (let i = 0; i < 4; i++) {
      page.drawRectangle({
        x: MARGIN + i * segPt,
        y,
        width: segPt,
        height: 4,
        color: i % 2 ? rgb(1, 1, 1) : rgb(0, 0, 0),
        borderColor: rgb(0, 0, 0),
        borderWidth: 0.5,
      })
    }
    const labels = [[0, '0'], [2, bar.half], [4, bar.full]] as const
    for (const [at, s] of labels) {
      const w = width(s, 6)
      text(s, Math.max(MARGIN, MARGIN + at * segPt - (at ? w / 2 : 0)), y + 6.5, 6)
    }
    text(bar.unit, MARGIN + 4 * segPt + 4, y - 0.5, 6)
  }
  drawBar(footerTop - 14, units.distance)
  drawBar(footerTop - 34, units.distance === 'metric' ? 'imperial' : 'metric')
  text(`1:${roundScale(scale).toLocaleString('en-US')} at full size`, MARGIN, footerTop - 47, 6.5, bold)

  // North arrow: Web Mercator keeps true north straight up everywhere.
  const ax = MARGIN + barMax + 46
  const ay = footerTop - 34
  page.drawSvgPath('M 0 0 L 7 22 L 0 17 L -7 22 Z', { x: ax, y: ay + 22, color: rgb(0, 0, 0) })
  text('N', ax - width('N', 9, bold) / 2, ay + 25, 9, bold)
  text('True north', ax - width('True north', 5.5) / 2, ay - 8, 5.5)
  if (grid) {
    const c = grid.convergenceDeg
    const s = `Grid north ${Math.abs(c).toFixed(1)}° ${c >= 0 ? 'E' : 'W'}`
    text(s, ax - width(s, 5.5) / 2, ay - 15, 5.5, font, ink.grey)
  }

  const notesX = ax + 40
  const notesW = layout.pageW - MARGIN - notesX
  const notes: [string, Font, readonly number[]][] = []
  if (grid) {
    const every = grid.spacing >= 10000 ? '10 km' : '1 km'
    notes.push([
      `UTM grid: zone ${grid.zone}${grid.band}, WGS 84, ${every} squares, labels in km. Grid reference = bold digits, easting first.`,
      font,
      ink.black,
    ])
  }
  if (input.grid && !grid) notes.push(['No UTM grid: this area is too big for a 10 km grid.', font, ink.black])
  notes.push([`Corner coordinates: ${COORD_NAMES[units.coords]}${units.coords === 'bcalbers' ? '' : ', WGS 84'}.`, font, ink.black])
  for (const line of input.attribution) notes.push([line, font, ink.grey])
  notes.push([`Generated by Carmanah Maps · ${stamp}`, bold, ink.black])
  const NOTE_SIZE = 5.6
  let ny = footerTop - 6
  for (const [line, f, c] of notes) {
    for (const wrapped of wrap(safe(f, line), (s) => f.widthOfTextAtSize(s, NOTE_SIZE), notesW)) {
      if (ny < MARGIN - 6) break
      text(wrapped, notesX, ny, NOTE_SIZE, f, c)
      ny -= NOTE_SIZE + 1.6
    }
  }

  // ---- Georeferencing (ISO 32000-2 §12.9), ArcGIS-style.
  const ctx = doc.context
  const nums = (values: number[]) => ctx.obj(values.map((v) => PDFNumber.of(+v.toFixed(10))))
  // BBox top edge first: [left, top, right, bottom].
  const bbox = [frame.x, frame.y + frame.h, frame.x + frame.w, frame.y]
  // LPTS are fractions of the BBox as written: (0,1) = left-bottom = SW,
  // (0,0) = NW, (1,0) = NE, (1,1) = SE. GPTS are (lat, lon) at those points.
  const lpts = [0, 1, 0, 0, 1, 0, 1, 1]
  const gpts = [corners.sw, corners.nw, corners.ne, corners.se].flatMap(([lng, lat]) => [lat, lng])
  const measure = ctx.obj({
    Type: 'Measure',
    Subtype: 'GEO',
    Bounds: nums(lpts),
    GPTS: nums(gpts),
    LPTS: nums(lpts),
    GCS: ctx.obj({ Type: 'PROJCS', EPSG: 3857, WKT: PDFString.of(WEB_MERCATOR_WKT) }),
    PDU: ctx.obj([PDFName.of('M'), PDFName.of('SQM'), PDFName.of('DEG')]),
  })
  const viewport = ctx.obj({
    Type: 'Viewport',
    Name: PDFString.of('Layers'),
    BBox: nums(bbox),
    Measure: ctx.register(measure),
  })
  page.node.set(PDFName.of('VP'), ctx.obj([ctx.register(viewport)]))

  return doc.save({ useObjectStreams: false })
}

/** A scale denominator to two significant figures: 9,994 → 10,000, 24,310 → 24,000. */
export function roundScale(n: number): number {
  const digits = Math.max(0, Math.floor(Math.log10(n)) - 1)
  return Math.round(n / 10 ** digits) * 10 ** digits
}

/** "2026-11-18 14:32" in local time. */
function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The longest round scale-bar length that fits, in a distance unit, with its labels. */
export function scaleBar(
  maxMetres: number,
  unit: DistanceUnit,
): { metres: number; half: string; full: string; unit: string } {
  const nice = (max: number) => {
    const p = 10 ** Math.floor(Math.log10(max))
    return [5, 2, 1].map((m) => m * p).find((v) => v <= max) ?? p
  }
  const fmt = (n: number) => String(+n.toFixed(3))
  const bar = (perUnit: number, label: string) => {
    const n = nice(maxMetres / perUnit)
    return { metres: n * perUnit, half: fmt(n / 2), full: fmt(n), unit: label }
  }
  switch (unit) {
    case 'imperial':
      return maxMetres / M_PER_FT >= 2640 ? bar(M_PER_MI, 'mi') : bar(M_PER_FT, 'ft')
    case 'nautical':
      return maxMetres / M_PER_NM >= 0.5 ? bar(M_PER_NM, 'NM') : bar(M_PER_FT, 'ft')
    case 'chains':
      return bar(M_PER_CHAIN, 'ch')
    default:
      return maxMetres >= 1000 ? bar(1000, 'km') : bar(1, 'm')
  }
}

function wrap(s: string, measure: (s: string) => number, maxW: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of s.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (line && measure(next) > maxW) {
      out.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) out.push(line)
  return out
}
