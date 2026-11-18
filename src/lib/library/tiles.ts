import {
  assertNotBlank,
  canvasToBlob,
  context2d,
  thumbnailOf,
  type GeoPdfRegion,
  type GeoPdfSession,
  type PdfPage,
} from '../geopdf'
import { PmCompression, PmTileType, planPack } from '../pmtiles-writer'
import type { Corners } from './types'

/**
 * Draw a GeoPDF map frame as a Web Mercator tile pyramid, so it stays sharp
 * when zoomed in: the printed grid labels crews read out to helicopters must
 * be legible.
 *
 * Placement: the frame's four corners are where parseGeoPdfRegions put them
 * (unchanged). Inside, a PDF point at fraction (u, v) of the frame lands at
 * the bilinear blend of the corners in Mercator space — the same way
 * MapLibre draws a four-corner image, which is how maps were placed before
 * tiles. Each chunk is drawn with the best-fitting affine transform for its
 * own area, which stays well under a pixel from that blend.
 *
 * Memory (iPhones): no canvas is bigger than 2,048 px on a side. pdf.js
 * draws each chunk of tiles straight into its canvas with a transform; the
 * page is never drawn whole at full detail. Below the zoom where the whole
 * frame fits one chunk, levels are halved from the one above instead.
 */

export const TILE_PX = 512
/** Tiles per side in one pdf.js render: 4 × 512 = 2,048 px. */
const CHUNK_TILES = 4
/** Aim for about 300 DPI of the source: PDF points are 1/72 in. */
const TARGET_PX_PER_PT = 300 / 72
/** Cap pixels at the top zoom (≈ a 36 × 48 in plotter map at 230 DPI). */
const MAX_TOP_PIXELS = 90e6
/** Keep going down until the whole map is about this small on screen. */
const MIN_EXTENT_PX = 48
/** Long edge of the full-frame render used for the blank check and the thumbnail. */
const OVERVIEW_PX = 2048

export interface TileProgress {
  label: string
  /** 0–1 within this map. */
  fraction: number
}

export interface TilePyramid {
  /** The whole archive, ready to store: header, directories, tiles. */
  parts: BlobPart[]
  bytes: number
  tileCount: number
  minzoom: number
  maxzoom: number
  /** w, s, e, n */
  bounds: [number, number, number, number]
  /** Effective resolution at the top zoom, in dots per inch of the paper map. */
  dpi: number
  thumb: Blob
  drawErrors: string[]
}

type Affine = [number, number, number, number, number, number]
type Pt = [number, number]

/** a ∘ b: apply b, then a (canvas matrix order [a b c d e f]). */
function mul(a: Affine, b: Affine): Affine {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

function invert(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2]
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ]
}

const apply = (m: Affine, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

/** Web Mercator, as fractions of the world (0–1), y down. */
export function toMercator([lon, lat]: number[]): Pt {
  const s = Math.sin((lat * Math.PI) / 180)
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]
}

export function fromMercator([x, y]: Pt): Pt {
  return [x * 360 - 180, (Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) * 360) / Math.PI - 90]
}

/** The frame as MapLibre draws four corners: a bilinear blend in Mercator space. */
class FrameMapping {
  /** tl, tr, br, bl in Mercator world fractions. */
  readonly m: [Pt, Pt, Pt, Pt]

  constructor(
    corners: Corners,
    readonly bbox: [number, number, number, number],
  ) {
    this.m = corners.map(toMercator) as [Pt, Pt, Pt, Pt]
  }

  /** (u, v) across the frame (0,0 top-left … 1,1 bottom-right) → Mercator. */
  forward(u: number, v: number): Pt {
    const [a, b, c, d] = this.m
    return [
      (1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]),
      (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1]),
    ]
  }

  /** Mercator → (u, v), by Newton's method (the blend is nearly affine). */
  inverse(p: Pt): Pt {
    const [a, b, c, d] = this.m
    let u = 0.5
    let v = 0.5
    for (let i = 0; i < 12; i++) {
      const f = this.forward(u, v)
      const fx = f[0] - p[0]
      const fy = f[1] - p[1]
      const du: Pt = [(1 - v) * (b[0] - a[0]) + v * (c[0] - d[0]), (1 - v) * (b[1] - a[1]) + v * (c[1] - d[1])]
      const dv: Pt = [(1 - u) * (d[0] - a[0]) + u * (c[0] - b[0]), (1 - u) * (d[1] - a[1]) + u * (c[1] - b[1])]
      const det = du[0] * dv[1] - du[1] * dv[0]
      const su = (fx * dv[1] - fy * dv[0]) / det
      const sv = (du[0] * fy - du[1] * fx) / det
      u -= su
      v -= sv
      if (Math.abs(su) + Math.abs(sv) < 1e-13) break
    }
    return [u, v]
  }

  /** PDF user space (y up) ↔ (u, v). */
  pdfOf([u, v]: Pt): Pt {
    const [xMin, yMin, xMax, yMax] = this.bbox
    return [xMin + u * (xMax - xMin), yMax - v * (yMax - yMin)]
  }

  /** Mercator world fractions per PDF point, averaged over the frame's edges. */
  unitsPerPt(): number {
    const [a, b, c, d] = this.m
    const len = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1])
    const [xMin, yMin, xMax, yMax] = this.bbox
    return (len(a, b) + len(d, c) + len(a, d) + len(b, c)) / (2 * (xMax - xMin) + 2 * (yMax - yMin))
  }

  /**
   * The affine PDF-user-space → canvas-pixel transform that best matches the
   * blend over a canvas covering world pixels [x0, x0+w) × [y0, y0+h) at
   * zoom z (least squares over a 5 × 5 grid of points).
   */
  canvasTransform(z: number, x0: number, y0: number, w: number, h: number): Affine {
    const world = TILE_PX * 2 ** z
    // Normal equations for x_pdf and y_pdf as affine functions of (px, py).
    const ata = [0, 0, 0, 0, 0, 0, 0, 0, 0]
    const atx = [0, 0, 0]
    const aty = [0, 0, 0]
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const px = (w * i) / 4
        const py = (h * j) / 4
        const [x, y] = this.pdfOf(this.inverse([(x0 + px) / world, (y0 + py) / world]))
        const row = [px, py, 1]
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) ata[r * 3 + c] += row[r] * row[c]
          atx[r] += row[r] * x
          aty[r] += row[r] * y
        }
      }
    }
    const sx = solve3(ata, atx)
    const sy = solve3(ata, aty)
    // canvas → pdf, then invert.
    return invert([sx[0], sy[0], sx[1], sy[1], sx[2], sy[2]])
  }
}

/** Solve a 3 × 3 system (row-major) by Cramer's rule. */
function solve3(m: number[], b: number[]): [number, number, number] {
  const det3 = (a: number[]) =>
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6])
  const d = det3(m)
  const col = (k: number) => m.map((v, i) => (i % 3 === k ? b[Math.floor(i / 3)] : v))
  return [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d]
}

/**
 * Pick the top zoom: the first one that gives at least ~85% of 300 DPI of
 * the paper map (zooms double, so the result is 255–510 DPI), capped for
 * very large maps.
 */
export function pickMaxZoom(unitsPerPt: number, bbox: [number, number, number, number]): number {
  const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
  let z = Math.ceil(Math.log2(TARGET_PX_PER_PT / (TILE_PX * unitsPerPt)) - Math.log2(1 / 0.85))
  z = Math.min(22, Math.max(0, z))
  while (z > 0 && area * (TILE_PX * 2 ** z * unitsPerPt) ** 2 > MAX_TOP_PIXELS) z--
  return z
}

let webpOk: boolean | undefined
/** Can this browser encode WebP from a canvas? (Chrome/Android and Firefox yes; Safari no.) */
function canEncodeWebp(): boolean {
  if (webpOk === undefined) {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    webpOk = c.toDataURL('image/webp').startsWith('data:image/webp')
  }
  return webpOk
}

type TileFormat = 'webp' | 'png' | 'jpeg'

/**
 * Tiles: WebP where the browser can write it (lossless, alpha). Elsewhere
 * (Safari), PNG: lossless keeps thin grid lines and small labels crisp, and
 * keeps the transparent edges of rotated maps.
 */
async function encodeTile(canvas: HTMLCanvasElement): Promise<{ blob: Blob; format: TileFormat }> {
  if (canEncodeWebp()) return { blob: await canvasToBlob(canvas, 'image/webp', 1), format: 'webp' }
  return { blob: await canvasToBlob(canvas, 'image/png'), format: 'png' }
}

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function free(...canvases: (HTMLCanvasElement | null | undefined)[]) {
  for (const c of canvases) if (c) c.width = c.height = 0
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError')
}

/** Draw `page` into `canvas` with PDF user space mapped by `toCanvas`. */
async function drawPage(page: PdfPage, canvas: HTMLCanvasElement, toCanvas: Affine, signal?: AbortSignal) {
  const viewport = page.getViewport({ scale: 1, rotation: 0 })
  // pdf.js applies `transform` and then the viewport's own transform.
  const transform = mul(toCanvas, invert(viewport.transform as Affine))
  const task = page.render({ canvas, canvasContext: context2d(canvas), viewport, transform })
  const onAbort = () => task.cancel()
  signal?.addEventListener('abort', onAbort)
  try {
    await task.promise
  } catch (err) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError')
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Make everything outside the map frame transparent (rotated maps don't fill their tiles). */
function maskToFrame(canvas: HTMLCanvasElement, toCanvas: Affine, bbox: [number, number, number, number]) {
  const ctx = context2d(canvas)
  const [xMin, yMin, xMax, yMax] = bbox
  const corners: Pt[] = [
    [xMin, yMax],
    [xMax, yMax],
    [xMax, yMin],
    [xMin, yMin],
  ].map((p) => apply(toCanvas, p as Pt))
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.beginPath()
  corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

interface Level {
  z: number
  tx0: number
  ty0: number
  tx1: number
  ty1: number
}

function levelAt(mapping: FrameMapping, z: number): Level & { extent: number } {
  const world = TILE_PX * 2 ** z
  const xs = mapping.m.map((p) => p[0] * world)
  const ys = mapping.m.map((p) => p[1] * world)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const last = 2 ** z - 1
  const tile = (v: number) => Math.min(last, Math.max(0, Math.floor(v / TILE_PX)))
  return {
    z,
    tx0: tile(minX),
    tx1: tile(maxX - 1e-6),
    ty0: tile(minY),
    ty1: tile(maxY - 1e-6),
    extent: Math.max(maxX - minX, maxY - minY),
  }
}

/**
 * Render one map frame of an open PDF as a tile pyramid and pack it as one
 * PMTiles archive (kept in memory as tile Blobs until it's written).
 */
export async function renderTilePyramid(
  session: GeoPdfSession,
  region: GeoPdfRegion,
  corners: Corners,
  opts: { signal?: AbortSignal; onProgress?: (p: TileProgress) => void } = {},
): Promise<TilePyramid> {
  const { signal, onProgress } = opts
  const mapping = new FrameMapping(corners, region.bboxPt)
  const [xMin, yMin, xMax, yMax] = region.bboxPt
  const maxzoom = pickMaxZoom(mapping.unitsPerPt(), region.bboxPt)

  // The levels, top down, until the whole map is tiny.
  const levels: (Level & { extent: number })[] = []
  for (let z = maxzoom; z >= 0; z--) {
    const level = levelAt(mapping, z)
    levels.push(level)
    if (level.extent < MIN_EXTENT_PX) break
  }
  const minzoom = levels.at(-1)!.z
  // The first level whose tiles fit one chunk is drawn once; the rest are halved from it.
  const fitIndex = Math.max(
    0,
    levels.findIndex((l) => l.tx1 - l.tx0 < CHUNK_TILES && l.ty1 - l.ty0 < CHUNK_TILES),
  )

  // Work units for progress: pixels pdf.js has to draw.
  const chunkJobs: { level: Level; cx0: number; cy0: number; cx1: number; cy1: number }[] = []
  for (const level of levels.slice(0, fitIndex + 1)) {
    for (let cy = level.ty0; cy <= level.ty1; cy += CHUNK_TILES) {
      for (let cx = level.tx0; cx <= level.tx1; cx += CHUNK_TILES) {
        chunkJobs.push({
          level,
          cx0: cx,
          cy0: cy,
          cx1: Math.min(level.tx1, cx + CHUNK_TILES - 1),
          cy1: Math.min(level.ty1, cy + CHUNK_TILES - 1),
        })
      }
    }
  }
  const jobPixels = (j: (typeof chunkJobs)[number]) => (j.cx1 - j.cx0 + 1) * (j.cy1 - j.cy0 + 1)
  const totalUnits = chunkJobs.reduce((s, j) => s + jobPixels(j), 0) + 2 // + overview, + packing
  let doneUnits = 0
  const report = (label: string) => onProgress?.({ label, fraction: Math.min(1, doneUnits / totalUnits) })

  const tiles = new Map<string, { z: number; x: number; y: number; blob: Blob; format: TileFormat }>()
  const tileCanvas = newCanvas(TILE_PX, TILE_PX)
  const tileCtx = context2d(tileCanvas)

  /** Cut a canvas whose top-left is tile (tx0, ty0) into tiles; skip empty ones. */
  const sliceTiles = async (canvas: HTMLCanvasElement, level: Level, tx0: number, ty0: number, tx1: number, ty1: number) => {
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        checkAbort(signal)
        tileCtx.clearRect(0, 0, TILE_PX, TILE_PX)
        tileCtx.drawImage(canvas, (tx - tx0) * TILE_PX, (ty - ty0) * TILE_PX, TILE_PX, TILE_PX, 0, 0, TILE_PX, TILE_PX)
        const alpha = tileCtx.getImageData(0, 0, TILE_PX, TILE_PX).data
        let any = false
        for (let i = 3; i < alpha.length; i += 4) {
          if (alpha[i]) {
            any = true
            break
          }
        }
        if (!any) continue
        const { blob, format } = await encodeTile(tileCanvas)
        tiles.set(`${level.z}/${tx}/${ty}`, { z: level.z, x: tx, y: ty, blob, format })
      }
    }
  }

  return session.withPage(region.pageIndex, async (page, drawErrors) => {
    let fitCanvas: HTMLCanvasElement | null = null
    try {
      // 1. The whole frame at overview size: refuse a blank map before any
      //    tiles are made (same rule as before), and make the thumbnail.
      report('Checking the map')
      const scale = OVERVIEW_PX / Math.max(xMax - xMin, yMax - yMin)
      const overview = newCanvas(Math.round((xMax - xMin) * scale), Math.round((yMax - yMin) * scale))
      let thumb: Blob
      try {
        await drawPage(page, overview, [scale, 0, 0, -scale, -xMin * scale, yMax * scale], signal)
        assertNotBlank(context2d(overview).getImageData(0, 0, overview.width, overview.height).data, drawErrors)
        thumb = await thumbnailOf(overview, 192)
      } finally {
        free(overview)
      }
      doneUnits += 1

      // 2. pdf.js draws each chunk of the detailed levels.
      let rendered = 0
      for (const job of chunkJobs) {
        checkAbort(signal)
        const { level } = job
        report(`Drawing detail (${++rendered} of ${chunkJobs.length})`)
        const w = (job.cx1 - job.cx0 + 1) * TILE_PX
        const h = (job.cy1 - job.cy0 + 1) * TILE_PX
        const canvas = newCanvas(w, h)
        const keep = level === levels[fitIndex]
        try {
          const toCanvas = mapping.canvasTransform(level.z, job.cx0 * TILE_PX, job.cy0 * TILE_PX, w, h)
          await drawPage(page, canvas, toCanvas, signal)
          maskToFrame(canvas, toCanvas, region.bboxPt)
          await sliceTiles(canvas, level, job.cx0, job.cy0, job.cx1, job.cy1)
          if (keep) fitCanvas = canvas
        } finally {
          if (!keep) free(canvas)
        }
        doneUnits += jobPixels(job)
      }

      // 3. Smaller levels: halve the one above (tile grids nest exactly).
      report('Drawing overview levels')
      let above: { canvas: HTMLCanvasElement; level: Level } = { canvas: fitCanvas!, level: levels[fitIndex] }
      for (const level of levels.slice(fitIndex + 1)) {
        checkAbort(signal)
        const canvas = newCanvas((level.tx1 - level.tx0 + 1) * TILE_PX, (level.ty1 - level.ty0 + 1) * TILE_PX)
        const ctx = context2d(canvas)
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(
          above.canvas,
          (above.level.tx0 * TILE_PX) / 2 - level.tx0 * TILE_PX,
          (above.level.ty0 * TILE_PX) / 2 - level.ty0 * TILE_PX,
          above.canvas.width / 2,
          above.canvas.height / 2,
        )
        await sliceTiles(canvas, level, level.tx0, level.ty0, level.tx1, level.ty1)
        free(above.canvas)
        above = { canvas, level }
      }
      free(above.canvas)
      fitCanvas = null

      // 4. Pack.
      report('Saving')
      const formats = new Set([...tiles.values()].map((t) => t.format))
      const tileType =
        formats.size !== 1
          ? PmTileType.Unknown
          : { webp: PmTileType.Webp, png: PmTileType.Png, jpeg: PmTileType.Jpeg }[[...formats][0]]
      const merc = mapping.m
      const lonLats = merc.map(fromMercator)
      const bounds: [number, number, number, number] = [
        Math.min(...lonLats.map((p) => p[0])),
        Math.min(...lonLats.map((p) => p[1])),
        Math.max(...lonLats.map((p) => p[0])),
        Math.max(...lonLats.map((p) => p[1])),
      ]
      const dpi = Math.round(72 * TILE_PX * 2 ** maxzoom * mapping.unitsPerPt())
      const plan = planPack(
        [...tiles.values()].map((t) => ({ z: t.z, x: t.x, y: t.y, length: t.blob.size })),
        {
          tileType,
          tileCompression: PmCompression.None,
          minZoom: minzoom,
          maxZoom: maxzoom,
          bounds,
          center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, Math.max(minzoom, maxzoom - 3)],
          metadata: {
            format: [...formats].join(','),
            generator: 'carmanah-maps',
            corners,
            pdfFrame: region.bboxPt,
            dpi,
          },
        },
      )
      const parts: BlobPart[] = [plan.prefix as Uint8Array<ArrayBuffer>]
      for (const t of plan.tiles) parts.push(tiles.get(`${t.z}/${t.x}/${t.y}`)!.blob)
      doneUnits = totalUnits
      report('Saving')
      return {
        parts,
        bytes: plan.totalLength,
        tileCount: plan.tiles.length,
        minzoom,
        maxzoom,
        bounds,
        dpi,
        thumb,
        drawErrors: [...drawErrors],
      }
    } finally {
      free(tileCanvas, fitCanvas)
    }
  })
}
