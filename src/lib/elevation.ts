import type { Position } from 'geojson'
import type { RasterDEMSourceSpecification } from 'maplibre-gl'
import { MAP_STYLE } from '../map/basemap'

/**
 * Ground elevation at a point, read from the terrain tiles that draw the
 * hillshade (Terrarium encoding). Zoom 12 is the deepest level an offline
 * pack keeps, so a saved area answers the same with or without signal:
 * ~25 m pixels in BC, roughly ±10 m in steep ground.
 *
 * Tiles come through fetch, so on the website the service worker serves
 * saved ones offline. In the crew app this needs the same tile reader as the
 * map (native packs, plan §0).
 */

const Z = 12
const SIZE = 256
const CACHE_MAX = 8

const template = (MAP_STYLE.sources.terrain as RasterDEMSourceSpecification).tiles![0]
const tiles = new Map<string, Promise<Uint8ClampedArray | null>>()

async function loadTile(url: string): Promise<Uint8ClampedArray | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    // No colour management or premultiplying: the RGB values ARE the data.
    const bitmap = await createImageBitmap(await res.blob(), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    })
    const canvas = document.createElement('canvas')
    canvas.width = SIZE
    canvas.height = SIZE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, SIZE, SIZE)
    bitmap.close()
    return ctx.getImageData(0, 0, SIZE, SIZE).data
  } catch {
    return null // offline and not saved, or blocked
  }
}

function tile(x: number, y: number): Promise<Uint8ClampedArray | null> {
  const url = template.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y))
  let pending = tiles.get(url)
  if (!pending) {
    pending = loadTile(url)
    tiles.set(url, pending)
    if (tiles.size > CACHE_MAX) tiles.delete(tiles.keys().next().value!)
    // Don't remember a failure: it may work once there's signal.
    pending.then((data) => data || tiles.delete(url))
  }
  return pending
}

/** Elevation in metres above sea level, or null when there's no terrain tile to read. */
export async function elevationAt([lng, lat]: Position): Promise<number | null> {
  if (!(Math.abs(lat) < 85)) return null
  const n = 2 ** Z
  const xf = ((lng + 180) / 360) * n
  const r = (lat * Math.PI) / 180
  const yf = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n
  const x = Math.floor(xf)
  const y = Math.floor(yf)
  const data = await tile(x, y)
  if (!data) return null
  const px = Math.min(SIZE - 1, Math.floor((xf - x) * SIZE))
  const py = Math.min(SIZE - 1, Math.floor((yf - y) * SIZE))
  const i = (py * SIZE + px) * 4
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768
}
