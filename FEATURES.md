# Avenza Pro Parity Tracker

Target: everything in Avenza Maps **Pro** (their top tier), plus our
wildfire-specific features. Sources: Avenza app-features, pro-features, and
compare-plans pages (fetched 2026-07-11).

Legend: ✅ done · 🟡 partial · ⬜ todo · ➕ ours (no Avenza equivalent)

## Maps & basemaps

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Offline maps | Free | ✅ | Save-offline view packs (z6–14 vector basemap + terrain, sharp at any zoom) + SW tile cache |
| Basemap layers (satellite) | Plus | ✅ | OSM-style OpenFreeMap vector basemap ↔ Esri World Imagery toggle; hillshade stays on top; cached offline by SW |
| 3D terrain / hillshade | — | ➕ ✅ | Beyond Avenza — terrain toggle + hillshade |
| Map store / catalogue | Free | ⬜ | Our version: curated wildfire map-pack library (PMTiles regions) |
| Organize maps in folders/collections | Free | ✅ | Layer tree with sublayers (imported KML folders keep their nesting); auto-layers by symbol/track type for features still in an automatic layer; move features between layers in the sheet |
| Import KML/KMZ | Free | ✅ | Button, drag-drop, QR scan, ?kml= deep link. Lands in **editable** layers: folders → sublayers, Avenza schemas + picklists and `<Data>` → attributes, styles, KMZ photos and icons restored, gx:Track times kept (docs/avenza-layers.md) |
| Import GPX | Free | ✅ | Editable layer; waypoints, tracks with per-point times, routes |
| Import GeoTIFF | Pro (unlimited) | ⬜ | Client-side: geotiff.js → canvas source; large files need server tiling |
| Import geospatial PDF / GeoPDF | Pro (unlimited) | ✅ | Client-side only, no GDAL/server needed: files with embedded ISO-32000 georeferencing (ArcGIS/ArcMap "include georeference info" exports) parse GCPs with pdf-lib (any key order, compressed object streams, Acrobat re-saves), render via pdf.js, crop to the map region, and drape as a MapLibre image quad. Verified 2026-11-17 on a BCWS thermal-scan hotspot map (ArcMap 10.8), a fuel-treatment unit map (ArcMap 10.7 re-saved in Acrobat), and an object-stream-compressed copy: upright labels, road intersections match OSM, image tilt matches each projection's grid convergence. NB: imports made before this fix (July–Nov 2026) render upside-down — re-import them. Still todo: TerraGo LGIDict, crisp tiled rendering, keep original for re-share. Plain/scanned PDFs with no embedded geo data still need the server-GDAL path (rare in practice — most agency map exports carry it) |
| Import JPG + reference file | Pro | ⬜ | Low priority |
| Shapefile import | Pro | ✅ | Zipped .shp via shpjs (lazy-loaded) into editable layers (one sublayer per .shp); DBF types → typed schema. CSV (lat/lon, DMS, WKT, MGRS, UTM columns detected) and GeoJSON import too |
| Layer visibility management | Free | ✅ | Show/hide per layer and sublayer, saved across reloads |

## GPS, navigation & orientation

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Real-time GPS position on map | Free | ✅ | Geolocate control w/ tracking |
| Record GPS tracks (distance/time/speed/elevation) | Free | ✅ | Foreground recording w/ wake lock, live stats chip; background tracking needs Capacitor (v2) |
| Convert tracks to areas | Pro | ✅ | Save-as-area in the stop/review step |
| Navigation/path tools (navigate to placemark: bearing, distance, ETA) | Free | ✅ | Navigate from feature sheet: live distance/bearing/ETA/speed chip + dashed guidance line; bearings in °/mils, true or magnetic (offline WMM2025) |
| Map rotation & compass | Free | 🟡 | Rotation works (drag/ctrl); needs device-compass north-up toggle on mobile |
| Map orientation lock | Pro | ⬜ | Lock north-up / track-up |
| Coordinate search (go to coordinates) | Free | ✅ | Accepts DD, DDM, DMS (symbols or spaces, hemisphere before/after, signed), UTM (with or without band), MGRS and BC Albers, whatever the display setting; flies + drops marker |
| Map feature search (POI) | Free | ✅ | Universal search: My Data + imported KML features + live fires; dropdown for multi-match. Place-name gazetteer later |
| Coordinate formats: DD/DMS/UTM | Free | ✅ | Live center readout w/ crosshair; DDM default (BCWS standard), DD/DDM/DMS/UTM/MGRS/BC Albers (EPSG:3005), set in ⚙ or cycled on the pill |
| MGRS / BNG grids | Pro | ✅ | MGRS done (UTM math verified ±1 m vs mgrs lib); BNG skipped (UK-only) |
| what3words | Free | ⬜ | Optional; API-based, defer |
| Measurement units switching | Free | ✅ | Avenza-style per-metric units in ⚙: distance (metric/imperial/nautical/chains), area (ha/m²/km²/ac/mi²), coordinates, speed (km/h/mph/kn/m/s), angle (°/mils, true/magnetic north via offline WMM2025), altitude (m/ft), pace (min/km, min/mi). Applies to readout, measure, tracks, navigation, feature sheet (incl. pin elevation from terrain tiles), grid and scale bar |

## Plotting & data collection

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Placemarks (drop/edit/move/color/notes) | Free | ✅ | Pin button → tap map → edit sheet (name/notes/color); move pending |
| Draw & save lines and areas | Free | ✅ | Measure sketch → Save line / Save area |
| Measure distance & area | Free | ✅ | Geodesic km + hectares |
| Geotagged photos on placemarks | Free | ✅ | Camera/photo picker per feature; thumbnails + full-screen viewer; blobs in IndexedDB |
| Attribute schema management (custom fields) | Free/Pro | ✅ | Typed per-layer schema (text, whole number, decimal, yes/no) with pick lists, edited in the layer sheet; per-feature extra fields too. Exported as Avenza `<Schema>`/`<SchemaData>` + `avenza:picklist` |
| Custom symbol sets | Pro | ✅ | Built-in fire-ops set: DP, helispot, safety zone, staging, water, pump, medical, hazard, danger tree, hotspot, structure, beehive, camp. User-imported sets later |
| Customize symbols/colors per feature | Free | ✅ | Color swatches + symbol picker in edit sheet |
| Geofences on features | Pro (unlimited) | ✅ | Per-feature toggle + radius; entry/exit toast, vibration, system notification; dashed outline on map |
| Geofences on layers / map boundaries / global alerts | Pro | 🟡 | Feature fences unlimited; layer/boundary fences later |

## Sharing & export

| Feature | Avenza tier | Status | Notes |
|---|---|---|---|
| Export KML | Free | ✅ | Export sheet: pick layers, KMZ (photos + icons, Avenza layout) or KML; folder per layer, typed schema, style per look |
| Export GPX | Free | ✅ | Waypoints + tracks (with times, or "tracks as lines") |
| Export CSV | Free | ✅ | Placemarks, one column per attribute (like Avenza) |
| Shapefile export | Pro | ⬜ | For agency GIS shops |
| Send this area as a map (georeferenced PDF for Avenza) | — | ➕ 🟡 | Tools → "Send this area as a map": frame a box over the map; Letter/Legal/11×17, portrait/landscape, 150/300 DPI, editable title (fire number + date). Streets basemap + hillshade + every visible layer with its own style (imported layers included, with their KMZ icons) and live fires; UTM grid with edge labels, scale bars and corner coordinates in the chosen units, north arrow, credits. Drawn offline from saved tiles (warns before making it when some aren't saved). ArcGIS-style ISO 32000 georeferencing in Web Mercator; re-imports into this app with 0 m corner error. Shares through the phone's share sheet (AirDrop, Quick Share, Open in Avenza). Satellite is left out: Esri's terms don't allow its imagery in an exported file. Still to confirm in Avenza on a phone |
| Share map features (link/file) | Free | 🟡 | OS share sheet w/ download fallback; ?kml= link sharing todo |
| Map distribution to teams | Pro | ⬜ | Carmanah account layer sync (v1.5) |
| Subscription/org management | Pro | ⬜ | Later, with Carmanah auth |

## Wildfire-specific (ours)

| Feature | Status | Notes |
|---|---|---|
| Live BCWS fire points + perimeters, status-colored, offline-cached w/ age | ✅ | |
| Grid overlay (1 km / 10 km) with MGRS-style cell refs, toggleable; UTM, or BC Albers when coordinates are set to BC Albers | ➕ ✅ | International standard; BCWS lettered ops-grid labels possible if spec found |
| Auto-layers by feature type + per-layer sharing | ➕ ✅ | The danger-tree-assessor → faller workflow |
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
| NWCG Fire Ops symbol set is the standard import | ✅ Full NWCG GeoOps 2022 set (51 official icons) bundled, searchable picker, lazy-loaded, auto-layer per symbol. Generic .avenzasymbols import later |
| Master/Day/Specialty layers; copy features into layers to share | ⬜ Layer/folder system with an "active day layer" for new features |
| OneDrive/Teams as shared hub; "layer not linked to map" pain | ⬜ Solved properly by Carmanah account layer sync (v1.5) |
| Geofences for airspace management / aviation safety | ✅ Already built |
| Plot drone photos to reconstruct a track | ⬜ EXIF-GPS photo import |

## Avenza tutorial audit (2026-07-12)

Walked all 7 official Avenza tutorials (support.avenzamaps.com → Tutorials).
New gaps found, beyond what the parity tables already track:

| Tutorial feature | Status |
|---|---|
| Multi-point routes + navigate *along* a route (compass follows route) | 🟡 We draw/save lines and navigate to a point; no route-following mode |
| Selective export (pick individual features / "Custom" data) | ✅ Per-layer Share (KMZ) + per-layer scoping of all formats |
| KMZ export with photos embedded | ✅ KMZ bundles doc.kml + photos; per-layer or all data |
| GPX track export with timestamps/velocity | ✅ Recorded tracks keep per-point times; exported as <time> |
| GeoPackage import (Pro) | ⬜ gpkg via sql.js or server; low priority |
| Import from web URL (in-app paste) | 🟡 ?kml= deep link exists; add a paste-URL option in Import |
| "Import as geofences" option | ⬜ Auto-arm fences on imported features — great for div boundaries |
| Typed attribute schemas per layer (String/Bool/Real/Int, picklists) + active layer | 🟡 Typed per-layer schemas with pick lists ✅; active layer and lock still todo |
| OSM place-name search (gazetteer) creating a feature | ⬜ Already tracked — confirms it's core Avenza UX |
| Map details panel (publisher, projection, import date) | 🟡 We show feature count + date; fine for now |
| Folders + Collections (auto-transition between adjacent maps) | Folders ⬜ tracked; collections **N/A** — our basemap is seamless, no map-to-map transitions exist |

Where the tutorials show Avenza friction we simply don't have: linking layers
to maps (all our data renders on the one continuous map), per-map
georeferencing checks ("On Map"), custom-map backup warnings (our overlays
persist in IndexedDB and later sync via accounts).

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
10. 🟡 Shapefile import ✅, GeoPDF import ✅ (client-side, no server needed) — still todo: GeoTIFF import, shapefile export
