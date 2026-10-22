import type maplibregl from 'maplibre-gl'
import darkStyle from './openfreemap-dark.json'

// Basemap: OpenFreeMap's grey-and-black "Dark" style over OpenFreeMap vector
// tiles — free, no API key, commercial use and offline downloads allowed
// (openfreemap.org/tos). The style is a copy of
// https://tiles.openfreemap.org/styles/dark kept in the bundle so it loads
// offline; refresh it by re-downloading that URL. Its design is CC BY 4.0
// (OpenMapTiles), credited by the attribution in the tiles' TileJSON.

/** TileJSON for the vector tiles; its tile URLs carry a weekly build version. */
export const TILEJSON_URL = 'https://tiles.openfreemap.org/planet'
export const GLYPHS_URL = darkStyle.glyphs
export const SPRITE_URL = darkStyle.sprite
/** The only font any label uses — basemap and our own layers alike. */
export const MAP_FONT = 'Noto Sans Regular'

// The stock style is a data-viz backdrop: tracks, FSRs, trails and creeks
// nearly vanish into the background and labels are dim. Lift them for field
// use while keeping the grey-and-black look.
const PAINT_OVERRIDES: Record<string, Record<string, unknown>> = {
  waterway: { 'line-color': '#2e3033' },
  highway_path: { 'line-color': '#4a4a4a' },
  highway_minor: { 'line-color': '#3a3a3a' },
  highway_major_casing: { 'line-color': 'rgba(90,90,90,0.9)' },
  highway_major_subtle: { 'line-color': '#3a3a3a' },
  highway_motorway_casing: { 'line-color': 'rgba(90,90,90,0.9)' },
  highway_name_other: { 'text-color': '#8a8a8a' },
  highway_name_motorway: { 'text-color': '#8a8a8a' },
  place_other: { 'text-color': '#9a9a9a' },
  place_suburb: { 'text-color': '#9a9a9a' },
  place_village: { 'text-color': '#a8a8a8' },
  place_town: { 'text-color': '#b5b5b5' },
  place_city: { 'text-color': '#c2c2c2' },
  place_city_large: { 'text-color': '#c2c2c2' },
}

const BASE_LAYERS = (darkStyle.layers as unknown as maplibregl.LayerSpecification[]).map(
  (layer) => {
    const paint = PAINT_OVERRIDES[layer.id]
    return paint
      ? ({ ...layer, paint: { ...layer.paint, ...paint } } as maplibregl.LayerSpecification)
      : layer
  },
)

/** Basemap layer ids — hidden while satellite imagery is showing. */
export const BASEMAP_LAYER_IDS = BASE_LAYERS.map((layer) => layer.id)

// Satellite sits right above the background; the hillshade goes over the land
// and water fills but under creeks, roads and labels.
const [background, ...rest] = BASE_LAYERS
const reliefAt = rest.findIndex((layer) => layer.id === 'waterway')

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
      attribution: 'Imagery: Esri, Maxar, Earthstar Geographics',
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
