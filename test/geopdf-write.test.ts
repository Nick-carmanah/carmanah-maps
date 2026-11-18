/**
 * "Send this area as a map" writer → importer round trip.
 *
 * Writes GeoPDFs with src/lib/geopdf-write.ts (the PDF the share sheet hands
 * to Avenza) and reads them back with the app's own parser. Every frame
 * corner must land within 0.5 m of where the writer put it, the map frame
 * must come back as the page box it was drawn in, and the georeferencing
 * must be laid out the way ArcGIS writes it (what Avenza reads).
 *
 * The map image itself comes from a hidden MapLibre map in the browser and
 * isn't covered here; a tiny flat image stands in for it.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { parseGeoPdfRegions } from '../src/lib/geopdf'
import {
  areaAt,
  areaCorners,
  buildGeoPdf,
  cornerLines,
  encodeRgbFlate,
  framePointToLngLat,
  lngLatToWorld,
  pageLayout,
  scaleBar,
  utmGrid,
  type MapArea,
  type MapImagePiece,
  type Orientation,
  type PageLayout,
  type PageSizeId,
} from '../src/lib/geopdf-write'

const TOLERANCE_M = 0.5

function metresBetween([lon1, lat1]: number[], [lon2, lat2]: number[]): number {
  const rad = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}

/** MapLibre zoom for a paper scale (1:scale) at a latitude, 96 map px per inch. */
function zoomForScale(lat: number, scale: number): number {
  const mPerPx = (scale * 0.0254) / 96
  return Math.log2((2 * Math.PI * 6378137 * Math.cos((lat * Math.PI) / 180)) / (512 * mPerPx))
}

/** A flat grey stand-in for the rendered map, stretched over the whole frame. */
function flatPiece(area: MapArea): MapImagePiece {
  const w = 8
  const h = 8
  const rgba = new Uint8ClampedArray(w * h * 4).fill(200)
  return { x: 0, y: 0, w: area.w, h: area.h, format: 'flate-rgb', bytes: encodeRgbFlate(rgba, w, h), width: w, height: h }
}

async function writeMap(size: PageSizeId, orientation: Orientation, centre: [number, number], scale: number) {
  const layout = pageLayout(size, orientation)
  const area = areaAt(centre, zoomForScale(centre[1], scale), layout.framePx)
  const bytes = await buildGeoPdf({
    title: 'K61067 2026-11-18 — Tŝilhqot’in test 🔥',
    layout,
    area,
    pieces: [flatPiece(area)],
    grid: true,
    attribution: ['Map data © OpenStreetMap contributors (ODbL).'],
    generatedAt: new Date(2026, 10, 18, 14, 32),
  })
  return { layout, area, bytes }
}

const CASES: { name: string; size: PageSizeId; orientation: Orientation; centre: [number, number]; scale: number }[] = [
  { name: 'Letter portrait, Victoria, 1:20,000', size: 'letter', orientation: 'portrait', centre: [-123.372, 48.4235], scale: 20000 },
  { name: '11×17 landscape, Kamloops, 1:50,000', size: 'tabloid', orientation: 'landscape', centre: [-120.34, 50.67], scale: 50000 },
  { name: 'Legal landscape, Fort Nelson, 1:100,000', size: 'legal', orientation: 'landscape', centre: [-122.7, 58.8], scale: 100000 },
  { name: '11×17 portrait, near Prince George, 1:10,000', size: 'tabloid', orientation: 'portrait', centre: [-122.75, 53.92], scale: 10000 },
]

describe('send-area GeoPDF writer → parseGeoPdfRegions', () => {
  for (const c of CASES) {
    it(`${c.name}: corners come back within ${TOLERANCE_M} m`, async () => {
      const { layout, area, bytes } = await writeMap(c.size, c.orientation, c.centre, c.scale)
      const regions = await parseGeoPdfRegions(bytes)
      expect(regions).toHaveLength(1)
      const [r] = regions
      const truth = areaCorners(area)
      const off = {
        topLeft: metresBetween(r.corners.topLeft, truth.nw),
        topRight: metresBetween(r.corners.topRight, truth.ne),
        bottomRight: metresBetween(r.corners.bottomRight, truth.se),
        bottomLeft: metresBetween(r.corners.bottomLeft, truth.sw),
      }
      for (const [corner, m] of Object.entries(off)) {
        expect(m, `${corner} is ${m.toFixed(3)} m off`).toBeLessThan(TOLERANCE_M)
      }
      // The importer crops the page to this box, top edge at the top.
      const { frame } = layout
      expect(r.bboxPt).toEqual([frame.x, frame.y, frame.x + frame.w, frame.y + frame.h].map((v) => expect.closeTo(v, 6)))
      expect(r.pageSizePt).toEqual([layout.pageW, layout.pageH])
      expect(r.pageIndex).toBe(0)
    })
  }

  it('the frame centre, interpolated in Web Mercator from the corners read back, is where the writer drew it', async () => {
    // The app (MapLibre image source) and the GCS we declare (EPSG:3857) both
    // interpolate in Web Mercator between the corners; the image is drawn in
    // Web Mercator, so interior points must line up too, not just corners.
    const { area, bytes } = await writeMap('tabloid', 'landscape', [-120.34, 50.67], 250000)
    const [r] = await parseGeoPdfRegions(bytes)
    const [x0, y0] = lngLatToWorld(r.corners.topLeft, 0)
    const [x1, y1] = lngLatToWorld(r.corners.bottomRight, 0)
    for (const [u, v] of [[0.5, 0.5], [0.25, 0.8], [0.9, 0.1]]) {
      const truth = framePointToLngLat(area, u * area.w, v * area.h)
      const [tx, ty] = lngLatToWorld(truth, 0)
      expect((tx - x0) / (x1 - x0)).toBeCloseTo(u, 9)
      expect((ty - y0) / (y1 - y0)).toBeCloseTo(v, 9)
    }
  })

  it('writes the georeferencing the way ArcGIS does', async () => {
    const { layout, area, bytes } = await writeMap('letter', 'portrait', [-123.372, 48.4235], 20000)
    const doc = await PDFDocument.load(bytes)
    const page = doc.getPage(0)
    const vp = page.node.lookup(PDFName.of('VP'), PDFArray)
    expect(vp.size()).toBe(1)
    const viewport = vp.lookup(0, PDFDict)
    const nums = (a: PDFArray) => a.asArray().map((n) => (n as PDFNumber).asNumber())
    // BBox top edge first: [left, top, right, bottom].
    const bbox = nums(viewport.lookup(PDFName.of('BBox'), PDFArray))
    expect(bbox[1]).toBeGreaterThan(bbox[3])
    expect(bbox[0]).toBeCloseTo(layout.frame.x, 6)
    expect(bbox[1]).toBeCloseTo(layout.frame.y + layout.frame.h, 6)
    const measure = viewport.lookup(PDFName.of('Measure'), PDFDict)
    expect(measure.get(PDFName.of('Subtype'))).toBe(PDFName.of('GEO'))
    expect(nums(measure.lookup(PDFName.of('LPTS'), PDFArray))).toEqual([0, 1, 0, 0, 1, 0, 1, 1])
    // GPTS are (lat, lon) at SW, NW, NE, SE.
    const gpts = nums(measure.lookup(PDFName.of('GPTS'), PDFArray))
    const { sw, nw, ne, se } = areaCorners(area)
    const expected = [sw, nw, ne, se].flatMap(([lon, lat]) => [lat, lon])
    gpts.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 9))
    const gcs = measure.lookup(PDFName.of('GCS'), PDFDict)
    expect(gcs.get(PDFName.of('Type'))).toBe(PDFName.of('PROJCS'))
    expect((gcs.get(PDFName.of('EPSG')) as PDFNumber).asNumber()).toBe(3857)
    expect((gcs.lookup(PDFName.of('WKT'), PDFString) as PDFString).decodeText()).toContain('Mercator_Auxiliary_Sphere')
  })
})

describe('send-area page furniture', () => {
  const layout: PageLayout = pageLayout('letter', 'portrait')

  it('lays every page out in whole multiples of 16 map pixels, inside the margins', () => {
    for (const size of ['letter', 'legal', 'tabloid'] as const) {
      for (const orientation of ['portrait', 'landscape'] as const) {
        const l = pageLayout(size, orientation)
        expect(l.framePx.w % 16).toBe(0)
        expect(l.framePx.h % 16).toBe(0)
        expect(l.frame.x).toBeGreaterThan(27)
        expect(l.frame.x + l.frame.w).toBeLessThan(l.pageW - 27)
      }
    }
    expect(layout.frame.w).toBeCloseTo(layout.framePx.w * 0.75, 9)
  })

  it('labels UTM grid lines where they cross the frame edges', () => {
    const area = areaAt([-123.372, 48.4235], zoomForScale(48.4235, 20000), layout.framePx)
    const grid = utmGrid(area)!
    expect(grid.zone).toBe(10)
    expect(grid.spacing).toBe(1000)
    const top = grid.labels.filter((l) => l.edge === 'top').map((l) => l.value)
    expect(top.length).toBeGreaterThan(1)
    expect(new Set(top).size).toBe(top.length)
    for (const v of top) expect(v % 1000).toBe(0)
  })

  it('picks round scale-bar lengths in every distance unit', () => {
    expect(scaleBar(1400, 'metric')).toMatchObject({ metres: 1000, full: '1', unit: 'km' })
    expect(scaleBar(900, 'metric')).toMatchObject({ metres: 500, full: '500', unit: 'm' })
    expect(scaleBar(1400, 'imperial')).toMatchObject({ full: '0.5', unit: 'mi' })
    expect(scaleBar(400, 'imperial')).toMatchObject({ full: '1000', unit: 'ft' })
    expect(scaleBar(2000, 'nautical')).toMatchObject({ full: '1', unit: 'NM' })
    expect(scaleBar(1000, 'chains')).toMatchObject({ full: '20', unit: 'ch' })
  })

  it('splits corner coordinates over two lines in every coordinate format', () => {
    const p: [number, number] = [-123.372, 48.4235]
    expect(cornerLines(p, 'ddm')).toEqual(["48°25.410'N", "123°22.320'W"])
    expect(cornerLines(p, 'dd')).toEqual(['48.42350', '-123.37200'])
    expect(cornerLines(p, 'utm')[1]).toMatch(/^\d+N$/)
    expect(cornerLines(p, 'mgrs')[0]).toMatch(/^10U [A-Z]{2}$/)
    expect(cornerLines(p, 'bcalbers')[1]).toMatch(/^\d+N$/)
  })
})
