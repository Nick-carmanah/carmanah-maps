/**
 * Builds synthetic GeoPDFs for the importer's regression tests.
 *
 * Everything is generated at test time from plain geometry, so no real field
 * map ever goes into this public repo and the tests never touch the network.
 *
 * Each map frame is a UTM data frame at a known scale, optionally rotated on
 * the page. It is drawn as simple shapes: a light fill, a black neatline, a big
 * black square in the frame's top-left corner and a smaller red square in its
 * top-right. If the map is ever drawn upside-down, mirrored or turned, the
 * squares end up in the wrong corners, which is easy to see.
 *
 * The georeferencing follows ISO 32000-2 §12.9. Each fixture picks how BBox,
 * LPTS and GPTS are written, to match what ArcGIS, GDAL and Acrobat really
 * produce. The true lat/lon of every frame corner is computed separately from
 * the same geometry and returned with the PDF bytes, so a test only has to
 * compare the importer's answer against it.
 */
import { PDFDocument, PDFName, PDFNumber, PDFString, rgb, type PDFObject } from 'pdf-lib'
import proj4 from 'proj4'

export type LonLat = [number, number]
export type CornerName = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft'
export const CORNER_NAMES: CornerName[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']

/** How a viewport's /BBox is written. */
export type BBoxStyle =
  /** [left top right bottom]: top edge first, as ArcGIS writes it. */
  | 'top-first'
  /** [xMin yMin xMax yMax]: the ordinary y-up order. */
  | 'y-up'

export interface FrameSpec {
  /** The map frame (neatline) on the page, in PDF points, y-up. */
  frame: { left: number; bottom: number; right: number; top: number }
  /** Ground position of the frame's centre. */
  centre: LonLat
  /** Scale denominator: 20000 means 1:20,000. */
  scale: number
  /**
   * Data-frame rotation in degrees, counter-clockwise: the top of the page
   * points this far west of grid north. 180 means south is up. Default 0.
   */
  rotationDeg?: number
  /** Default 'top-first', like ArcGIS. */
  bbox?: BBoxStyle
  /**
   * Control points as (u, v) fractions of the BBox *as written*, so (0, 0)
   * is (B0, B1). Default: the four frame corners in ArcGIS's order (SW, NW,
   * NE, SE). GPTS are written for exactly these points.
   */
  lpts?: [number, number][]
  /** false leaves LPTS out, so a reader has to use Bounds. Default true. */
  writeLpts?: boolean
  /** The viewport dict sits inline in /VP (ArcGIS, default) or is its own object. */
  viewport?: 'inline' | 'indirect'
  /**
   * The GCS (projection) dict is its own object, written just before the
   * Measure as ArcGIS does (default), or sits inline in the Measure.
   */
  gcs?: 'indirect' | 'inline'
}

export interface PageSpec {
  /** [width, height] in points. */
  size: [number, number]
  /** Map frames on this page. None makes a plain page, e.g. a legend sheet. */
  frames: FrameSpec[]
}

/** What a correct importer should report for one frame. */
export interface TrueRegion {
  pageIndex: number
  /** The frame in PDF points: [xMin, yMin, xMax, yMax], y-up. */
  bboxPt: [number, number, number, number]
  pageSizePt: [number, number]
  /** True [lon, lat] of each frame corner as it sits on the page. */
  corners: Record<CornerName, LonLat>
}

export interface GeoPdfFixture {
  bytes: Uint8Array
  regions: TrueRegion[]
}

/** (u, v) of a frame corner, as a fraction of a BBox written in `style`. */
export function cornerUV(corner: CornerName, style: BBoxStyle): [number, number] {
  const u = corner === 'topLeft' || corner === 'bottomLeft' ? 0 : 1
  const isTop = corner === 'topLeft' || corner === 'topRight'
  // top-first: B1 is the top edge, so v = 0 is the top. y-up: v = 0 is the bottom.
  const v = style === 'top-first' ? (isTop ? 0 : 1) : isTop ? 1 : 0
  return [u, v]
}

/** The four frame corners in the order ArcGIS writes them: SW, NW, NE, SE. */
export function arcgisCornerOrder(style: BBoxStyle): [number, number][] {
  return (['bottomLeft', 'topLeft', 'topRight', 'bottomRight'] as const).map((c) => cornerUV(c, style))
}

const utmZone = (lon: number) => Math.floor((lon + 180) / 6) + 1
const utmProj = (zone: number) => `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`
const utmWkt = (zone: number) =>
  `PROJCS["WGS 84 / UTM zone ${zone}N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],` +
  `PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],` +
  `PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",${6 * zone - 183}],PARAMETER["scale_factor",0.9996],` +
  `PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1]]`

/** Page point (PDF points) → true [lon, lat], for one frame's geometry. */
function frameProjection(spec: FrameSpec): (x: number, y: number) => LonLat {
  const zone = utmZone(spec.centre[0])
  const utm = utmProj(zone)
  const [cE, cN] = proj4('EPSG:4326', utm, spec.centre)
  const ptPerMetre = 72 / 0.0254 / spec.scale
  const cx = (spec.frame.left + spec.frame.right) / 2
  const cy = (spec.frame.bottom + spec.frame.top) / 2
  const t = ((spec.rotationDeg ?? 0) * Math.PI) / 180
  return (x, y) => {
    const dx = (x - cx) / ptPerMetre
    const dy = (y - cy) / ptPerMetre
    const e = cE + dx * Math.cos(t) - dy * Math.sin(t)
    const n = cN + dx * Math.sin(t) + dy * Math.cos(t)
    return proj4(utm, 'EPSG:4326', [e, n]) as LonLat
  }
}

/** Build a GeoPDF with the given pages and frames. */
export async function buildGeoPdf(
  pages: PageSpec[],
  opts: { useObjectStreams?: boolean } = {},
): Promise<GeoPdfFixture> {
  // updateMetadata: false keeps dates out, so the same spec gives the same bytes.
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setProducer('Carmanah Maps test fixture')
  const ctx = doc.context
  const nums = (a: number[]) => ctx.obj(a.map((v) => PDFNumber.of(+v.toFixed(10))))
  const regions: TrueRegion[] = []

  pages.forEach((pageSpec, pageIndex) => {
    const page = doc.addPage(pageSpec.size)
    const viewports: PDFObject[] = []

    for (const spec of pageSpec.frames) {
      const { left, bottom, right, top } = spec.frame
      const w = right - left
      const h = top - bottom

      // Drawing: fill, corner markers, neatline.
      page.drawRectangle({ x: left, y: bottom, width: w, height: h, color: rgb(0.92, 0.92, 0.88) })
      const s = 0.2 * Math.min(w, h)
      const m = 0.02 * Math.min(w, h)
      page.drawRectangle({ x: left + m, y: top - m - s, width: s, height: s, color: rgb(0, 0, 0) })
      page.drawRectangle({ x: right - m - s / 2, y: top - m - s / 2, width: s / 2, height: s / 2, color: rgb(1, 0, 0) })
      page.drawRectangle({ x: left, y: bottom, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 1 })

      // Georeferencing.
      const style = spec.bbox ?? 'top-first'
      const bbox = style === 'top-first' ? [left, top, right, bottom] : [left, bottom, right, top]
      const bounds = arcgisCornerOrder(style)
      const writeLpts = spec.writeLpts ?? true
      // Without LPTS, a reader pairs GPTS with Bounds, so they must describe the same points.
      const lpts = writeLpts ? (spec.lpts ?? bounds) : bounds
      const toLonLat = frameProjection(spec)
      const gpts = lpts.flatMap(([u, v]) => {
        const [lon, lat] = toLonLat(bbox[0] + u * (bbox[2] - bbox[0]), bbox[1] + v * (bbox[3] - bbox[1]))
        return [lat, lon] // GPTS are (lat, lon)
      })
      const zone = utmZone(spec.centre[0])
      const gcs = ctx.obj({ Type: 'PROJCS', EPSG: 32600 + zone, WKT: PDFString.of(utmWkt(zone)) })
      const measure = ctx.obj({
        Type: 'Measure',
        Subtype: 'GEO',
        Bounds: nums(bounds.flat()),
        GPTS: nums(gpts),
        ...(writeLpts ? { LPTS: nums(lpts.flat()) } : {}),
        GCS: spec.gcs === 'inline' ? gcs : ctx.register(gcs),
        PDU: ctx.obj([PDFName.of('M'), PDFName.of('SQM'), PDFName.of('DEG')]),
      })
      const viewport = ctx.obj({
        Type: 'Viewport',
        Name: PDFString.of('Layers'),
        BBox: nums(bbox),
        Measure: ctx.register(measure),
      })
      viewports.push(spec.viewport === 'indirect' ? ctx.register(viewport) : viewport)

      regions.push({
        pageIndex,
        bboxPt: [left, bottom, right, top],
        pageSizePt: pageSpec.size,
        corners: {
          topLeft: toLonLat(left, top),
          topRight: toLonLat(right, top),
          bottomRight: toLonLat(right, bottom),
          bottomLeft: toLonLat(left, bottom),
        },
      })
    }
    if (viewports.length) page.node.set(PDFName.of('VP'), ctx.obj(viewports))
  })

  const bytes = await doc.save({ useObjectStreams: opts.useObjectStreams ?? false })
  return { bytes, regions }
}

/**
 * Re-save a PDF the way Acrobat's "Save As" tends to: every object rewritten,
 * and the small ones packed into compressed object streams, so none of the
 * georeferencing is readable as plain text any more.
 */
export async function resaveWithObjectStreams(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  return doc.save({ useObjectStreams: true })
}

// ---- Ready-made layouts ------------------------------------------------------

/** 11x17 landscape, in points. */
export const TABLOID_LANDSCAPE: [number, number] = [1224, 792]
/** 8.5x11 portrait, in points. */
export const LETTER_PORTRAIT: [number, number] = [612, 792]

/**
 * The standard field map: Victoria, BC, UTM 10N, 1:20,000 on 11x17
 * landscape, the same layout as the hand-check test map.
 */
export const FIELD_MAP: FrameSpec = {
  frame: { left: 36, bottom: 104, right: 1188, top: 744 },
  centre: [-123.372, 48.4235],
  scale: 20000,
}
