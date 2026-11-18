// Shared types with no dependencies, so modules the root tests import
// (sources.ts, render.ts…) never reach raster.ts and its geotiff import,
// which is installed only in this folder (npm ci --prefix scripts/imagery).

import type { DnEncoding } from './stretch.ts'

export interface SourceSpec {
  id: string
  /** EPSG code of the item's UTM zone, e.g. 32610. */
  epsg: number
  /** Red, green, blue band COG URLs (https; presigned for CDSE). */
  bands: [string, string, string]
  encoding: DnEncoding
  /** [west, south, east, north] from the STAC item. */
  bbox: [number, number, number, number]
  /** Date or quarter, for the log and metadata. */
  date: string
  /** Bytes of the three band files (STAC file:size), if known. */
  bytes?: number
  /** 0 = main imagery; higher = older imagery used only to fill gaps. */
  priority?: number
}
