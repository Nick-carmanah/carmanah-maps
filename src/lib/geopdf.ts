import type { Position } from 'geojson'
import type { PDFArray as PDFArrayType } from 'pdf-lib'

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
  const TARGET_LONG_EDGE_PX = 2200
  const scale = TARGET_LONG_EDGE_PX / Math.max(xMax - xMin, yMax - yMin)

  // Render unrotated: the bbox is in unrotated user space.
  const viewport = page.getViewport({ scale, rotation: 0 })
  const fullCanvas = document.createElement('canvas')
  fullCanvas.width = Math.ceil(viewport.width)
  fullCanvas.height = Math.ceil(viewport.height)
  const ctx = fullCanvas.getContext('2d')!
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
  cropCanvas
    .getContext('2d')!
    .drawImage(fullCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH)

  const blob: Blob = await new Promise((resolve, reject) =>
    cropCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
  await loadingTask.destroy()
  return { blob, corners: region.corners }
}
