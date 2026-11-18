/**
 * Regression tests for GeoPDF placement (src/lib/geopdf.ts).
 *
 * Every Esri GeoPDF imported between July and November 2026 rendered
 * upside-down, because ArcGIS writes the viewport BBox top edge first and the
 * importer assumed y-up. These tests build synthetic GeoPDFs in every layout
 * we know of, and check that each frame corner lands within 0.5 m of where it
 * really is, so a bug like that fails the PR check instead of reaching phones.
 *
 * Rendering (renderGeoPdfRegion) needs a browser canvas and isn't covered
 * here. It crops the page to `bboxPt` with the top edge at the top, which is
 * why the tests also check `bboxPt` exactly.
 */
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { parseGeoPdfRegions, type GeoPdfRegion } from '../src/lib/geopdf'
import {
  arcgisCornerOrder,
  buildGeoPdf,
  CORNER_NAMES,
  cornerUV,
  FIELD_MAP,
  LETTER_PORTRAIT,
  resaveWithObjectStreams,
  TABLOID_LANDSCAPE,
  type BBoxStyle,
  type CornerName,
  type FrameSpec,
  type GeoPdfFixture,
  type LonLat,
  type PageSpec,
  type TrueRegion,
} from './fixtures/geopdf-builder'

const TOLERANCE_M = 0.5

/** Ground distance in metres (haversine; plenty for sub-metre checks). */
function metresBetween([lon1, lat1]: number[], [lon2, lat2]: number[]): number {
  const rad = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a))
}

/** Everything that's wrong with `found`, as readable lines (empty when it's right). */
function placementErrors(found: GeoPdfRegion[], truth: TrueRegion[]): string[] {
  if (found.length !== truth.length) return [`found ${found.length} map frames, expected ${truth.length}`]
  return found.flatMap((r, i) => {
    const t = truth[i]
    const errors: string[] = []
    if (r.pageIndex !== t.pageIndex) errors.push(`frame ${i}: on page ${r.pageIndex}, expected ${t.pageIndex}`)
    if (r.bboxPt.some((v, k) => Math.abs(v - t.bboxPt[k]) > 1e-6)) {
      errors.push(`frame ${i}: bboxPt [${r.bboxPt}], expected [${t.bboxPt}]`)
    }
    if (r.pageSizePt.some((v, k) => Math.abs(v - t.pageSizePt[k]) > 1e-6)) {
      errors.push(`frame ${i}: pageSizePt [${r.pageSizePt}], expected [${t.pageSizePt}]`)
    }
    for (const c of CORNER_NAMES) {
      const off = metresBetween(r.corners[c], t.corners[c])
      if (!(off <= TOLERANCE_M)) errors.push(`frame ${i}: ${c} is ${off.toFixed(2)} m from where it should be`)
    }
    return errors
  })
}

async function expectPlacedCorrectly(fixture: GeoPdfFixture) {
  const found = await parseGeoPdfRegions(fixture.bytes)
  expect(placementErrors(found, fixture.regions)).toEqual([])
}

const onePage = (frame: FrameSpec, size = TABLOID_LANDSCAPE): PageSpec[] => [{ size, frames: [frame] }]

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]))

describe('GeoPDF placement', () => {
  it('ArcGIS: BBox written top edge first, LPTS relative to it', async () => {
    await expectPlacedCorrectly(await buildGeoPdf(onePage(FIELD_MAP)))
  })

  it('BBox written y-up [xMin yMin xMax yMax]', async () => {
    await expectPlacedCorrectly(await buildGeoPdf(onePage({ ...FIELD_MAP, bbox: 'y-up' })))
  })

  describe('LPTS corners in any order', () => {
    const short = { topLeft: 'TL', topRight: 'TR', bottomRight: 'BR', bottomLeft: 'BL' } as const
    const cases = (['top-first', 'y-up'] as BBoxStyle[]).flatMap((style) =>
      permutations<CornerName>(CORNER_NAMES).map((order) => ({
        style,
        order,
        name: `${style} BBox, LPTS ${order.map((c) => short[c]).join(' ')}`,
      })),
    )
    it.each(cases)('$name', async ({ style, order }) => {
      const lpts = order.map((c) => cornerUV(c, style))
      await expectPlacedCorrectly(await buildGeoPdf(onePage({ ...FIELD_MAP, bbox: style, lpts })))
    })
  })

  describe('rotated data frame (corners are nowhere near a lat/lon rectangle)', () => {
    it.each([30, 90, 180, -45])('rotated %i°', async (rotationDeg) => {
      await expectPlacedCorrectly(await buildGeoPdf(onePage({ ...FIELD_MAP, rotationDeg })))
    })
  })

  it('frame inset off-centre on the page', async () => {
    const frame: FrameSpec = {
      frame: { left: 140, bottom: 230, right: 470, top: 610 },
      centre: [-120.34, 50.67],
      scale: 10000,
    }
    await expectPlacedCorrectly(await buildGeoPdf(onePage(frame, LETTER_PORTRAIT)))
  })

  it('two map frames on one page (main map + overview)', async () => {
    const main: FrameSpec = { ...FIELD_MAP, frame: { left: 36, bottom: 60, right: 900, top: 756 } }
    const overview: FrameSpec = {
      frame: { left: 930, bottom: 500, right: 1188, top: 756 },
      centre: FIELD_MAP.centre,
      scale: 250000,
    }
    await expectPlacedCorrectly(await buildGeoPdf([{ size: TABLOID_LANDSCAPE, frames: [main, overview] }]))
  })

  it('map frames on separate pages, after a page with no map', async () => {
    const legendSheet: PageSpec = { size: LETTER_PORTRAIT, frames: [] }
    const second: FrameSpec = {
      frame: { left: 40, bottom: 40, right: 572, top: 700 },
      centre: [-120.34, 50.67],
      scale: 10000,
      rotationDeg: 20,
      bbox: 'y-up',
      viewport: 'indirect',
    }
    const fixture = await buildGeoPdf([
      legendSheet,
      { size: TABLOID_LANDSCAPE, frames: [FIELD_MAP] },
      { size: LETTER_PORTRAIT, frames: [second] },
    ])
    expect(fixture.regions.map((r) => r.pageIndex)).toEqual([1, 2])
    await expectPlacedCorrectly(fixture)
  })

  it('viewport written as its own object instead of inline', async () => {
    await expectPlacedCorrectly(await buildGeoPdf(onePage({ ...FIELD_MAP, viewport: 'indirect' })))
  })

  it('no LPTS, so control points come from Bounds', async () => {
    await expectPlacedCorrectly(await buildGeoPdf(onePage({ ...FIELD_MAP, writeLpts: false })))
  })

  describe('control points not on the corners (least-squares fit)', () => {
    // The fit is affine, and lat/lon isn't quite affine across a UTM frame: on
    // a full 11x17 1:20,000 sheet the corners drift ~1.8 m. A 1:10,000 letter
    // frame keeps that under 0.15 m, so 0.5 m still means "placed correctly".
    const frame: FrameSpec = {
      frame: { left: 36, bottom: 60, right: 576, top: 460 },
      centre: [-123.372, 48.4235],
      scale: 10000,
    }
    const grid = [0.1, 0.5, 0.9].flatMap((u) => [0.1, 0.5, 0.9].map((v): [number, number] => [u, v]))

    it.each(['top-first', 'y-up'] as BBoxStyle[])('9 interior points, %s BBox', async (bbox) => {
      await expectPlacedCorrectly(await buildGeoPdf(onePage({ ...frame, bbox, lpts: grid }, LETTER_PORTRAIT)))
    })

    it('9 interior points, rotated 30°', async () => {
      const spec = { ...frame, rotationDeg: 30, lpts: grid }
      await expectPlacedCorrectly(await buildGeoPdf(onePage(spec, LETTER_PORTRAIT)))
    })

    it('only 3 points', async () => {
      const spec = { ...frame, lpts: [[0.2, 0.2], [0.8, 0.3], [0.4, 0.9]] as [number, number][] }
      await expectPlacedCorrectly(await buildGeoPdf(onePage(spec, LETTER_PORTRAIT)))
    })
  })

  it('Acrobat-style re-save with compressed object streams', async () => {
    const original = await buildGeoPdf(onePage(FIELD_MAP))
    const bytes = await resaveWithObjectStreams(original.bytes)
    const text = new TextDecoder('latin1').decode(bytes)
    // Make sure the fixture really hides the georeferencing from a text scan.
    expect(text).toContain('/ObjStm')
    expect(text).not.toContain('/GPTS')
    await expectPlacedCorrectly({ bytes, regions: original.regions })
  })

  it('object streams written directly, two frames', async () => {
    const overview: FrameSpec = {
      frame: { left: 930, bottom: 500, right: 1188, top: 756 },
      centre: FIELD_MAP.centre,
      scale: 250000,
      rotationDeg: 180,
    }
    const main: FrameSpec = { ...FIELD_MAP, frame: { left: 36, bottom: 60, right: 900, top: 756 } }
    const pages = [{ size: TABLOID_LANDSCAPE, frames: [main, overview] }]
    await expectPlacedCorrectly(await buildGeoPdf(pages, { useObjectStreams: true }))
  })

  describe('byte-scanner fallback (files pdf-lib rejects)', () => {
    /** The same PDF with no "%PDF-" header anywhere: pdf-lib refuses it, the byte scanner doesn't care. */
    async function withoutHeader(fixture: GeoPdfFixture): Promise<GeoPdfFixture> {
      const bytes = fixture.bytes.slice()
      const header = [...'%PDF-'].map((ch) => ch.charCodeAt(0))
      for (let i = 0; i + header.length <= bytes.length; i++) {
        if (header.every((b, k) => bytes[i + k] === b)) bytes[i + 1] = 'X'.charCodeAt(0)
      }
      await expect(PDFDocument.load(bytes)).rejects.toThrow(/header/i)
      return { ...fixture, bytes }
    }

    it.each(['top-first', 'y-up'] as BBoxStyle[])('ArcGIS file layout, %s BBox', async (bbox) => {
      await expectPlacedCorrectly(await withoutHeader(await buildGeoPdf(onePage({ ...FIELD_MAP, bbox }))))
    })

    // KNOWN BUG, not fixed yet. The scanner's object regex runs from "N 0 obj <<"
    // to the next ">> endobj". A stream's dictionary ends ">> stream", so a stream
    // object swallows the object after it. ArcGIS puts the GCS between the page's
    // content stream and the Measure, so its files are fine; with the GCS inline,
    // the Measure comes straight after the stream and the map isn't found.
    // When the scanner is fixed this starts failing: change it.fails to it.
    it.fails('known bug: misses a Measure written straight after a content stream', async () => {
      await expectPlacedCorrectly(await withoutHeader(await buildGeoPdf(onePage({ ...FIELD_MAP, gcs: 'inline' }))))
    })
  })

  it('finds nothing in a PDF without georeferencing', async () => {
    const { bytes } = await buildGeoPdf([{ size: LETTER_PORTRAIT, frames: [] }])
    expect(await parseGeoPdfRegions(bytes)).toEqual([])
  })
})

describe('fixture sanity', () => {
  it('the field map really is projected: its top edge is not a line of latitude', async () => {
    const [region] = (await buildGeoPdf(onePage(FIELD_MAP))).regions
    const { topLeft, topRight } = region.corners
    const topEdgeTilt = metresBetween(topLeft, [topLeft[0], topRight[1]] as LonLat)
    expect(topEdgeTilt).toBeGreaterThan(20) // UTM grid convergence near Victoria
  })

  it('ArcGIS corner order is SW, NW, NE, SE', () => {
    expect(arcgisCornerOrder('top-first').flat()).toEqual([0, 1, 0, 0, 1, 0, 1, 1])
    expect(arcgisCornerOrder('y-up').flat()).toEqual([0, 0, 0, 1, 1, 1, 1, 0])
  })
})
