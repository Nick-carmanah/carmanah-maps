import type { Position } from 'geojson'

/**
 * Geospatial PDF support (ISO 32000-2 §12.9 / TerraGo GeoPDF). Maps exported
 * from ArcGIS/ArcMap with "include georeference information" embed exact
 * ground-control points right in the PDF — the georeferencing is already
 * done, so unlike a plain scanned map, no external GDAL step is needed.
 * We regex the raw PDF bytes for the Measure/Viewport dictionaries (they're
 * written as plain, uncompressed PDF syntax by Esri's exporter) rather than
 * pulling in a full PDF object-graph parser just for this.
 */

export interface GeoPdfRegion {
  /** 0-based page index this viewport belongs to. */
  pageIndex: number
  /** Viewport BBox in PDF page points: [xMin, yMin, xMax, yMax], y-up. */
  bboxPt: [number, number, number, number]
  /** Page's own MediaBox size in points, for render-scale math. */
  pageSizePt: [number, number]
  /**
   * The four corners of the bbox in [lon, lat], matched by ground-control
   * point to their actual physical corner (independent of the data frame's
   * rotation relative to true north — GeoPDF regions are very often
   * rotated to fit an elongated fire on the page).
   */
  corners: {
    topLeft: Position
    topRight: Position
    bottomRight: Position
    bottomLeft: Position
  }
}

function parseNumArray(s: string): number[] {
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

/** Scan raw PDF bytes for every georeferenced Measure+Viewport pair. */
export function parseGeoPdfRegions(bytes: Uint8Array): GeoPdfRegion[] {
  const text = new TextDecoder('latin1').decode(bytes)

  // Every /Type/Measure/Subtype/GEO object, keyed by "N 0 obj" id.
  const measures = new Map<string, { bounds: number[]; gpts: number[] }>()
  const measureRe =
    /(\d+)\s+0\s+obj\s*<<[^>]*?\/Type\s*\/Measure\s*\/Subtype\s*\/GEO[^>]*?\/Bounds\s*\[([^\]]+)\][^>]*?\/GPTS\s*\[([^\]]+)\]/g
  for (const m of text.matchAll(measureRe)) {
    measures.set(m[1], { bounds: parseNumArray(m[2]), gpts: parseNumArray(m[3]) })
  }
  if (!measures.size) return []

  // Page objects, in file order (good enough proxy for reading order on
  // the single/simple-tree PDFs this exporter produces).
  const pageRe =
    /(\d+)\s+0\s+obj\s*<<\s*\/Type\s*\/Page\b[^]*?\/MediaBox\s*\[([^\]]+)\][^]*?(?:\/VP\s*\[(.*?)\]\s*\n?>>|>>)/g
  const regions: GeoPdfRegion[] = []
  let pageIndex = 0
  for (const m of text.matchAll(pageRe)) {
    const mediaBox = parseNumArray(m[2])
    const vpBlock = m[3]
    if (vpBlock) {
      const vpEntryRe = /<<[^>]*?\/BBox\s*\[([^\]]+)\][^>]*?\/Measure\s+(\d+)\s+0\s+R/g
      for (const vp of vpBlock.matchAll(vpEntryRe)) {
        const bbox = parseNumArray(vp[1])
        const measure = measures.get(vp[2])
        if (bbox.length === 4 && measure && measure.gpts.length >= 8) {
          const xMin = Math.min(bbox[0], bbox[2])
          const xMax = Math.max(bbox[0], bbox[2])
          const yMin = Math.min(bbox[1], bbox[3])
          const yMax = Math.max(bbox[1], bbox[3])
          const corners = cornersFromGcps(measure.bounds, measure.gpts)
          if (corners) {
            regions.push({
              pageIndex,
              bboxPt: [xMin, yMin, xMax, yMax],
              pageSizePt: [mediaBox[2] - mediaBox[0], mediaBox[3] - mediaBox[1]],
              corners,
            })
          }
        }
      }
    }
    pageIndex++
  }
  return regions
}

/**
 * Bounds/LPTS give ground-control points as fractions (0..1) of the
 * viewport's own bbox, y-up (0,0 = bbox's physical lower-left, matching
 * standard PDF space). GPTS pairs are (lat, lon) at each of those points,
 * indexed 1:1. We match by fraction rather than assuming any fixed order,
 * since ArcGIS doesn't guarantee which corner comes first.
 */
function cornersFromGcps(
  fractions: number[],
  gpts: number[],
): GeoPdfRegion['corners'] | null {
  const points: { fx: number; fy: number; lon: number; lat: number }[] = []
  for (let i = 0; i + 1 < fractions.length && i + 1 < gpts.length; i += 2) {
    points.push({
      fx: fractions[i],
      fy: fractions[i + 1],
      lat: gpts[i],
      lon: gpts[i + 1],
    })
  }
  const closest = (fx: number, fy: number) =>
    points.reduce((best, p) =>
      (p.fx - fx) ** 2 + (p.fy - fy) ** 2 < (best.fx - fx) ** 2 + (best.fy - fy) ** 2 ? p : best,
    )
  if (points.length < 4) return null
  const tl = closest(0, 1)
  const tr = closest(1, 1)
  const br = closest(1, 0)
  const bl = closest(0, 0)
  return {
    topLeft: [tl.lon, tl.lat],
    topRight: [tr.lon, tr.lat],
    bottomRight: [br.lon, br.lat],
    bottomLeft: [bl.lon, bl.lat],
  }
}

export interface RenderedGeoPdf {
  /** Cropped raster of just the georeferenced region, as a Blob. */
  blob: Blob
  corners: GeoPdfRegion['corners']
}

/** Render a georeferenced region's page and crop to just its map area. */
export async function renderGeoPdfRegion(
  bytes: Uint8Array,
  region: GeoPdfRegion,
): Promise<RenderedGeoPdf> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString()

  // pdf.js detaches/transfers the buffer — hand it a private copy.
  const loadingTask = pdfjs.getDocument({ data: bytes.slice() })
  const doc = await loadingTask.promise
  const page = await doc.getPage(region.pageIndex + 1)

  const [xMin, yMin, xMax, yMax] = region.bboxPt
  const bboxWidthPt = xMax - xMin
  const bboxHeightPt = yMax - yMin
  const TARGET_LONG_EDGE_PX = 2200
  const scale = TARGET_LONG_EDGE_PX / Math.max(bboxWidthPt, bboxHeightPt)

  const viewport = page.getViewport({ scale })
  const fullCanvas = document.createElement('canvas')
  fullCanvas.width = Math.ceil(viewport.width)
  fullCanvas.height = Math.ceil(viewport.height)
  const ctx = fullCanvas.getContext('2d')!
  await page.render({ canvas: fullCanvas, canvasContext: ctx, viewport }).promise

  // PDF space is y-up from the bottom; canvas space is y-down from the top.
  const cropX = xMin * scale
  const cropY = fullCanvas.height - yMax * scale
  const cropW = bboxWidthPt * scale
  const cropH = bboxHeightPt * scale

  const cropCanvas = document.createElement('canvas')
  cropCanvas.width = Math.round(cropW)
  cropCanvas.height = Math.round(cropH)
  cropCanvas
    .getContext('2d')!
    .drawImage(fullCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

  const blob: Blob = await new Promise((resolve, reject) =>
    cropCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  await loadingTask.destroy()
  return { blob, corners: region.corners }
}
