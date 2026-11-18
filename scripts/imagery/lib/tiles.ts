// Web Mercator tile math (XYZ scheme, 256 px tiles), no dependencies.

export const TILE_SIZE = 256
/** Web Mercator metres per pixel at the equator, zoom 0, 256 px tiles. */
export const EQUATOR_M_PER_PX = 156543.03392804097

export interface TileId {
  z: number
  x: number
  y: number
}

export function lonToX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z
}

export function latToY(lat: number, z: number): number {
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, lat))
  const rad = (clamped * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
}

export function xToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180
}

export function yToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z)
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI
}

/** [west, south, east, north] in degrees. */
export function tileBounds({ z, x, y }: TileId): [number, number, number, number] {
  return [xToLon(x, z), yToLat(y + 1, z), xToLon(x + 1, z), yToLat(y, z)]
}

/** Ground metres per pixel at a latitude. */
export function groundResolution(lat: number, z: number): number {
  return (EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / 2 ** z
}

/** Longitude/latitude of the centre of pixel (i, j) in a tile. */
export function pixelLonLat(tile: TileId, i: number, j: number): [number, number] {
  return [
    xToLon(tile.x + (i + 0.5) / TILE_SIZE, tile.z),
    yToLat(tile.y + (j + 0.5) / TILE_SIZE, tile.z),
  ]
}

export function children({ z, x, y }: TileId): TileId[] {
  return [
    { z: z + 1, x: 2 * x, y: 2 * y },
    { z: z + 1, x: 2 * x + 1, y: 2 * y },
    { z: z + 1, x: 2 * x, y: 2 * y + 1 },
    { z: z + 1, x: 2 * x + 1, y: 2 * y + 1 },
  ]
}
