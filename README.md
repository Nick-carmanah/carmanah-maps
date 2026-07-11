# Carmanah Maps

Wildfire-focused offline field mapping. Avenza-class functionality with fire-ops
workflows, built to pair with the Carmanah Wildfire crew platform
(app.carmanahwildfire.com). Target home: **maps.carmanahwildfire.com**.

## What works today (MVP)

- **Map engine** — MapLibre GL JS, OpenStreetMap basemap with terrain hillshade,
  full **3D terrain** toggle (mountain icon) using AWS open elevation tiles.
- **KML / KMZ import** — "Import KML" button or drag-and-drop. Styles (colors,
  line widths) carry over from the KML. Tap any feature for its name/description.
- **Fire QR codes** — "Scan fire QR" opens the camera; scanning a fire's QR code
  (which encodes a URL to its KML) downloads and displays the map in one step.
  Also supports deep links: `/?kml=<url>` imports on open.
- **Offline** — imported maps persist in IndexedDB across restarts; visited map
  tiles are cached by the service worker; the app shell is a fully installable
  PWA (production build).
- **GPS** — locate/track position with the geolocate control (needs HTTPS or
  localhost + location permission).
- **Layer panel** — show/hide, zoom-to, and delete imported maps.

## Develop

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # production build + service worker in dist/
```

`public/test-fire.kml` is a mock fire (perimeter, drop points, helispot,
division break) near Lytton BC. Load it with:
`http://localhost:5173/?kml=/test-fire.kml`

## Roadmap

1. **v1 — Avenza parity**: GeoTIFF/shapefile import, geospatial PDF via
   server-side GDAL conversion, downloadable regional map packs (PMTiles),
   draw & measure tools, attribute collection + geotagged photos, custom
   symbol sets, geofences, export (KML/GPX/SHP).
2. **v1.5 — Wildfire + Carmanah**: live BC Wildfire Service perimeters &
   hotspots (timestamped for offline), FWI/danger layers, fire-ops symbol
   library, shared auth with app.carmanahwildfire.com, photos/placemarks into
   Carmanah forms, radio repeater overlay, KML relay endpoint for servers that
   block in-app downloads (CORS).
3. **v2 — App Store**: Capacitor wrap for iOS/Android — background GPS,
   guaranteed offline storage, push notifications.

## Notes & constraints

- Google Earth imagery can't legally be cached offline; 3D terrain here is
  self-hosted-friendly. KML exports open directly in Google Earth when online.
- Basemap tiles currently come from openstreetmap.org (fine for dev; production
  needs its own tile source or map packs — OSM's tile policy disallows heavy
  app traffic).
- `src/main.tsx` shims `requestAnimationFrame` with a timer fallback so the map
  keeps loading in backgrounded/embedded tabs.
