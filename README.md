# Carmanah Maps

Wildfire-focused offline field mapping. Avenza-class functionality with fire-ops
workflows, built to pair with the Carmanah Wildfire crew platform
(app.carmanahwildfire.com). Target home: **maps.carmanahwildfire.com**.

## What works today (MVP)

- **Map engine** — MapLibre GL JS with a grey-and-black vector basemap
  (OpenFreeMap "Dark", with tracks, FSRs, creeks and labels lifted for field
  use) under terrain hillshade, full **3D terrain** toggle (mountain icon)
  using AWS open elevation tiles.
- **KML / KMZ import** — "Import KML" button or drag-and-drop. Styles (colors,
  line widths) carry over from the KML. Tap any feature for its name/description.
- **Fire QR codes** — "Scan fire QR" opens the camera; scanning a fire's QR code
  (which encodes a URL to its KML) downloads and displays the map in one step.
  Also supports deep links: `/?kml=<url>` imports on open.
- **Live BC fires** — active fire points and perimeters from the BC Wildfire
  Service (CORS-open ArcGIS feature services), color-coded by status (red =
  out of control, orange = being held, green = under control). Cached in
  IndexedDB with a data-age readout so crews know how fresh it is offline.
- **Measure** — tap-to-measure distance (km) and area (hectares) with
  geodesic math; Undo/Done chip.
- **Save offline** — downloads all basemap + terrain tiles for the current
  view (z6–14) plus label fonts and icons into the service-worker tile cache;
  vector tiles stay sharp past z14. Two-tap confirm shows tile count and size
  estimate first. Refuses areas over ~3000 tiles.
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
`http://localhost:5173/?kml=test-fire.kml`

## Deploy

Pushing to `main` deploys to GitHub Pages via
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) (the build uses
base `/carmanah-maps/` in CI, `/` locally). Production home will be
maps.carmanahwildfire.com once DNS is pointed.

## Roadmap

1. **v1 — Avenza parity**: GeoTIFF/shapefile import, geospatial PDF via
   server-side GDAL conversion, regional PMTiles map packs (replacing raw
   tile downloads), drawing/waypoint tools, attribute collection + geotagged
   photos, custom symbol sets, geofences, export (KML/GPX/SHP).
2. **v1.5 — Wildfire + Carmanah**: FWI/danger layers, NASA FIRMS hotspots,
   fire-ops symbol library, shared auth with app.carmanahwildfire.com,
   photos/placemarks into Carmanah forms, radio repeater overlay, KML relay
   endpoint for servers that block in-app downloads (CORS).
3. **v2 — App Store**: Capacitor wrap for iOS/Android — background GPS,
   guaranteed offline storage, push notifications.

## Notes & constraints

- Google Earth imagery can't legally be cached offline; 3D terrain here is
  self-hosted-friendly. KML exports open directly in Google Earth when online.
- The basemap comes from OpenFreeMap's public instance: free, no API key,
  commercial use allowed. Its [terms](https://openfreemap.org/tos/) cap each
  offline download at 3,000 tiles / 50 MB and 4 parallel requests (Save
  offline stays inside both) and ask for a User-Agent naming the app, which a
  web page can't set; a Capacitor build can. If the public instance goes away,
  the same tiles can be self-hosted from their weekly planet downloads with no
  style changes.
- `src/map/openfreemap-dark.json` is a copy of
  https://tiles.openfreemap.org/styles/dark (refresh by re-downloading).
  Tile URLs carry a weekly build version; the service worker and
  `src/lib/mappacks.ts` strip it from cache keys so saved areas keep working
  after it rolls over.
- `src/main.tsx` shims `requestAnimationFrame` with a timer fallback so the map
  keeps loading in backgrounded/embedded tabs.
