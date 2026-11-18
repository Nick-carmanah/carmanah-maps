# Avenza rebuild: audit and plan

Written 2026-11-17 from (a) a read-through of this codebase as it stands on
`main` (ba81284) plus the uncommitted basemap work, and (b) every article in
Avenza's Complete Documentation (Getting Started, Map View Basic Tools,
Creating/Managing Map Features, Location Tools, Settings, Tutorials — ~45
articles). FEATURES.md remains the line-item tracker; this doc is the
strategy, the honest state of things, and the order of work.

Legend: ✅ solid · 🟡 partial or fragile · ⬜ missing · ➖ deliberately skipped

---

## 1. Where we actually stand

**Solid and verified in-browser:** offline PWA shell; KML/KMZ/GPX/zipped-SHP
import; QR → KML; live BCWS points + perimeters; pins with NWCG + fire-ops
symbols, photos, key/value attributes; draw & measure → saved lines/areas;
GPS track recording with stats + convert-to-area; navigate-to-feature
(straight line, bearing, ETA); geofences on features (foreground);
DD/DDM/DMS/UTM/MGRS readout and search; metric/imperial; UTM grid overlay;
satellite toggle; auto-layers + per-layer KMZ share with photos; GeoPDF
import (ISO-32000 style — see the fix note below).

**Fragile or partial — these matter for Avenza interop:**

| Area | Problem |
|---|---|
| GeoPDF import | **Fixed 2026-11-17 (uncommitted):** now parses the PDF structure with pdf-lib, so key order, compressed object streams and Acrobat re-saves don't matter — a treatment-unit map from ArcMap 10.7, re-saved in Acrobat, failed before and works now. Same fix corrected a shipped bug: every Esri GeoPDF imported since July rendered **upside-down** (ArcGIS writes the viewport box top-first; we assumed bottom-first). Imports made before the fix need re-importing. Still missing: TerraGo-style GeoPDFs (USGS topos, `LGIDict`). |
| GeoPDF quality | Stores one 2200 px PNG crop. Gets blurry when zoomed in; Avenza renders at 72/150/300 DPI on import. The original PDF isn't kept, so we can't re-render or re-share it. |
| Multi-page PDFs | Imports every georeferenced page; no page picker. |
| KMZ import | Reads `doc.kml` only — embedded photos and custom icons in `files/` are dropped. An Avenza KMZ with photos arrives without them. |
| Imported layers | KML/GPX/SHP imports become **read-only overlays**, a separate world from "My Data". You can't edit, move, re-symbolize, or re-share an imported Avenza layer as your own. |
| Attributes | Free-form key/value. Exported as KML `<Data>`, not `<Schema>/<SchemaData>`, so Avenza won't see them as a schema. No types, no picklists, no per-layer schema. |
| Layers | A layer is just a string on each feature. No sublayers, no active layer, no lock, no per-layer default style. Visibility toggles aren't saved across reloads. |
| Placemarks | Can't drag to move, can't type exact coordinates, no elevation. |
| Drawing | Tap-to-place vertices. Avenza places vertices at the crosshair, which is far more precise with a gloved finger. No circles, no course-and-distance drawing. |
| Navigation | Straight line to a point only. No routes, no navigate-along-a-track, no project-a-point by bearing + distance, no arrival alert. |
| Orientation | No device compass, course-up, orientation lock, or true/magnetic north. |
| Backup | Everything lives in browser storage only. iOS can evict PWA storage; clearing Safari data wipes it. No export-everything / restore. |
| Known bug | Coordinate readout lags the crosshair ~15 m after a pan (no `moveend` update). Fix existed in 45e6655, reverted with the basemap commit. |

**Pending, uncommitted:** OpenFreeMap "Liberty" vector basemap recoloured to
the OSM look + vector offline packs (basemap.ts, mappacks.ts, vite.config.ts,
MapView.tsx). Waiting on Nick's go-ahead. The current raster OSM tiles break
openstreetmap.org's bulk-download policy, so this should land before any
wider rollout.

---

## 2. Avenza feature map vs. us

Status reflects §1. "PWA?" = can a web app do it; anything marked Native
needs the Capacitor wrap.

### Maps (custom imported maps)

| Avenza | Us | PWA? | Notes |
|---|---|---|---|
| Geospatial PDF (ISO 32000) | 🟡 | yes | Harden parser (pdf-lib), keep original, render crisp tiles |
| TerraGo GeoPDF (LGIDict) | ⬜ | yes | Same parser upgrade |
| Multi-page PDF with page picker | 🟡 | yes | |
| GeoTIFF | ⬜ | yes | geotiff.js + proj4 for non-WGS84 rasters (BC Albers, UTM) |
| JPG + world file (TFW/JGW + PRJ/WKT in a zip) | ⬜ | yes | Same path as GeoTIFF |
| GeoPackage raster + vector (Pro) | ⬜ | yes | sql.js (SQLite in WASM). This is Avenza Pro's "Maps + Layers" share format |
| Import from URL / QR / `avenzamaps://` link | 🟡 | yes | We have QR + `?kml=`. Add paste-a-URL and `?map=` for PDFs |
| Map info (projection, size, date) | 🟡 | yes | |
| Export/share a custom map back out | ⬜ | yes | Needs the original file kept |
| Library: folders, collections, sort/filter | ⬜ / ➖ | yes | Folders yes. Collections (auto-switch between adjacent maps) don't apply — our basemap is seamless |
| Map Store | ➖ | — | Our counterpart: live BCWS data + curated fire map packs |
| OSM basemap + offline region download | ✅ | yes | Vector version pending (§1) |
| Map types: light, dark, satellite | 🟡 | yes | Streets + satellite; add a dark style |

### Features and layers

| Avenza | Us | PWA? | Notes |
|---|---|---|---|
| Placemarks with symbol, name, notes, photos | ✅ | yes | |
| Drag to reposition, edit coordinates, fetch elevation | ⬜ | yes | Elevation from our terrain tiles |
| Lines, areas, circles; crosshair vertex placement | 🟡 | yes | |
| Draw by course and distance | ⬜ | yes | Also covers the workshop's "shoot a bearing, draw the line" |
| GPS tracks with pause/resume | 🟡 | partly | No pause yet. Background recording = Native |
| Plot photos (geotagged → placemarks) | ⬜ | yes | EXIF GPS; Avenza files these into a "Photo Library" layer |
| Plot GPS average (manual / timer / fix count) | ⬜ | yes | Pro feature in Avenza |
| Layer tree: sublayers, active layer, lock, default style | ⬜ | yes | Core of Nick's master/day/specialty layer workflow |
| Move features between layers | ⬜ | yes | |
| Typed attribute schema per layer (string, boolean, real, integer, picklists) | 🟡 | yes | |
| Import/export schema only | ⬜ | yes | |
| Symbol sets: built-in, import `.avenzasymbols` / KML sets, toggle symbols | 🟡 | yes | NWCG set bundled; in-app import missing |
| Labels/callouts toggle, placemark size, clustering | ⬜ | yes | |
| Search: my features, OSM places, coordinates | 🟡 | yes | OSM place search missing (Nominatim, online only) |

### Import/export of features

| Format | Avenza import | Avenza export | Us import | Us export |
|---|---|---|---|---|
| KML / KMZ (+ schema, photos, icons) | ✅ | ✅ | 🟡 no photos/icons/schema | 🟡 no Avenza-style schema |
| GPX | ✅ | ✅ | ✅ | ✅ |
| CSV (placemarks) | — | ✅ | ⬜ | ✅ |
| Shapefile (zip) | ✅ Pro | ✅ Pro | ✅ | ⬜ |
| GeoPackage | ✅ Pro | ✅ Pro | ⬜ | ⬜ |
| Export options: pick features, schema only, photo size, tracks → lines | | ✅ | | 🟡 per-layer only |
| Import options: import as geofences, schema only, lock on import | ✅ | | ⬜ | |
| Full backup `.ambackup` | | ✅ | ⬜ | ⬜ (we need our own backup regardless) |

### Location, navigation, settings

| Avenza | Us | PWA? | Notes |
|---|---|---|---|
| GPS info panel: speed, altitude, accuracy | 🟡 | yes | |
| Compass heading, course-up, lock orientation, true/magnetic | ⬜ | yes | DeviceOrientation API (iOS asks permission once) |
| Navigate to feature / along track / to coordinates / project destination / routes | 🟡 | yes | Point only today |
| Navigation settings: visit each point in turn, arrival radius | ⬜ | yes | |
| Geofences: features, map boundary, on import, enter/leave/both | 🟡 | partly | Foreground only in a PWA; background = Native |
| External Bluetooth GPS (Bad Elf, Emlid, Trimble…) | ⬜ | partly | iOS: receivers that feed system location already work in our PWA. Android: mock-location apps work; direct Bluetooth = Native |
| Coordinate formats incl. easting/northing in the map's projection | 🟡 | yes | Add BC Albers (EPSG:3005) — useful in BC. ➖ BNG, ➖ what3words (paid API) |
| Units: per-metric custom incl. chains, nautical, mils | 🟡 | yes | Chains matter for BC forestry |
| Display: theme, crosshair/selection/nav-line/location colours, haptics | 🟡 | yes | |
| Map view: keep screen on, scale bar, zoom limits | 🟡 | yes | |
| Notification centre | ➖ | | Toasts are enough for now |

---

## 3. Interop with Avenza

### Avenza → Carmanah Maps

What Avenza can actually hand you, and what we need for each:

| Arrives as | When | Status | Work |
|---|---|---|---|
| Georeferenced `.pdf` | Someone shares/exports a custom map. Avenza exports it **in the format it was imported in**, so it's whatever ArcGIS/QGIS/TerraGo produced | 🟡 | Robust parser (compressed objects, LGIDict, multiple viewports), keep original, crisp tiled render, page picker |
| `.tif` / `.tiff` | Map was imported as GeoTIFF | ⬜ | geotiff.js + proj4 |
| `.zip` with JPG + world file | Map was imported that way | ⬜ | Same path |
| `.gpkg` | Pro export of "Maps + Layers" together | ⬜ | sql.js: raster tiles → map, features → editable layers |
| `.kmz` | Layer export, especially with photos | 🟡 | Read `files/` (photos + icons), Avenza schema, folder tree → **editable** layers |
| `.kml` | Layer or schema-only export | 🟡 | Same, plus schema-only import |
| `.gpx` | Tracks/lines/placemarks | ✅ | Keep track timestamps on import |
| `.csv` | Placemarks | ⬜ | Lat/lon column detection |
| `.zip` shapefile | Pro export | ✅ | Bring into editable layers instead of read-only overlay |
| `.ambackup` | Full backup (maps, layers, sublayers, folder structure) | ⬜ | Unknown format until we inspect one. Potentially a one-tap "move everything from Avenza". Custom maps and layers only — never Map Store purchases |
| `.avenzasymbols` | Symbol set | 🟡 | Format already decoded (zip: KML + PNGs). Add in-app import |

Avenza-to-Avenza AirDrop only works iOS-to-iOS with matching versions; it
doesn't help us. Files reach our app through Files/email/Drive today.

**Platform catch:** on iOS a PWA can't appear in the share sheet or as an
"Open in…" target. Someone AirDrops a PDF, it lands in Files, then you
import it in our app. On Android we can add a Web Share Target to the
manifest now so "Share → Carmanah Maps" works. Proper iOS "Open in Carmanah
Maps" needs the native wrap. This is the strongest argument for doing the
Capacitor app sooner.

### Carmanah Maps → Avenza

So crews can hand our data to people still on Avenza: KML/KMZ written the way
Avenza reads it (`<Schema>`/`<SchemaData>` attributes, styles, photos in
`files/`, a folder per layer), GPX for tracks, shapefile and GeoPackage
exports for GIS shops. We don't make maps, so map export = re-sharing an
imported original.

---

## 4. Reverse engineering: how to do it properly

**Do:** use Avenza normally and export real files of every type; we study
the files (that's format analysis for interoperability, and it's how every
GIS tool learned to read KML and GeoPDF). Screenshot its screens and flows so
we match the workflows crews know. Use Avenza's public help docs (done).

**Don't:** decompile or disassemble the app, pull out its bundled artwork or
symbol sets, or touch DRM'd Map Store maps. App licences almost always forbid
decompiling (we couldn't pull Avenza's EULA text to confirm theirs), it's
real legal exposure for a commercial competitor, and it wouldn't give us
anything the exported files don't. Copy behaviour, not code or artwork.

Running Avenza on the Mac (Apple Silicon can run iPad apps) is useful for
generating exports straight onto the computer, but the phone works just as
well.

---

## 5. Build order

Each phase ships on its own. Sizes are rough relative effort.

### Phase A — Interop (Nick's priority)
1. **GeoPDF, done properly** (L). pdf-lib for real PDF object parsing; ISO 32000
   and LGIDict; multi-viewport; keep the original file; render a tile pyramid
   at import (150/300 DPI) served through a MapLibre custom protocol; page
   picker; re-share original. Test against the BCWS ArcMap file, a
   re-compressed copy of it (qpdf object streams), an ArcGIS Pro export, and
   a USGS topo.
2. **Imported layers become real layers** (M). KML/KMZ/GPX/SHP import into the
   same editable model as My Data. KMZ photos and icons restored. Avenza
   schema read.
3. **Avenza-compatible export** (S). Schema/SchemaData, styles, folder per
   layer, photos in KMZ.
4. **GeoTIFF + JPG/world-file** (M). geotiff.js, proj4.
5. **GeoPackage in and out** (M). sql.js, lazy-loaded.
6. **CSV import, paste-a-URL, `?map=` deep link, Android share target** (S).
7. **`.ambackup` import** (?). Sized after inspecting a real one.
8. **Symbol set import** (S). `.avenzasymbols` and KML sets.

### Phase B — Layers and data safety
Layer tree (sublayers, active layer, lock, default style), typed per-layer
schemas with picklists, move between layers, saved visibility, and **our own
backup/restore** (one zip of maps, layers, photos, settings). B can start in
parallel with A2 since they share the data model — do the model first.

### Phase C — Field tools parity
Crosshair drawing, circles, course-and-distance, drag/edit placemarks +
elevation, GPS averaging, plot photos, track pause, navigation (routes, along
track, project destination, coordinates, arrival radius), compass/course-up/
lock orientation, GPS info panel, labels toggle, clustering, keep screen on,
custom units incl. chains, BC Albers coordinates, OSM place search, dark
style, coordinate-lag fix (do that one first — it's tiny).

### Phase D — Native wrap (Capacitor)
Background tracking and geofences, iOS "Open in…"/share-sheet target,
direct Bluetooth GPS on Android, storage that iOS can't evict, App Store.
Same codebase.

### Not rebuilding
Map Store, collections, what3words, British National Grid, Avenza accounts
and subscriptions, notification centre.

---

## 6. How work lands

- One **master session** ("Carmanah Maps — Master") owns this plan and
  `main`. It doesn't write feature code itself.
- Every PR-sized piece of work runs in its **own session and worktree**,
  started from the master with a brief, on its own branch, ending in a PR.
- Every PR must pass **PR check** (typecheck + production build). The master
  reviews the diff before recommending a merge.
- **Nick approves every merge.** Merging to `main` deploys the live app.
- Real maps and Avenza exports go in `samples/` (gitignored). Never commit
  them: this repo is public and some maps are marked internal. Keep client
  and project names out of commits, PRs and docs.

## 7. What we need from Nick

Real Avenza exports, kept local in a gitignored folder — never committed
(this repo is public, and some maps are marked internal):

1. A layer with a few placemarks (different symbols, photos, attributes from a
   schema), a track, a line, an area → exported as **KMZ**, and also KML,
   GPX, CSV, and shapefile if Pro.
2. **Schema only** export of that layer (KML).
3. A custom map shared/exported from Avenza (**the PDF**), plus any map that
   was imported as a TIFF.
4. Pro: **Maps + Layers → GeoPackage**.
5. Optional: a **`.ambackup`** (contains all his Avenza data — local only).
6. A newer **ArcGIS Pro** GeoPDF from BCWS, and a USGS/TerraGo topo if handy.
