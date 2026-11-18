import type maplibregl from 'maplibre-gl'
import libertyStyle from './openfreemap-liberty.json'

// Basemap: OpenFreeMap's "Liberty" style over OpenFreeMap vector tiles —
// free, no API key, commercial use and offline downloads allowed
// (openfreemap.org/tos). The style is a copy of
// https://tiles.openfreemap.org/styles/liberty kept in the bundle so it loads
// offline; refresh it by re-downloading that URL. Its design is CC BY 4.0
// (OpenMapTiles), credited by the attribution in the tiles' TileJSON.

/** TileJSON for the vector tiles; its tile URLs carry a weekly build version. */
export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet'
export const GLYPHS_URL = libertyStyle.glyphs
export const SPRITE_URL = libertyStyle.sprite

// Recolour toward the standard OpenStreetMap map this app started with — green
// forest, OSM-blue water, pink/salmon/orange/yellow roads by class, dark rail.
const ROAD_COLOR = [
  'match',
  ['get', 'class'],
  'motorway', '#e892a2',
  'trunk', '#f9b29c',
  'primary', '#fcd6a4',
  'secondary', '#f7fabf',
  '#ffffff',
]
const ROAD_CASING_COLOR = [
  'match',
  ['get', 'class'],
  'motorway', '#dc2a67',
  'trunk', '#c84e2f',
  'primary', '#a06b00',
  'secondary', '#707d05',
  '#8f8f8f',
]
const PAINT_OVERRIDES: Record<string, Record<string, unknown>> = {
  background: { 'background-color': '#f2efe9' },
  landcover_wood: { 'fill-color': '#add19e', 'fill-opacity': 0.9 },
  landcover_grass: { 'fill-color': '#cdebb0', 'fill-opacity': 0.8 },
  water: { 'fill-color': '#aad3df' },
  waterway_tunnel: { 'line-color': '#aad3df' },
  waterway_river: { 'line-color': '#aad3df' },
  waterway_other: { 'line-color': '#aad3df' },
}
for (const prefix of ['road', 'bridge']) {
  for (const kind of ['motorway', 'trunk_primary', 'secondary_tertiary', 'motorway_link', 'link']) {
    PAINT_OVERRIDES[`${prefix}_${kind}`] = { 'line-color': ROAD_COLOR }
    PAINT_OVERRIDES[`${prefix}_${kind}_casing`] = { 'line-color': ROAD_CASING_COLOR }
  }
}
for (const prefix of ['road', 'bridge', 'tunnel']) {
  for (const kind of ['major_rail', 'major_rail_hatching']) {
    PAINT_OVERRIDES[`${prefix}_${kind}`] = { 'line-color': '#707070' }
  }
}

// Our own hillshade replaces Liberty's low-zoom Natural Earth relief.
const BASE_LAYERS = (libertyStyle.layers as unknown as maplibregl.LayerSpecification[])
  .filter((layer) => layer.id !== 'natural_earth')
  .map((layer) => {
    const paint = PAINT_OVERRIDES[layer.id]
    return paint
      ? ({ ...layer, paint: { ...layer.paint, ...paint } } as maplibregl.LayerSpecification)
      : layer
  })

/** Basemap layer ids — hidden while satellite imagery is showing. */
export const BASEMAP_LAYER_IDS = BASE_LAYERS.map((layer) => layer.id)

/** Every font stack any label uses — basemap and our own layers alike. */
export const MAP_FONTSTACKS = [
  ...new Set([
    'Noto Sans Regular',
    ...BASE_LAYERS.flatMap((layer) => {
      const font = (layer.layout as { 'text-font'?: unknown } | undefined)?.['text-font']
      return Array.isArray(font) ? [font.join(',')] : []
    }),
  ]),
]

// Satellite sits right above the background; the hillshade goes over the land
// fills but under water, roads and labels.
const [background, ...rest] = BASE_LAYERS
const reliefAt = rest.findIndex((layer) => layer.id === 'waterway_tunnel')

export const MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: GLYPHS_URL,
  sprite: SPRITE_URL,
  sources: {
    openmaptiles: { type: 'vector', url: TILEJSON_URL },
    satellite: {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
    },
    // AWS open elevation tiles (terrarium encoding) for 3D terrain and hillshade.
    terrain: {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      encoding: 'terrarium',
      tileSize: 256,
      maxzoom: 14,
      attribution: 'Terrain: Mapzen/AWS Open Data',
    },
  },
  layers: [
    background,
    { id: 'satellite', type: 'raster', source: 'satellite', layout: { visibility: 'none' } },
    ...rest.slice(0, reliefAt),
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'terrain',
      paint: { 'hillshade-exaggeration': 0.35 },
    },
    ...rest.slice(reliefAt),
  ],
}
