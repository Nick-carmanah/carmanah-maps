# Avenza Pro Parity Tracker

Target: everything in Avenza Maps **Pro** (their top tier), plus our
wildfire-specific features. Sources: Avenza app-features, pro-features, and
compare-plans pages (fetched 2026-07-11).

Legend: ✅ done · 🟡 partial · ⬜ todo · ➕ ours (no Avenza equivalent)

## Maps & basemaps

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Offline maps | Free | ✅ | Save-offline view packs (z6–14) + SW tile cache |
| Basemap layers (satellite) | Plus | ⬜ | Add satellite/imagery basemap toggle (needs licensed source, e.g. ESRI World Imagery or Sentinel-2) |
| 3D terrain / hillshade | — | ➕ ✅ | Beyond Avenza — terrain toggle + hillshade |
| Map store / catalogue | Free | ⬜ | Our version: curated wildfire map-pack library (PMTiles regions) |
| Organize maps in folders/collections | Free | ⬜ | Layer panel folders |
| Import KML/KMZ | Free | ✅ | Button, drag-drop, QR scan, ?kml= deep link |
| Import GPX | Free | ✅ | Same import path as KML |
| Import GeoTIFF | Pro (unlimited) | ⬜ | Client-side: geotiff.js → canvas source; large files need server tiling |
| Import geospatial PDF / GeoPDF | Pro (unlimited) | ⬜ | Server-side GDAL conversion → tiles (v1) |
| Import JPG + reference file | Pro | ⬜ | Low priority |
| Shapefile import | Pro | ⬜ | shpjs client-side |
| Layer visibility management | Free | ✅ | Layer panel show/hide |

## GPS, navigation & orientation

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Real-time GPS position on map | Free | ✅ | Geolocate control w/ tracking |
| Record GPS tracks (distance/time/speed/elevation) | Free | ✅ | Foreground recording w/ wake lock, live stats chip; background tracking needs Capacitor (v2) |
| Convert tracks to areas | Pro | ✅ | Save-as-area in the stop/review step |
| Navigation/path tools (navigate to placemark: bearing, distance, ETA) | Free | ⬜ | Compass-style nav overlay |
| Map rotation & compass | Free | 🟡 | Rotation works (drag/ctrl); needs device-compass north-up toggle on mobile |
| Map orientation lock | Pro | ⬜ | Lock north-up / track-up |
| Coordinate search (go to coordinates) | Free | ⬜ | Search box accepting lat/lon, UTM |
| Map feature search (POI) | Free | ⬜ | Search imported features + gazetteer |
| Coordinate formats: DD/DMS/UTM | Free | ⬜ | Coordinate readout + format switcher |
| MGRS / BNG grids | Pro | ⬜ | MGRS matters for interagency; BNG skip (UK-only) |
| what3words | Free | ⬜ | Optional; API-based, defer |
| Measurement units switching | Free | 🟡 | Metric only; add imperial/nautical toggle |

## Plotting & data collection

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Placemarks (drop/edit/move/color/notes) | Free | ✅ | Pin button → tap map → edit sheet (name/notes/color); move pending |
| Draw & save lines and areas | Free | ✅ | Measure sketch → Save line / Save area |
| Measure distance & area | Free | ✅ | Geodesic km + hectares |
| Geotagged photos on placemarks | Free | ⬜ | Camera/photo picker → IndexedDB blob, EXIF loc |
| Attribute schema management (custom fields) | Free/Pro | ⬜ | Per-layer field definitions; fire-ops presets |
| Custom symbol sets | Pro | ⬜ | Ship fire-ops symbols built-in (drop point, helispot, safety zone, escape route, guard, division break…) |
| Customize symbols/colors per feature | Free | 🟡 | Color swatches done; symbol choice todo |
| Geofences on features | Pro (unlimited) | ⬜ | Entry/exit alerts; escape-route trigger points |
| Geofences on layers / map boundaries / global alerts | Pro | ⬜ | After feature geofences |

## Sharing & export

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Export KML | Free | ✅ | My Data → KML (xmllint-validated) |
| Export GPX | Free | ✅ | Waypoints + tracks |
| Export CSV | Free | ✅ | Name/kind/coords/measurement/notes |
| Shapefile export | Pro | ⬜ | For agency GIS shops |
| Share map features (link/file) | Free | 🟡 | OS share sheet w/ download fallback; ?kml= link sharing todo |
| Map distribution to teams | Pro | ⬜ | Carmanah account layer sync (v1.5) |
| Subscription/org management | Pro | ⬜ | Later, with Carmanah auth |

## Wildfire-specific (ours)

| Feature | Status | Notes |
|---|---|---|
| Live BCWS fire points + perimeters, status-colored, offline-cached w/ age | ✅ | |
| QR scan → fire KML in one step | ✅ | Camera needs real-device test |
| NASA FIRMS hotspots | ⬜ | v1.5 |
| FWI / fire danger layers | ⬜ | v1.5 |
| Radio repeater overlay from Carmanah app | ⬜ | v1.5 |
| Photos/placemarks into Carmanah forms | ⬜ | v1.5 |

## Suggested build order (v1 parity push)

1. ~~Placemarks~~ ✅
2. ~~Save drawn lines/areas + GPX import~~ ✅
3. ~~Export KML/GPX/CSV~~ ✅ (share links todo)
4. ~~GPS track recording + convert-track-to-area~~ ✅ (foreground; background = v2/Capacitor)
5. **Coordinate readout/search** (DD/DMS/UTM, then MGRS) + units toggle.
6. **Navigate-to-placemark** + compass/orientation modes.
7. **Geotagged photos**, **attribute fields**, **fire-ops symbol set**.
8. **Geofences** (feature → layer → boundary).
9. **Satellite basemap**, **feature search**, **folders**.
10. **GeoTIFF/shapefile import**, **shapefile export**, GeoPDF via server (v1).
