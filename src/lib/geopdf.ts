import type { Position } from 'geojson'
import type { PDFArray as PDFArrayType } from 'pdf-lib'
import type { PdfjsWarningMessage } from './pdfjs-worker-setup'
import pdfjsWorkerUrl from './pdfjs-worker?worker&url'

/**
 * Geospatial PDF support (ISO 32000-2 §12.9). Maps exported from
 * ArcGIS/ArcMap/QGIS with georeference info embed ground-control points in
 * the PDF itself, so placing them on the map needs no server or GDAL.
 *
 * We read the PDF's real object structure with pdf-lib, so it doesn't matter
 * what order keys are written in, whether objects sit in compressed object
 * streams, or whether values are indirect references — all of which change
 * when a map is re-saved through Acrobat (common for "revised" field maps).
 * The old byte-pattern parser stays as a fallback for files pdf-lib rejects.
 *
 * Not yet handled: TerraGo-style GeoPDFs (LGIDict, used by USGS topos).
 */

export interface GeoPdfRegion {
  /** 0-based page index this viewport belongs to. */
  pageIndex: number
  /** Viewport BBox in PDF user space: [xMin, yMin, xMax, yMax], y-up. */
  bboxPt: [number, number, number, number]
  /** Page MediaBox size in points (informational). */
  pageSizePt: [number, number]
  /**
   * The four corners of the bbox in [lon, lat]. Derived from the ground
   * control points, so they're right regardless of the data frame's rotation
   * relative to true north (fire maps are often rotated to fit the page).
   */
  corners: {
    topLeft: Position
    topRight: Position
    bottomRight: Position
    bottomLeft: Position
  }
}

/** Find every georeferenced viewport in the PDF. */
export async function parseGeoPdfRegions(bytes: Uint8Array): Promise<GeoPdfRegion[]> {
  try {
    const regions = await parseWithPdfLib(bytes)
    if (regions.length) return regions
  } catch {
    // Fall through to the byte-pattern parser.
  }
  return parseByPattern(bytes)
}

async function parseWithPdfLib(bytes: Uint8Array): Promise<GeoPdfRegion[]> {
  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  })

  const numbers = (arr: PDFArrayType | undefined): number[] => {
    if (!arr) return []
    const out: number[] = []
    for (let i = 0; i < arr.size(); i++) {
      const n = arr.lookup(i)
      out.push(n instanceof PDFNumber ? n.asNumber() : NaN)
    }
    return out
  }
  const maybe = <T>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }

  const regions: GeoPdfRegion[] = []
  doc.getPages().forEach((page, pageIndex) => {
    const vp = maybe(() => page.node.lookupMaybe(PDFName.of('VP'), PDFArray))
    if (!vp) return
    const media = page.getMediaBox()
    for (let i = 0; i < vp.size(); i++) {
      const viewport = maybe(() => vp.lookup(i, PDFDict))
      if (!viewport) continue
      const bbox = numbers(maybe(() => viewport.lookupMaybe(PDFName.of('BBox'), PDFArray)))
      const measure = maybe(() => viewport.lookupMaybe(PDFName.of('Measure'), PDFDict))
      if (bbox.length !== 4 || bbox.some(Number.isNaN) || !measure) continue
      if (measure.get(PDFName.of('Subtype')) !== PDFName.of('GEO')) continue

      const gpts = numbers(maybe(() => measure.lookupMaybe(PDFName.of('GPTS'), PDFArray)))
      // LPTS pairs with GPTS; Bounds (the neatline) is only a fallback.
      const lpts =
        numbers(maybe(() => measure.lookupMaybe(PDFName.of('LPTS'), PDFArray))).length > 0
          ? numbers(maybe(() => measure.lookupMaybe(PDFName.of('LPTS'), PDFArray)))
          : numbers(maybe(() => measure.lookupMaybe(PDFName.of('Bounds'), PDFArray)))
      const corners = cornersFromGcps(bbox, lpts, gpts)
      if (!corners) continue

      regions.push({
        pageIndex,
        bboxPt: normalizeBox(bbox),
        pageSizePt: [media.width, media.height],
        corners,
      })
    }
  })
  return regions
}

/** Esri writes BBox as [left, top, right, bottom]; normalise to min/max. */
function normalizeBox(b: number[]): [number, number, number, number] {
  return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])]
}

/**
 * LPTS are fractions (0..1) of the viewport BBox **as written**: (u, v) is
 * the page point (B0 + u·(B2−B0), B1 + v·(B3−B1)). This matters because
 * ArcGIS writes BBox top edge first ([left, top, right, bottom]), so v = 0 is
 * the top of the map, not the bottom — assuming y-up flips every Esri map
 * upside-down. GDAL reads it the same way. GPTS are (lat, lon) at those
 * points, 1:1 by index.
 *
 * So: put each control point in real page coordinates, then read off the
 * lat/lon at the page-space corners of the box (top-left = xMin, yMax, since
 * page space is y-up). Points exactly on the corners (ArcGIS always writes
 * them that way) are used as-is; anything else gets a least-squares affine.
 */
function cornersFromGcps(
  bboxAsWritten: number[],
  lpts: number[],
  gpts: number[],
): GeoPdfRegion['corners'] | null {
  const [b0, b1, b2, b3] = bboxAsWritten
  const pts: { px: number; py: number; lon: number; lat: number }[] = []
  for (let i = 0; i + 1 < lpts.length && i + 1 < gpts.length; i += 2) {
    const [u, v, lat, lon] = [lpts[i], lpts[i + 1], gpts[i], gpts[i + 1]]
    if (![u, v, lat, lon].every(Number.isFinite)) continue
    pts.push({ px: b0 + u * (b2 - b0), py: b1 + v * (b3 - b1), lat, lon })
  }
  if (pts.length < 3) return null

  const [xMin, yMin, xMax, yMax] = normalizeBox(bboxAsWritten)
  const tol = 1e-6 * Math.max(xMax - xMin, yMax - yMin, 1)
  const at = (x: number, y: number) =>
    pts.find((p) => Math.abs(p.px - x) < tol && Math.abs(p.py - y) < tol)
  const exact = [at(xMin, yMax), at(xMax, yMax), at(xMax, yMin), at(xMin, yMin)]
  if (exact.every(Boolean)) {
    const [tl, tr, br, bl] = exact as NonNullable<(typeof exact)[number]>[]
    return {
      topLeft: [tl.lon, tl.lat],
      topRight: [tr.lon, tr.lat],
      bottomRight: [br.lon, br.lat],
      bottomLeft: [bl.lon, bl.lat],
    }
  }

  const lonFit = fitAffine(pts.map((p) => [p.px, p.py, p.lon]))
  const latFit = fitAffine(pts.map((p) => [p.px, p.py, p.lat]))
  if (!lonFit || !latFit) return null
  const evalAt = (x: number, y: number): Position => [
    lonFit[0] * x + lonFit[1] * y + lonFit[2],
    latFit[0] * x + latFit[1] * y + latFit[2],
  ]
  return {
    topLeft: evalAt(xMin, yMax),
    topRight: evalAt(xMax, yMax),
    bottomRight: evalAt(xMax, yMin),
    bottomLeft: evalAt(xMin, yMin),
  }
}

/** Least-squares fit of v = a·x + b·y + c. Returns [a, b, c]. */
function fitAffine(samples: number[][]): [number, number, number] | null {
  // Normal equations: (AᵀA) [a b c]ᵀ = Aᵀv, with rows [x, y, 1].
  const m = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  for (const [x, y, v] of samples) {
    const row = [x, y, 1]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) m[r][c] += row[r] * row[c]
      m[r][3] += row[r] * v
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < 3; col++) {
    let pivot = col
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r
    if (Math.abs(m[pivot][col]) < 1e-12) return null
    ;[m[col], m[pivot]] = [m[pivot], m[col]]
    for (let r = 0; r < 3; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c]
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]]
}

// ---- Fallback: byte-pattern parser (the original approach) ----

function parseNumArray(s: string): number[] {
  return s.trim().split(/\s+/).filter(Boolean).map(Number)
}

/** Pull a `/Key[ ... ]` array out of a dictionary body, in any key order. */
function arrayEntry(dict: string, key: string): number[] {
  const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict)
  return m ? parseNumArray(m[1]) : []
}

function parseByPattern(bytes: Uint8Array): GeoPdfRegion[] {
  const text = new TextDecoder('latin1').decode(bytes)

  const measures = new Map<string, { lpts: number[]; gpts: number[] }>()
  for (const m of text.matchAll(/(\d+)\s+0\s+obj\s*<<([^]*?)>>\s*endobj/g)) {
    const body = m[2]
    if (!/\/Subtype\s*\/GEO\b/.test(body) || !/\/Type\s*\/Measure\b/.test(body)) continue
    const lpts = arrayEntry(body, 'LPTS')
    measures.set(m[1], {
      lpts: lpts.length ? lpts : arrayEntry(body, 'Bounds'),
      gpts: arrayEntry(body, 'GPTS'),
    })
  }
  if (!measures.size) return []

  const regions: GeoPdfRegion[] = []
  let pageIndex = 0
  for (const m of text.matchAll(/\d+\s+0\s+obj\s*<<([^]*?)>>\s*endobj/g)) {
    const body = m[1]
    if (!/\/Type\s*\/Page\b/.test(body)) continue
    const media = arrayEntry(body, 'MediaBox')
    for (const vp of body.matchAll(/<<([^<>]*?\/Measure\s+(\d+)\s+0\s+R[^<>]*?)>>/g)) {
      const bbox = arrayEntry(vp[1], 'BBox')
      const measure = measures.get(vp[2])
      if (bbox.length !== 4 || !measure) continue
      const corners = cornersFromGcps(bbox, measure.lpts, measure.gpts)
      if (!corners) continue
      regions.push({
        pageIndex,
        bboxPt: normalizeBox(bbox),
        pageSizePt: media.length === 4 ? [media[2] - media[0], media[3] - media[1]] : [0, 0],
        corners,
      })
    }
    pageIndex++
  }
  return regions
}

// ---- Rendering ----

export interface RenderedGeoPdf {
  /** Cropped raster of just the georeferenced region, as a Blob. */
  blob: Blob
  corners: GeoPdfRegion['corners']
  /**
   * Errors pdf.js skipped over while drawing (its "ignoring errors"
   * warnings), without repeats. If there are any, parts of the map, often
   * its text, may be missing, and the import should say so.
   */
  drawErrors: string[]
}

/** A crop counts as blank when more than this share of it is one colour. */
const BLANK_MAX_SHARE = 0.99

/**
 * Share (0–1) of pixels that are exactly the image's most common colour. A
 * failed render is one flat colour: white (pdf.js paints the page white
 * first) or transparent (the canvas itself failed).
 */
export function dominantColourShare(rgba: Uint8ClampedArray): number {
  const px = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >>> 2)
  if (!px.length) return 1
  // Find the most common colour in an even sample, then count it exactly.
  const step = Math.max(1, Math.floor(px.length / 4096))
  const seen = new Map<number, number>()
  let mode = px[0]
  let best = 0
  for (let i = 0; i < px.length; i += step) {
    const n = (seen.get(px[i]) ?? 0) + 1
    seen.set(px[i], n)
    if (n > best) [mode, best] = [px[i], n]
  }
  let same = 0
  for (let i = 0; i < px.length; i++) if (px[i] === mode) same++
  return same / px.length
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  // Safari gives null when a canvas is too big or the page is out of canvas memory.
  if (!ctx) {
    throw new Error(
      `couldn't get a ${canvas.width}×${canvas.height} canvas to draw the map on. Close other apps and try again.`,
    )
  }
  return ctx
}

/** Render a georeferenced region's page and crop to just its map area. */
export async function renderGeoPdfRegion(
  bytes: Uint8Array,
  region: GeoPdfRegion,
): Promise<RenderedGeoPdf> {
  // pdf.js's *legacy* build, not the default one. The default build calls
  // new built-ins (Map.prototype.getOrInsertComputed, Math.sumPrecise) with
  // no fallback; Safari only has getOrInsertComputed from iOS 26.2, so import
  // fails on older iPhones (e.g. XS/XR, which stop at iOS 18). The legacy
  // build polyfills them. The page module and the worker must match.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // Our worker entry (pdfjs-worker.ts): the legacy pdf.js worker, plus the
  // polyfill it needs on iOS 16.4–17.3 and a hook that forwards its warnings.
  pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl
  const worker = new pdfjs.PDFWorker()

  // e.g. 'getOperatorList - ignoring errors during "GetOperatorList: page 0"
  // task: "TypeError: buffer.transferToFixedLength is not a function".'
  const drawErrors = new Set<string>()
  const onWorkerMessage = (e: MessageEvent) => {
    const text = (e.data as Partial<PdfjsWarningMessage> | null)?.pdfjsWarning
    if (typeof text !== 'string' || !text.includes('ignoring errors')) return
    drawErrors.add((/: "(.*)"\.?$/.exec(text)?.[1] ?? text).slice(0, 120))
  }

  try {
    await worker.promise
    worker.port.addEventListener('message', onWorkerMessage)
    // pdf.js detaches/transfers the buffer — hand it a private copy.
    const loadingTask = pdfjs.getDocument({ data: bytes.slice(), worker })
    try {
      const doc = await loadingTask.promise
      const page = await doc.getPage(region.pageIndex + 1)

      const [xMin, yMin, xMax, yMax] = region.bboxPt
      const TARGET_LONG_EDGE_PX = 2200
      const scale = TARGET_LONG_EDGE_PX / Math.max(xMax - xMin, yMax - yMin)

      // Render unrotated: the bbox is in unrotated user space.
      const viewport = page.getViewport({ scale, rotation: 0 })
      const fullCanvas = document.createElement('canvas')
      fullCanvas.width = Math.ceil(viewport.width)
      fullCanvas.height = Math.ceil(viewport.height)
      const ctx = context2d(fullCanvas)
      await page.render({ canvas: fullCanvas, canvasContext: ctx, viewport }).promise

      // Let pdf.js map user space → canvas (handles MediaBox/CropBox offsets and
      // the y-flip), rather than assuming the page origin is at 0,0.
      const [ax, ay] = viewport.convertToViewportPoint(xMin, yMax)
      const [bx, by] = viewport.convertToViewportPoint(xMax, yMin)
      const cropX = Math.min(ax, bx)
      const cropY = Math.min(ay, by)
      const cropW = Math.abs(bx - ax)
      const cropH = Math.abs(by - ay)

      const cropCanvas = document.createElement('canvas')
      cropCanvas.width = Math.round(cropW)
      cropCanvas.height = Math.round(cropH)
      const cropCtx = context2d(cropCanvas)
      cropCtx.drawImage(fullCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)
      // Free the full-page canvas now: iOS caps a page's total canvas memory.
      fullCanvas.width = fullCanvas.height = 0

      // A blank map would look like a successful import and leave a crew with
      // nothing in the field. Refuse to save it.
      const pixels = cropCtx.getImageData(0, 0, cropCanvas.width, cropCanvas.height).data
      if (dominantColourShare(pixels) > BLANK_MAX_SHARE) {
        const why = drawErrors.size ? ` (${[...drawErrors][0]})` : ''
        throw new Error(
          `the map came out blank${why}, so it wasn't saved. Update the phone's software (iOS or Android) and try again; if it's still blank, report this map.`,
        )
      }

      const blob: Blob = await new Promise((resolve, reject) =>
        cropCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
      )
      return { blob, corners: region.corners, drawErrors: [...drawErrors] }
    } finally {
      await loadingTask.destroy()
    }
  } finally {
    worker.port?.removeEventListener('message', onWorkerMessage)
    worker.destroy()
  }
}
