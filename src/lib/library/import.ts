import {
  openGeoPdf,
  parseGeoPdfRegions,
  readGeoPdfInfo,
  regionProjection,
  type GeoPdfInfo,
  type GeoPdfRegion,
} from '../geopdf'
import { DEFAULT_OPACITY, THUMB_PX, type MapsLibrary } from './library'
import type { LibraryMap } from './types'

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
      onProgress?.({
        label: chosen.length > 1 ? `Drawing map ${i + 1} of ${chosen.length}` : 'Drawing the map',
        fraction: i / chosen.length,
      })
      try {
        const rendered = await session.renderRegion(region, { thumbnailPx: THUMB_PX })
        const id = crypto.randomUUID()
        const path = `library/maps/${id}/image.png`
        const storedBytes = await library.files.write(path, [rendered.blob])
        const onPage = regions.filter((r) => r.pageIndex === region.pageIndex)
        const map: LibraryMap = {
          id,
          name,
          folder: opts.folder,
          addedAt: Date.now(),
          corners: [
            region.corners.topLeft,
            region.corners.topRight,
            region.corners.bottomRight,
            region.corners.bottomLeft,
          ],
          visible: true,
          opacity: DEFAULT_OPACITY,
          raster: { kind: 'image', path, width: rendered.width, height: rendered.height },
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
          thumb: rendered.thumb,
          storedBytes,
          drawErrors: rendered.drawErrors.length ? rendered.drawErrors : undefined,
        }
        await library.put(map)
        result.maps.push(map)
        rendered.drawErrors.forEach((e) => drawErrors.add(e))
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
