import type { Position } from 'geojson'
import type { MapProjection } from '../geopdf'

/** [topLeft, topRight, bottomRight, bottomLeft], each [lon, lat]. */
export type Corners = [Position, Position, Position, Position]

/** Shown for maps with no folder. */
export const UNSORTED = 'Unsorted'

/** Where a map came from in its PDF. */
export interface MapSourceInfo {
  fileName: string
  /** Size of the original file, in bytes. */
  fileSize: number
  /** 0-based. */
  pageIndex: number
  pageCount: number
  /** Which georeferenced frame on that page (0-based), and how many it has. */
  frameIndex: number
  frameCount: number
  pageSizePt: [number, number]
  /** The map frame on the page, in PDF points: [xMin, yMin, xMax, yMax]. */
  bboxPt: [number, number, number, number]
  projection?: MapProjection
}

/** How the map is drawn on the map view. */
export type MapRaster =
  /**
   * A Web Mercator tile pyramid, sharp to about 300 DPI of the paper map,
   * as one PMTiles archive in the owner's file store (512 px tiles).
   */
  | {
      kind: 'tiles'
      path: string
      minzoom: number
      maxzoom: number
      /** w, s, e, n */
      bounds: [number, number, number, number]
      tileCount: number
      dpi: number
    }
  /** One image of the whole map (2,200 px on its long edge): maps imported before tiles. */
  | { kind: 'image'; path: string; width: number; height: number }
  /** A map saved before the library existed: its image is still in the old `carmanah-maps` database. */
  | { kind: 'legacy'; rasterId: string }

/** One map in the Maps library. Stored in `carmanah-maps.<ownerId>` → `maps`. */
export interface LibraryMap {
  id: string
  name: string
  /** Folder name, usually a fire number. Empty means Unsorted. */
  folder: string
  addedAt: number
  corners: Corners
  visible: boolean
  /** 0–1. */
  opacity: number
  raster: MapRaster
  /**
   * The untouched original PDF, in the owner's file store. Several maps can
   * share one (pages of the same file). Absent for maps saved before
   * originals were kept: those can't be shared or sharpened, only re-imported.
   */
  originalPath?: string
  source?: MapSourceInfo
  /** Small JPEG for the library list. */
  thumb?: Blob
  /** Bytes this map's own files take (its raster), not counting the shared original. */
  storedBytes: number
  /** Parts of the map pdf.js couldn't draw, if any (see geopdf.ts). */
  drawErrors?: string[]
}
