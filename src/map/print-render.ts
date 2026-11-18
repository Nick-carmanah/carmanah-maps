import maplibregl, { Map as MlMap } from 'maplibre-gl'
import type {
  ExpressionSpecification,
  RasterDEMSourceSpecification,
  StyleSpecification,
} from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { GLYPHS_URL, MAP_FONTSTACKS, MAP_STYLE, SPRITE_URL, TILEJSON_URL } from './basemap'
import { tileCacheKey } from '../lib/mappacks'
import {
  FIRE_SYMBOLS,
  featureLayer,
  featuresToGeoJSON,
  renderSymbolImage,
  type UserFeature,
} from '../lib/features'
import { NWCG_SYMBOLS, nwcgIconUrl } from '../lib/nwcg'
import type { Overlay } from '../lib/store'
import { STATUS_COLORS, STATUS_FALLBACK_COLOR, type LiveFires } from '../lib/livefires'
import {
  encodeRgbFlate,
  worldSize,
  worldToLngLat,
  type MapArea,
  type MapImagePiece,
} from '../lib/geopdf-write'

/**
 * Draws a map area for "Send this area as a map" with a second, hidden
 * MapLibre map: same basemap style and the same layers the user sees, at the
 * page's pixel size, from tiles already saved on the device when offline.
 *
 * iOS won't give a canvas more than about 4,096 px a side, so a big page is
 * drawn in pieces. Each piece is drawn with a margin of map around it, so
 * labels near its edges are placed the same way as in its neighbours, and
 * reaches a little into its right and bottom neighbours, so PDF viewers
 * don't show hairline seams.
 */

/** Map pixels drawn around each piece and then cropped off. */
export const RENDER_BUFFER = 128
/** Map pixels each piece reaches into its right/bottom neighbour. */
const OVERLAP = 2
/** Biggest canvas side, in device pixels: iOS's limit. */
export const MAX_CANVAS_PX = 4096
const PIECE_TIMEOUT_MS = 90_000

// ---- What's on the map ------------------------------------------------------

export interface PrintLayers {
  /** The user's pins, lines, areas and tracks that are showing. */
  features: FeatureCollection
  /** Imported KML/KMZ/GPX/shapefile overlays that are showing. */
  overlays: FeatureCollection[]
  /** BC Wildfire Service live fires, when that layer is on. */
  liveFires: { points: FeatureCollection; perimeters: FeatureCollection | null; fetchedAt: number } | null
}

/**
 * The visible layers, read from the app's state. This is the only place the
 * tool reads the feature model, so if that model changes, change this.
 */
export function printableLayers(state: {
  userFeatures: UserFeature[]
  hiddenLayers: Set<string>
  overlays: Overlay[]
  hiddenIds: Set<string>
  liveFires: LiveFires | null
  showLivePerimeters: boolean
}): PrintLayers {
  return {
    features: featuresToGeoJSON(state.userFeatures.filter((f) => !state.hiddenLayers.has(featureLayer(f)))),
    overlays: state.overlays.filter((o) => !state.hiddenIds.has(o.id)).map((o) => o.geojson),
    liveFires: state.liveFires
      ? {
          points: state.liveFires.points,
          perimeters: state.showLivePerimeters ? state.liveFires.perimeters : null,
          fetchedAt: state.liveFires.fetchedAt,
        }
      : null,
  }
}

// ---- Pieces -------------------------------------------------------------------

export interface RenderPiece {
  /** Position and size in the frame, map pixels (multiples of 16). */
  x: number
  y: number
  w: number
  h: number
  lastCol: boolean
  lastRow: boolean
}

/** Split `total` into `n` multiples of 16 that add up to it (total is a multiple of 16). */
function split(total: number, n: number): number[] {
  const units = total / 16
  const base = Math.floor(units / n)
  return Array.from({ length: n }, (_, i) => (base + (i < units % n ? 1 : 0)) * 16)
}

export function planPieces(area: MapArea, pixelRatio: number, maxCanvas = MAX_CANVAS_PX): RenderPiece[] {
  const maxInner = Math.floor((maxCanvas / pixelRatio - 2 * RENDER_BUFFER - OVERLAP) / 16) * 16
  if (maxInner < 64) throw new Error('canvas limit too small to draw the map')
  const cols = split(area.w, Math.ceil(area.w / maxInner))
  const rows = split(area.h, Math.ceil(area.h / maxInner))
  const pieces: RenderPiece[] = []
  let y = 0
  rows.forEach((h, r) => {
    let x = 0
    cols.forEach((w, c) => {
      pieces.push({ x, y, w, h, lastCol: c === cols.length - 1, lastRow: r === rows.length - 1 })
      x += w
    })
    y += h
  })
  return pieces
}

// ---- Are the tiles on the device? ---------------------------------------------

export interface TileCheck {
  /** Vector tile URL template, from the basemap's TileJSON (null: never loaded on this device). */
  tilesUrl: string | null
  /** Highest tile zoom to draw each source from. */
  vectorZoom: number
  terrainZoom: number
  /** Tiles at those zooms that aren't saved on the device; null when this device can't tell. */
  missing: number | null
  total: number
  /** Label fonts or map icons aren't saved (offline only). */
  labelsMissing: boolean
  offline: boolean
  /** Offline, a source is drawn from coarser tiles than ideal because the finer ones aren't saved. */
  coarser: boolean
}

const VECTOR_MAX_Z = 14
const TERRAIN_MAX_Z = (MAP_STYLE.sources.terrain as RasterDEMSourceSpecification).maxzoom ?? 14
const TERRAIN_URL = (MAP_STYLE.sources.terrain as RasterDEMSourceSpecification).tiles![0]
/** How many zoom levels coarser we'll go, offline, rather than leave a gap. */
const MAX_FALLBACK = 4

let tileJsonMemo: { url: string; at: number } | null = null

async function vectorTilesUrl(): Promise<string | null> {
  if (tileJsonMemo && Date.now() - tileJsonMemo.at < 10 * 60_000) return tileJsonMemo.url
  const sources: (() => Promise<Response | undefined>)[] = [() => fetch(TILEJSON_URL)]
  if (typeof caches !== 'undefined') sources.push(() => caches.match(TILEJSON_URL))
  for (const get of sources) {
    try {
      const res = await get()
      const url = res?.ok ? ((await res.json()) as { tiles?: string[] }).tiles?.[0] : undefined
      if (url) {
        tileJsonMemo = { url, at: Date.now() }
        return url
      }
    } catch {
      // try the next source
    }
  }
  return null
}

/**
 * Is this file saved for offline use? Website: the service worker's Cache
 * Storage. null = can't tell (no Cache Storage, e.g. inside the native app
 * until its own tile store exists — Phase 0.3 points this at it).
 */
async function savedOffline(url: string): Promise<boolean | null> {
  if (typeof caches === 'undefined') return null
  try {
    return !!(await caches.match(url))
  } catch {
    return null
  }
}

/** URLs of the tiles a source needs to draw the area (and its render margins) from zoom z. */
function tileUrls(area: MapArea, z: number, template: string): string[] {
  const n = 2 ** z
  const s = worldSize(area.zoom)
  const tile = (v: number) => Math.min(n - 1, Math.max(0, Math.floor((v / s) * n)))
  const B = RENDER_BUFFER
  const urls: string[] = []
  for (let x = tile(area.x0 - B); x <= tile(area.x0 + area.w + B - 1e-6); x++) {
    for (let y = tile(area.y0 - B); y <= tile(area.y0 + area.h + B - 1e-6); y++) {
      urls.push(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)))
    }
  }
  return urls
}

async function missingUrls(urls: string[], key: (u: string) => string = (u) => u): Promise<string[] | null> {
  const found = await Promise.all(urls.map((u) => savedOffline(key(u))))
  if (found.some((f) => f === null)) return null
  return urls.filter((_, i) => !found[i])
}

/**
 * Can we actually fetch a tile? A phone on Wi-Fi with no internet behind it
 * (a camp hotspot, a dead satellite link) still says navigator.onLine.
 * Fetching one tile the map needs anyway answers it, and caches that tile.
 */
async function reachable(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    return (await fetch(url, { signal: controller.signal })).ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Which tiles to draw from, and whether they're on the device. MapLibre picks
 * tile zooms the way this does: vector tiles (512 px) at floor(zoom), 256 px
 * raster tiles at round(zoom + 1). Offline, a source whose tiles aren't all
 * saved falls back to the finest zoom (up to 4 coarser) that is complete:
 * blurrier hillshade beats a blank patch.
 */
export async function checkTiles(area: MapArea): Promise<TileCheck> {
  const tilesUrl = await vectorTilesUrl()
  const ideal = {
    vector: Math.max(0, Math.min(VECTOR_MAX_Z, Math.floor(area.zoom))),
    terrain: Math.max(0, Math.min(TERRAIN_MAX_Z, Math.round(area.zoom + 1))),
  }

  const at = async (z: number, template: string, key?: (u: string) => string) => {
    const urls = tileUrls(area, z, template)
    const missing = await missingUrls(urls, key)
    return { z, total: urls.length, missing: missing?.length ?? null, firstMissing: missing?.[0] }
  }
  const idealVector = tilesUrl ? await at(ideal.vector, tilesUrl, tileCacheKey) : null
  const idealTerrain = await at(ideal.terrain, TERRAIN_URL)
  const probe = idealVector?.firstMissing ?? idealTerrain.firstMissing
  const offline =
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    (probe !== undefined && !(await reachable(probe)))

  const pick = async (first: Awaited<ReturnType<typeof at>>, template: string, key?: (u: string) => string) => {
    const idealZ = first.z
    if (!offline || first.missing === null || first.missing === 0) return first
    let best = first
    for (let z = idealZ - 1; z >= Math.max(0, idealZ - MAX_FALLBACK); z--) {
      const r = await at(z, template, key)
      if (r.missing === 0) return r
      if (r.missing !== null && r.missing / r.total < best.missing! / best.total) best = r
    }
    return best
  }

  const vector = tilesUrl && idealVector ? await pick(idealVector, tilesUrl, tileCacheKey) : null
  const terrain = await pick(idealTerrain, TERRAIN_URL)

  let labelsMissing = false
  if (offline) {
    const assets = [
      ...MAP_FONTSTACKS.map((fs) => GLYPHS_URL.replace('{fontstack}', fs).replace('{range}', '0-255')),
      `${SPRITE_URL}@2x.json`,
      `${SPRITE_URL}@2x.png`,
    ]
    labelsMissing = ((await missingUrls(assets))?.length ?? 0) > 0
  }

  const missing =
    vector === null ? null : vector.missing === null || terrain.missing === null ? null : vector.missing + terrain.missing
  return {
    tilesUrl,
    vectorZoom: vector?.z ?? ideal.vector,
    terrainZoom: terrain.z,
    missing,
    total: (vector?.total ?? 0) + terrain.total,
    labelsMissing,
    offline,
    coarser: (vector !== null && vector.z < ideal.vector) || terrain.z < ideal.terrain,
  }
}

// ---- Style ----------------------------------------------------------------------

/**
 * The app's basemap, with tile zooms capped at what's available, and no
 * satellite: Esri's terms don't allow its imagery in an exported map (see
 * SATELLITE_NOTE in src/lib/send-area.ts).
 */
function printStyle(tiles: TileCheck): StyleSpecification {
  const terrain = MAP_STYLE.sources.terrain as RasterDEMSourceSpecification
  return {
    ...MAP_STYLE,
    sources: {
      openmaptiles: { type: 'vector', tiles: [tiles.tilesUrl!], minzoom: 0, maxzoom: tiles.vectorZoom },
      terrain: { ...terrain, maxzoom: tiles.terrainZoom },
    },
    layers: MAP_STYLE.layers.filter((layer) => layer.id !== 'satellite'),
  }
}

const STATUS_COLOR = [
  'match',
  ['get', 'FIRE_STATUS'],
  ...Object.entries(STATUS_COLORS).flat(),
  STATUS_FALLBACK_COLOR,
] as unknown as ExpressionSpecification

const LABEL_PAINT = { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.5 }

/** The user's layers, styled as MapView draws them on screen. */
async function addPrintLayers(map: MlMap, layers: PrintLayers): Promise<void> {
  for (const key of Object.keys(FIRE_SYMBOLS)) {
    map.addImage(`sym-${key}`, renderSymbolImage(key), { pixelRatio: 2 })
  }
  const nwcgKeys = new Set(
    layers.features.features
      .map((f) => String(f.properties?.symbol ?? ''))
      .filter((s) => s.startsWith('nwcg-')),
  )
  await Promise.all(
    [...nwcgKeys].map(async (key) => {
      const spec = NWCG_SYMBOLS.find((s) => s.key === key)
      if (!spec) return
      try {
        const img = await map.loadImage(nwcgIconUrl(spec.file))
        map.addImage(`sym-${key}`, img.data, { pixelRatio: 2 })
      } catch {
        // Icon not available: the pin prints without its symbol.
      }
    }),
  )

  if (layers.liveFires) {
    if (layers.liveFires.perimeters) {
      map.addSource('print-live-perims', { type: 'geojson', data: layers.liveFires.perimeters })
      map.addLayer({
        id: 'print-live-perim-fill',
        type: 'fill',
        source: 'print-live-perims',
        paint: { 'fill-color': STATUS_COLOR, 'fill-opacity': 0.18 },
      })
      map.addLayer({
        id: 'print-live-perim-line',
        type: 'line',
        source: 'print-live-perims',
        paint: { 'line-color': STATUS_COLOR, 'line-width': 1.5 },
      })
    }
    map.addSource('print-live-pts', { type: 'geojson', data: layers.liveFires.points })
    map.addLayer({
      id: 'print-live-pts',
      type: 'circle',
      source: 'print-live-pts',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 10, 6],
        'circle-color': STATUS_COLOR,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
      },
    })
    map.addLayer({
      id: 'print-live-pts-label',
      type: 'symbol',
      source: 'print-live-pts',
      minzoom: 8,
      layout: {
        'text-field': ['get', 'FIRE_NUMBER'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: LABEL_PAINT,
    })
  }

  layers.overlays.forEach((data, i) => {
    const id = `print-ov-${i}`
    map.addSource(id, { type: 'geojson', data })
    map.addLayer({
      id: `${id}-fill`,
      type: 'fill',
      source: id,
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': ['coalesce', ['get', 'fill'], '#e11d1d'],
        'fill-opacity': ['coalesce', ['get', 'fill-opacity'], 0.25],
      },
    })
    map.addLayer({
      id: `${id}-line`,
      type: 'line',
      source: id,
      filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]],
      paint: {
        'line-color': ['coalesce', ['get', 'stroke'], '#e11d1d'],
        'line-width': ['coalesce', ['get', 'stroke-width'], 2],
        'line-opacity': ['coalesce', ['get', 'stroke-opacity'], 1],
      },
    })
    map.addLayer({
      id: `${id}-point`,
      type: 'circle',
      source: id,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 6,
        'circle-color': ['coalesce', ['get', 'marker-color'], '#e11d1d'],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    })
    map.addLayer({
      id: `${id}-label`,
      type: 'symbol',
      source: id,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ''],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: LABEL_PAINT,
    })
  })

  map.addSource('print-uf', { type: 'geojson', data: layers.features })
  map.addLayer({
    id: 'print-uf-fill',
    type: 'fill',
    source: 'print-uf',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 },
  })
  map.addLayer({
    id: 'print-uf-line',
    type: 'line',
    source: 'print-uf',
    filter: ['in', ['geometry-type'], ['literal', ['Polygon', 'LineString']]],
    paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
  })
  map.addLayer({
    id: 'print-uf-pts',
    type: 'circle',
    source: 'print-uf',
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['coalesce', ['get', 'symbol'], ''], '']],
    paint: {
      'circle-radius': 7,
      'circle-color': ['get', 'color'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#1a1a1a',
    },
  })
  map.addLayer({
    id: 'print-uf-sym',
    type: 'symbol',
    source: 'print-uf',
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['coalesce', ['get', 'symbol'], ''], '']],
    layout: { 'icon-image': ['concat', 'sym-', ['get', 'symbol']], 'icon-size': 1, 'icon-allow-overlap': true },
  })
  map.addLayer({
    id: 'print-uf-label',
    type: 'symbol',
    source: 'print-uf',
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: LABEL_PAINT,
  })
}

// ---- Drawing -----------------------------------------------------------------

export class CanvasTooBigError extends Error {}

export interface RenderOptions {
  area: MapArea
  /** Device pixels per map pixel (DPI / 96). */
  pixelRatio: number
  layers: PrintLayers
  tiles: TileCheck
  format: 'jpeg' | 'flate-rgb'
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  maxCanvas?: number
}

export interface RenderResult {
  pieces: MapImagePiece[]
  /** Tiles that failed to load (missing offline, or a network error). */
  failedTiles: number
  /** A piece timed out and was taken before every tile arrived. */
  incomplete: boolean
}

/** Draw the area, halving the canvas size if the device can't give us a big enough one. */
export async function renderArea(options: RenderOptions): Promise<RenderResult> {
  let maxCanvas = options.maxCanvas ?? MAX_CANVAS_PX
  for (;;) {
    try {
      return await renderAreaOnce({ ...options, maxCanvas })
    } catch (err) {
      if (!(err instanceof CanvasTooBigError) || maxCanvas <= 1024) throw err
      maxCanvas = Math.floor(maxCanvas / 2)
    }
  }
}

async function renderAreaOnce(options: RenderOptions & { maxCanvas: number }): Promise<RenderResult> {
  const { area, pixelRatio, signal, maxCanvas } = options
  if (!options.tiles.tilesUrl) {
    throw new Error("the basemap hasn't been loaded on this device yet. Open the map once with signal, or save the area offline.")
  }
  const plan = planPieces(area, pixelRatio, maxCanvas)
  const B = RENDER_BUFFER

  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
  })
  const sizeTo = (p: RenderPiece) => {
    container.style.width = `${p.w + 2 * B}px`
    container.style.height = `${p.h + 2 * B}px`
  }
  sizeTo(plan[0])
  document.body.appendChild(container)

  const failed = new Set<string>()
  let incomplete = false
  let map: MlMap | undefined
  try {
    const centreOf = (p: RenderPiece) =>
      worldToLngLat(area.x0 + p.x + p.w / 2, area.y0 + p.y + p.h / 2, area.zoom) as [number, number]
    map = new maplibregl.Map({
      container,
      style: printStyle(options.tiles),
      center: centreOf(plan[0]),
      zoom: area.zoom,
      bearing: 0,
      pitch: 0,
      interactive: false,
      attributionControl: false,
      pixelRatio,
      maxCanvasSize: [maxCanvas, maxCanvas],
      fadeDuration: 0,
      trackResize: false,
      renderWorldCopies: false,
      refreshExpiredTiles: false,
    })
    map.on('error', (e) => {
      const { tile, sourceId } = e as unknown as { tile?: { tileID?: { key?: string } }; sourceId?: string }
      if (tile) failed.add(`${sourceId}/${tile.tileID?.key}`)
      else console.warn('[send area] map error', e.error?.message ?? e)
    })
    await withTimeout(map.once('load') as Promise<unknown>, PIECE_TIMEOUT_MS, 'the map style never finished loading')
    await addPrintLayers(map, options.layers)

    const pieces: MapImagePiece[] = []
    for (let i = 0; i < plan.length; i++) {
      signal?.throwIfAborted()
      const p = plan[i]
      sizeTo(p)
      map.resize()
      map.jumpTo({ center: centreOf(p), zoom: area.zoom, bearing: 0, pitch: 0 })
      const shot = await capture(map, p, pixelRatio)
      incomplete ||= !shot.complete
      signal?.throwIfAborted()
      pieces.push(await encodePiece(shot, p, options.format))
      options.onProgress?.(i + 1, plan.length)
      // Let the page repaint the progress before the next piece.
      await new Promise((r) => setTimeout(r, 0))
    }
    return { pieces, failedTiles: failed.size, incomplete }
  } finally {
    map?.remove()
    container.remove()
  }
}

interface Shot {
  canvas: HTMLCanvasElement
  /** Device pixels per map pixel actually drawn. */
  ratio: number
  complete: boolean
}

/**
 * Wait until every tile has loaded and every label is placed ('idle'), then
 * copy the piece (minus its margin) out of the WebGL canvas. The copy happens
 * inside the event, in the same frame the map was drawn, so it doesn't need
 * preserveDrawingBuffer (which costs memory iPhones don't have to spare).
 */
function capture(map: MlMap, p: RenderPiece, pixelRatio: number): Promise<Shot> {
  return new Promise((resolve, reject) => {
    let done = false
    const grab = (complete: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      map.off('idle', onIdle)
      try {
        const src = map.getCanvas()
        const cssW = p.w + 2 * RENDER_BUFFER
        const ratio = src.width / cssW
        const gl = (src.getContext('webgl2') ?? src.getContext('webgl')) as WebGLRenderingContext | null
        if (Math.abs(ratio - pixelRatio) > 1e-6 || (gl && gl.drawingBufferWidth < src.width)) {
          throw new CanvasTooBigError(`canvas ${src.width}×${src.height} not available`)
        }
        const sx = Math.round(RENDER_BUFFER * ratio)
        const sw = Math.round(p.w * ratio) + (p.lastCol ? 0 : Math.ceil(OVERLAP * ratio))
        const sh = Math.round(p.h * ratio) + (p.lastRow ? 0 : Math.ceil(OVERLAP * ratio))
        const canvas = document.createElement('canvas')
        canvas.width = sw
        canvas.height = sh
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new CanvasTooBigError(`couldn't get a ${sw}×${sh} canvas`)
        ctx.drawImage(src, sx, sx, sw, sh, 0, 0, sw, sh)
        resolve({ canvas, ratio, complete })
      } catch (err) {
        reject(err)
      }
    }
    const onIdle = () => grab(true)
    map.on('idle', onIdle)
    // A tile that never answers: take what's drawn, in a render frame.
    const timer = setTimeout(() => {
      map.once('render', () => grab(false))
      map.triggerRepaint()
    }, PIECE_TIMEOUT_MS)
    map.triggerRepaint()
  })
}

async function encodePiece(shot: Shot, p: RenderPiece, format: 'jpeg' | 'flate-rgb'): Promise<MapImagePiece> {
  const { canvas, ratio } = shot
  const placed = { x: p.x, y: p.y, w: canvas.width / ratio, h: canvas.height / ratio }
  try {
    if (format === 'jpeg') {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
      if (!blob) throw new Error('JPEG encoding failed')
      return { ...placed, format, bytes: new Uint8Array(await blob.arrayBuffer()) }
    }
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    return {
      ...placed,
      format,
      bytes: encodeRgbFlate(data, canvas.width, canvas.height),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    // Free it now: iOS caps a page's total canvas memory.
    canvas.width = canvas.height = 0
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}
