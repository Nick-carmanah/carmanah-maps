declare module 'shpjs' {
  import type { FeatureCollection } from 'geojson'
  /** Parses a zipped shapefile (or bare .shp) buffer into GeoJSON. */
  export default function shp(
    buffer: ArrayBuffer,
  ): Promise<FeatureCollection | FeatureCollection[]>
}
