import {
  openGeoPdf,
  type GeoPdfSession,
  parseGeoPdfRegions,
  readGeoPdfInfo,
  regionProjection,
  type GeoPdfInfo,
  type GeoPdfRegion,
} from '../geopdf'
import { DEFAULT_OPACITY, type MapsLibrary } from './library'
import type { TileProgress } from './tiles'
import type { Corners, LibraryMap, MapRaster } from './types'

/** What the page picker shows when a file holds more than one map. */
export interface PagePickRequest {
  fileName: string
  pageCount: number
  /** Every georeferenced map frame in the file, in page order. */
  regions: GeoPdfRegion[]
  info: GeoPdfInfo | null
  /** A small picture of a page (JPEG), drawn on demand. */
  pageThumbnail(pageIndex: number): Promise<Blob>
}

export interface ImportProgress {
  /** e.g. "Drawing page 2 of 3". */
  label: string
  /** 0–1. */
  fraction: number
}

export interface ImportOptions {
  /** Folder for the new maps ('' = Unsorted). */
  folder: string
  /**
   * Asked only when the file has more than one map frame. Resolve with the
   * frames to import, or null to cancel the import.
   */
  pickRegions(request: PagePickRequest): Promise<GeoPdfRegion[] | null>
  onProgress?(progress: ImportProgress): void
  signal?: AbortSignal
}

export interface ImportResult {
  maps: LibraryMap[]
  /** Errors pdf.js skipped while drawing the saved maps (text or layers may be missing). */
  drawErrors: string[]
  /** Frames that couldn't be saved (e.g. came out blank), with why. */
  failed: { name: string; error: string }[]
  cancelled: boolean
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError')
}

const cornersOf = (region: GeoPdfRegion): Corners => [
  region.corners.topLeft,
  region.corners.topRight,
  region.corners.bottomRight,
  region.corners.bottomLeft,
]

/**
 * Draw one map frame as tiles and store them as `library/maps/<id>/map.pmtiles`.
 * On failure or cancel nothing is left behind.
 */
async function renderAndStore(
  library: MapsLibrary,
  session: GeoPdfSession,
  region: GeoPdfRegion,
  id: string,
  opts: { signal?: AbortSignal; onProgress?: (p: TileProgress) => void },
): Promise<{ raster: MapRaster; storedBytes: number; thumb: Blob; drawErrors: string[] }> {
  // Loaded on first import, like pdf.js (and precached for offline the same way).
  const { renderTilePyramid } = await import('./tiles')
  const pyramid = await renderTilePyramid(session, region, cornersOf(region), opts)
  const path = `library/maps/${id}/map.pmtiles`
  try {
    if (opts.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError')
    const storedBytes = await library.files.write(path, pyramid.parts)
    return {
      raster: {
        kind: 'tiles',
        path,
        minzoom: pyramid.minzoom,
        maxzoom: pyramid.maxzoom,
        bounds: pyramid.bounds,
        tileCount: pyramid.tileCount,
        dpi: pyramid.dpi,
      },
      storedBytes,
      thumb: pyramid.thumb,
      drawErrors: pyramid.drawErrors,
    }
  } catch (err) {
    await library.files.removeDir(`library/maps/${id}`).catch(() => {})
    throw err
  }
}

/** "Fire map p2", or "Fire map p2-1" when that page has several frames. */
function mapName(base: string, region: GeoPdfRegion, all: GeoPdfRegion[]): string {
  if (all.length === 1) return base
  const onPage = all.filter((r) => r.pageIndex === region.pageIndex)
  const page = `p${region.pageIndex + 1}`
  return onPage.length > 1 ? `${base} ${page}-${onPage.indexOf(region) + 1}` : `${base} ${page}`
}

/**
 * Import a GeoPDF into the library: keep the original file untouched, draw
 * each chosen map frame, and save it. Throws if the file has no georeferenced
 * map, or if nothing could be saved.
 */
export async function importGeoPdf(
  library: MapsLibrary,
  file: File,
  opts: ImportOptions,
): Promise<ImportResult> {
  const { signal, onProgress } = opts
  const result: ImportResult = { maps: [], drawErrors: [], failed: [], cancelled: false }
  onProgress?.({ label: 'Reading the file', fraction: 0 })
  const bytes = new Uint8Array(await file.arrayBuffer())
  const regions = await parseGeoPdfRegions(bytes)
  if (!regions.length) {
    throw new Error("no embedded georeferencing found — this PDF can't be auto-placed")
  }
  const info = await readGeoPdfInfo(bytes)
  checkAbort(signal)

  const session = await openGeoPdf(bytes)
  const importId = crypto.randomUUID()
  const originalPath = `library/originals/${importId}.pdf`
  let originalSaved = false
  try {
    let chosen = regions
    if (regions.length > 1) {
      const picked = await opts.pickRegions({
        fileName: file.name,
        pageCount: session.pageCount,
        regions,
        info,
        pageThumbnail: (pageIndex) => session.renderPageThumbnail(pageIndex, 240),
      })
      if (!picked?.length) return { ...result, cancelled: true }
      chosen = picked
    }
    checkAbort(signal)

    // The original, byte for byte, so it can go back to Avenza.
    await library.files.write(originalPath, [file])
    originalSaved = true

    const base = file.name.replace(/\.pdf$/i, '')
    const drawErrors = new Set<string>()
    for (const [i, region] of chosen.entries()) {
      checkAbort(signal)
      const name = mapName(base, region, regions)
      const step = chosen.length > 1 ? `Map ${i + 1} of ${chosen.length}: ` : ''
      try {
        const id = crypto.randomUUID()
        const stored = await renderAndStore(library, session, region, id, {
          signal,
          onProgress: (p) =>
            onProgress?.({ label: `${step}${p.label}`, fraction: (i + p.fraction) / chosen.length }),
        })
        const onPage = regions.filter((r) => r.pageIndex === region.pageIndex)
        const map: LibraryMap = {
          id,
          name,
          folder: opts.folder,
          addedAt: Date.now(),
          corners: cornersOf(region),
          visible: true,
          opacity: DEFAULT_OPACITY,
          raster: stored.raster,
          originalPath,
          source: {
            fileName: file.name,
            fileSize: file.size,
            pageIndex: region.pageIndex,
            pageCount: session.pageCount,
            frameIndex: onPage.indexOf(region),
            frameCount: onPage.length,
            pageSizePt: region.pageSizePt,
            bboxPt: region.bboxPt,
            projection: regionProjection(info, region),
          },
          thumb: stored.thumb,
          storedBytes: stored.storedBytes,
          drawErrors: stored.drawErrors.length ? stored.drawErrors : undefined,
        }
        await library.put(map)
        result.maps.push(map)
        stored.drawErrors.forEach((e) => drawErrors.add(e))
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') throw err
        result.failed.push({ name, error: (err as Error).message })
      }
    }
    result.drawErrors = [...drawErrors]
    onProgress?.({ label: 'Saved', fraction: 1 })
    if (!result.maps.length) {
      // Nothing saved: a single map's own error reads best.
      throw new Error(result.failed[0]?.error ?? 'nothing was saved')
    }
    return result
  } catch (err) {
    if ((err as DOMException).name === 'AbortError') {
      // Keep any maps already finished; just stop.
      result.cancelled = true
      if (result.maps.length) return result
    }
    throw err
  } finally {
    await session.close().catch(() => {})
    if (originalSaved && !result.maps.length) await library.files.remove(originalPath).catch(() => {})
  }
}

/**
 * Re-draw a map from its kept original as sharp tiles (for maps imported
 * before tiles, which are one 2,200 px image). Returns the updated record.
 */
export async function sharpenMap(
  library: MapsLibrary,
  map: LibraryMap,
  opts: { signal?: AbortSignal; onProgress?: (p: ImportProgress) => void } = {},
): Promise<LibraryMap> {
  const original = await library.readOriginal(map)
  if (!original || !map.source) throw new Error("this map's original file isn't on this device")
  const bytes = new Uint8Array(await original.arrayBuffer())
  const source = map.source
  const region = (await parseGeoPdfRegions(bytes)).find(
    (r) => r.pageIndex === source.pageIndex && r.bboxPt.every((v, i) => Math.abs(v - source.bboxPt[i]) < 1e-6),
  )
  if (!region) throw new Error("couldn't find this map in its original file")
  const session = await openGeoPdf(bytes)
  try {
    const old = map.raster
    // A fresh folder name, so the old image stays usable until the new tiles are saved.
    const stored = await renderAndStore(library, session, region, `${map.id}-t`, opts)
    const next = await library.update(map.id, {
      raster: stored.raster,
      corners: cornersOf(region),
      storedBytes: stored.storedBytes,
      thumb: stored.thumb,
      drawErrors: stored.drawErrors.length ? stored.drawErrors : undefined,
    })
    if (old.kind === 'image') {
      await library.files.removeDir(old.path.slice(0, old.path.lastIndexOf('/'))).catch(() => {})
    }
    if (!next) throw new Error('the map was deleted')
    return next
  } finally {
    await session.close().catch(() => {})
  }
}
