# Avenza Pro Parity Tracker

Target: everything in Avenza Maps **Pro** (their top tier), plus our
wildfire-specific features. Sources: Avenza app-features, pro-features, and
compare-plans pages (fetched 2026-07-11).

Legend: ✅ done · 🟡 partial · ⬜ todo · ➕ ours (no Avenza equivalent)

## Maps & basemaps

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Offline maps | Free | ✅ | Save-offline view packs (z6–14) + SW tile cache |
| Basemap layers (satellite) | Plus | ✅ | Esri World Imagery toggle; hillshade stays on top; cached offline by SW |
| 3D terrain / hillshade | — | ➕ ✅ | Beyond Avenza — terrain toggle + hillshade |
| Map store / catalogue | Free | ⬜ | Our version: curated wildfire map-pack library (PMTiles regions) |
| Organize maps in folders/collections | Free | ⬜ | Layer panel folders |
| Import KML/KMZ | Free | ✅ | Button, drag-drop, QR scan, ?kml= deep link |
| Import GPX | Free | ✅ | Same import path as KML |
| Import GeoTIFF | Pro (unlimited) | ⬜ | Client-side: geotiff.js → canvas source; large files need server tiling |
| Import geospatial PDF / GeoPDF | Pro (unlimited) | ⬜ | Server-side GDAL conversion → tiles (v1) |
| Import JPG + reference file | Pro | ⬜ | Low priority |
| Shapefile import | Pro | ✅ | Zipped .shp via shpjs (lazy-loaded); attributes preserved; uppercase NAME shown in popups |
| Layer visibility management | Free | ✅ | Layer panel show/hide |

## GPS, navigation & orientation

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Real-time GPS position on map | Free | ✅ | Geolocate control w/ tracking |
| Record GPS tracks (distance/time/speed/elevation) | Free | ✅ | Foreground recording w/ wake lock, live stats chip; background tracking needs Capacitor (v2) |
| Convert tracks to areas | Pro | ✅ | Save-as-area in the stop/review step |
| Navigation/path tools (navigate to placemark: bearing, distance, ETA) | Free | ✅ | Navigate from feature sheet: live distance/bearing/ETA chip + dashed guidance line |
| Map rotation & compass | Free | 🟡 | Rotation works (drag/ctrl); needs device-compass north-up toggle on mobile |
| Map orientation lock | Pro | ⬜ | Lock north-up / track-up |
| Coordinate search (go to coordinates) | Free | ✅ | Pill accepts DD, DMS, UTM, MGRS; flies + drops marker |
| Map feature search (POI) | Free | ✅ | Universal search: My Data + imported KML features + live fires; dropdown for multi-match. Place-name gazetteer later |
| Coordinate formats: DD/DMS/UTM | Free | ✅ | Live center readout w/ crosshair; DDM default (BCWS standard), cycles DD/DDM/DMS/UTM/MGRS, persisted |
| MGRS / BNG grids | Pro | ✅ | MGRS done (UTM math verified ±1 m vs mgrs lib); BNG skipped (UK-only) |
| what3words | Free | ⬜ | Optional; API-based, defer |
| Measurement units switching | Free | ✅ | Metric (m/km/ha) ↔ imperial (ft/mi/ac) in ⚙ settings; converts all readouts + scale bar |

## Plotting & data collection

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Placemarks (drop/edit/move/color/notes) | Free | ✅ | Pin button → tap map → edit sheet (name/notes/color); move pending |
| Draw & save lines and areas | Free | ✅ | Measure sketch → Save line / Save area |
| Measure distance & area | Free | ✅ | Geodesic km + hectares |
| Geotagged photos on placemarks | Free | ✅ | Camera/photo picker per feature; thumbnails + full-screen viewer; blobs in IndexedDB |
| Attribute schema management (custom fields) | Free/Pro | ✅ | Key/value fields per feature; exported as KML ExtendedData + CSV column. Per-layer schemas later |
| Custom symbol sets | Pro | ✅ | Built-in fire-ops set: DP, helispot, safety zone, staging, water, medical, hazard, camp. User-imported sets later |
| Customize symbols/colors per feature | Free | ✅ | Color swatches + symbol picker in edit sheet |
| Geofences on features | Pro (unlimited) | ✅ | Per-feature toggle + radius; entry/exit toast, vibration, system notification; dashed outline on map |
| Geofences on layers / map boundaries / global alerts | Pro | 🟡 | Feature fences unlimited; layer/boundary fences later |

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

## From the Avenza workshop materials (2026-07-11)

Nick's BCWS "Advanced Avenza Workshop" (lesson plan + deck) — insights adopted
or queued. Core thesis: Avenza is a *communication* tool; its failures are all
collaboration failures (uncoordinated per-person maps, "Track 657" naming,
layer/link confusion, OneDrive as a makeshift hub).

| Insight | Status |
|---|---|
| DDM (degree decimal minutes) is the BCWS field standard | ✅ Added to formats + search |
| Naming convention What_When_Where_Who, GIS-safe (no spaces/punctuation) | ✅ Profile (callsign + fire number) auto-names new features, e.g. Edge_JUL11_K61067_2P14 |
| Track colors: red = fire edge, black = machine guard, orange = general | ✅ One-tap track types set color + name; black added to palette |
| "North is up!" — orientation discipline | ⬜ North-lock toggle |
| Slope estimate via rise-over-run for heavy equipment ops | ⬜ We have DEM — auto slope/elevation profile along any drawn line beats manual method |
| Compass bearing deduction ("saw smoke, shoot bearing, draw line") | ⬜ Draw-line-by-bearing tool |
| NWCG Fire Ops symbol set is the standard import | ⬜ Align our symbol set with NWCG glyphs |
| Master/Day/Specialty layers; copy features into layers to share | ⬜ Layer/folder system with an "active day layer" for new features |
| OneDrive/Teams as shared hub; "layer not linked to map" pain | ⬜ Solved properly by Carmanah account layer sync (v1.5) |
| Geofences for airspace management / aviation safety | ✅ Already built |
| Plot drone photos to reconstruct a track | ⬜ EXIF-GPS photo import |

## Suggested build order (v1 parity push)

1. ~~Placemarks~~ ✅
2. ~~Save drawn lines/areas + GPX import~~ ✅
3. ~~Export KML/GPX/CSV~~ ✅ (share links todo)
4. ~~GPS track recording + convert-track-to-area~~ ✅ (foreground; background = v2/Capacitor)
5. ~~Coordinate readout/search (DD/DDM/DMS/UTM/MGRS) + units toggle~~ ✅
6. ~~Navigate-to-placemark~~ ✅ — device-compass / orientation-lock modes still todo (need real device)
7. ~~Geotagged photos, attribute fields, fire-ops symbol set~~ ✅
8. ~~Geofences on features~~ ✅ (layer/boundary fences later)
9. ~~Satellite basemap + feature search~~ ✅ (folders later)
10. 🟡 Shapefile import ✅ — still todo: GeoTIFF import, shapefile export, GeoPDF (server-side)
