# Fire packs: offline basemaps for a whole fire

Phase 0.4 of [the rebuild plan](avenza-rebuild-plan.md). Field requirement:
offline areas "however big the fire is" (the biggest BC fires pass
1,000,000 ha), for crews who are offline for hours, sometimes days.

A **pack** is one offline area: a fire perimeter (or any polygon, or a box)
plus a buffer, 5 km by default. It holds the vector basemap and the terrain
for that area, one PMTiles file each, and a `pack.json` that describes it.
On the phone, packs live in the shared pack store `maps/_packs/<packId>/`
(not per person: [owner-data.md](owner-data.md)).

Hosting is in [hosting-r2.md](hosting-r2.md). This page covers the pack
format, how packs are cut, and the builder on the Mac.

---

## 1. What a fire pack weighs

Measured 2026-11-18 against OpenFreeMap's planet build `20261115_080022_pt`
and AWS Terrain Tiles. Basemap sizes are exact (they come from the archive's
index); terrain is sampled. The area is the perimeter plus a 5 km buffer.

| Area | Basemap z6–14 | Terrain z6–12 | Pack |
|---|---|---|---|
| 100,000 ha square, Chilcotin (remote) | 1,094 tiles, 2.0 MB | 108 tiles, 3.3 MB | **5 MB** |
| 100,000 ha square around Kamloops | 1,086 tiles, 5.6 MB | 105 tiles, 4.3 MB | **10 MB** |
| Fire C40983, 2026 (165,909 ha, BCWS perimeter): built | 1,956 tiles, 4.0 MB | 160 tiles, 5.7 MB | **9.8 MB** |
| Fire G80280, 2023 (619,073 ha, historical perimeter) | 8,315 tiles, 9.5 MB | 619 tiles, ~15 MB | **~25 MB** |
| 1,000,000 ha square, Chilcotin | 7,338 tiles, 11.5 MB | 542 tiles, ~15 MB | **~27 MB** |
| 1,000,000 ha square around Kamloops | 7,110 tiles, 16.0 MB | 502 tiles, ~18 MB | **~34 MB** |

So a million-hectare fire is about **30 MB and ~7,700 tiles**: half the
spike's estimate ([native-storage-spike §3.4](native-storage-spike.md#34-what-a-real-fire-pack-weighs)),
because the planet's vector tiles are gzipped and much of BC is sparse. It's
still 2.5× OpenFreeMap's 3,000-tile cap for in-app downloads, so whole-fire
packs come from our own bucket.

The **BC-wide archives** the phones cut from (BC plus a margin,
`scripts/packs/areas/bc.geojson`): basemap z0–14 is 802,404 tiles,
**1.24 GB**; terrain z0–12 is 51,667 tiles, **~2.1 GB**. Together ~3.4 GB:
inside R2's free 10 GB.

---

## 2. How a pack is made

Both the phone and the Mac cut packs the same way, with the same code
(`src/lib/packs/`):

1. **The area** (`area.ts`). Outer rings of the perimeter (holes, the
   unburned islands, are filled in), simplified to 1/8 of a z14 tile. A tile
   is in the pack if its square touches the perimeter or comes within the
   buffer of it. That's computed exactly at z14, and every lower zoom is the
   parents of those tiles.
2. **The index** (`archive.ts`). Read the source archive's header and root
   directory (16 kB), then only the leaf directories those tiles need: about
   300–450 kB for a fire, 2.7 MB for all of BC, against the planet's 96 MB of
   directories.
3. **The plan** (`extract.ts`). Work out the new file's header and
   directories before fetching any tile:
   - a tile shared by many tile ids (the same blank forest tile, say) stays
     stored once;
   - tiles close together in the source (within 32–128 kB) are fetched in one
     `Range` read, capped at 4–8 MB;
   - a 1M ha fire is 30–45 reads.
4. **The write**. The prefix (header and directories), then each read's
   tiles in order. The file grows only by whole reads, so after a dropped
   connection, the size of the partly written file says which read comes
   next (`resumeAt`). The phone downloads that way (§5); the Mac writes
   `<file>.part` and renames it when complete.

**Terrain.** The phone cuts it from the BC-wide terrain archive like the
basemap. The Mac builder fetches the Terrarium tiles straight from AWS
(z6–12) and packs them with `src/lib/pmtiles-writer.ts`, keeping fetched
tiles in `samples/cache/` so re-runs fetch nothing twice. Terrain stops at
z12: MapLibre stretches z12 hillshade over higher zooms smoothly. z13–14
terrain would add ~0.5 GB to a 1M ha pack.

**Checked against the source.** Cutting fire C40983 from the planet and
reading the result back with the `pmtiles` library: every sampled tile (280
of 1,956) matched the planet's copy byte for byte, and a terrain tile matched
AWS's PNG. Two builds with the same inputs (`--created`, a pinned
`--basemap` build) gave identical sha256 for every file.

---

## 3. `pack.json`

```json
{
  "format": "carmanah-pack",
  "version": 1,
  "id": "c40983-20261118",
  "name": "Pear Lake (C40983)",
  "fireNumber": "C40983",
  "created": "2026-11-18T20:58:49Z",
  "bbox": [-122.22841, 50.85515, -121.19731, 51.52334],
  "bufferKm": 5,
  "perimeter": {"type":"MultiPolygon","coordinates":[…]},
  "areaHa": 165302,
  "files": [
    { "name": "basemap.pmtiles", "source": "basemap", "format": "mvt", "minzoom": 6, "maxzoom": 14,
      "tiles": 1956, "bytes": 4024307, "sha256": "9b1a…", "build": "20261115_080022_pt",
      "from": "https://btrfs.openfreemap.com/areas/planet/20261115_080022_pt/tiles.pmtiles",
      "attribution": "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" },
    { "name": "terrain.pmtiles", "source": "terrain", "format": "png", "encoding": "terrarium",
      "minzoom": 6, "maxzoom": 12, "tiles": 160, "bytes": 5732315, "sha256": "14dc…",
      "from": "aws-terrain-tiles", "attribution": "Terrain: Mapzen/AWS Open Data. …" }
  ],
  "bytes": 9756622,
  "attribution": "…",
  "madeBy": "builder"
}
```

| Field | |
|---|---|
| `id` | Folder name: lower-case letters, digits, `-` (≤ 64). Fire number + date by default. |
| `bbox` | Area covered, buffer included. |
| `perimeter` | The perimeter it was cut around, simplified to ~20 m (null for a box). Lets the app draw the pack's outline. |
| `areaHa` | Hectares inside the perimeter, buffer not included. |
| `files[].source` | Which map source the file feeds: `basemap` (the style's `openmaptiles`), `terrain`, and later `satellite`. |
| `files[].sha256` | Checked after a whole-file download or a copy from another phone. |
| `files[].build` | Data version: the OpenFreeMap planet build. Packs from different builds can sit side by side. |
| `madeBy` | `builder` (Mac) or `app` (cut on the phone). |

The app reads `pack.json` strictly (`parseManifest`): file names that could
leave the pack folder, bad hashes or unknown sources are refused. Unknown
extra fields are ignored, so later versions can add to it.

---

## 4. The builder

On the Mac, from the repo folder, after `npm ci`. Needs Node 22.18+ (it runs
the TypeScript directly); Homebrew's Node 26 is fine. Output goes to
`samples/packs/` (git ignores `samples/`).

```bash
node scripts/packs/build-pack.ts --bcws C40983
```

That takes a fire's **current** BCWS perimeter (the public feature service
the app's live-fire layer uses) plus 5 km. The pack is named from BCWS's
incident name, and it takes about 15 seconds.

Other inputs:

```bash
node scripts/packs/build-pack.ts --perimeter fire.kml --name "Sample Creek" --fire K12345
```

```bash
node scripts/packs/build-pack.ts --bbox=-121.7,50.1,-121.4,50.3 --name "Training area"
```

`--perimeter` takes GeoJSON or KML (polygons; lines and points are
ignored). Older fires aren't in the current-perimeter service. Export their
perimeter from the BC Data Catalogue (historical fire perimeters) and use
`--perimeter`. Write `--bbox=` with the `=`, because the value starts with
a minus sign.

Options:

| Option | Default | |
|---|---|---|
| `--buffer-km` | 5 | Buffer around the perimeter. |
| `--zooms`, `--terrain-zooms` | 6-14, 6-12 | Zoom ranges. |
| `--basemap` | latest | `latest` = the newest finished OpenFreeMap planet build; or an archive URL (e.g. our BC archive) or a local file. |
| `--terrain` | aws | `aws` = fetch AWS Terrain Tiles; or a Terrarium PMTiles URL/file to cut from. |
| `--created` | now | Fixes the timestamp for reproducible output. |
| `--id`, `--name`, `--fire` | from input | |
| `--out` | samples/packs | |
| `--measure` | | Sizes and tile counts only. Reads the index, downloads no tiles (~8 s, even for all of BC). |

### The BC-wide archives

```bash
node scripts/packs/build-pack.ts --area bc
```

This cuts `basemap/bc/<build>.pmtiles` (1.24 GB) from the newest planet
build, plus `terrain/bc/v1.pmtiles` (~2.1 GB, 51,667 AWS tiles; built once
and kept). It writes them under `samples/packs/area-bc/`, laid out as their
bucket keys, with a `sources.json` for the catalog. The basemap is about
360 reads of the planet file, about 1.25 GB of downloading.

Refresh the basemap monthly in fire season. The terrain never changes, so
later runs keep the terrain file that's already there.

### Publishing

```bash
node scripts/packs/publish.ts --area samples/packs/area-bc
```

```bash
node scripts/packs/publish.ts --pack samples/packs/c40983-20261118
```

Files go up first, `catalog.json` last, through `upload.ts` (rclone, Nick's
own credentials; see [hosting-r2.md §4](hosting-r2.md#4-rclone-on-the-mac)).
`--remove-pack <id>` takes a pack out of the catalog. Add `--to samples/bucket` to
publish into a local folder instead, for `npm run packs:serve`.

**Ready-made packs** under `packs/` are optional. Phones can cut any area
from the BC archives themselves. Ready-made packs suit a fire many crews
will download (the CDN caches files under 512 MB), and a file to hand to
someone over AirDrop.

---

## 5. In the app

**Offline maps** (the button above the map's bottom-right corner, in the
website and the crew app alike) opens a sheet with the packs on this phone
and **Download an area**:

- **A fire**: a live BCWS fire perimeter (Layers → Live fires on), nearest
  to the map first.
- **My area**: any area in My Data, drawn or imported (KML/KMZ/shapefile
  perimeters land there).
- **This view**: what's on screen.

Each takes a buffer of 0, 2, 5 (the default) or 10 km. **Check size** plans
the cut from the bucket's archives, reading their index only, and shows the
exact size and tile count before anything downloads. For C40983 that's
"9.8 MB · 2,116 tiles". **Download** runs in the background of the page:

- **Resumes.** Files are written as `<name>.part`, one Range read (≤ 2 MB) at
  a time. A dropped connection waits and retries ("Waiting for signal…"),
  and comes back early when the phone says it's online. A download running
  when the app closed carries on by itself at the next start; a paused one
  waits for **Resume**. After a restart it re-reads the index (pinned to the
  archive's ETag) and the `.part` file's size says where to carry on.
- **Checks.** Every read must be a 206 with the exact bytes and the same
  ETag; a replaced archive stops the download with a clear message instead
  of mixing builds. Each finished file is read back from storage and hashed
  (sha256). A ready-made pack's hash must match its `pack.json`; a cut's hash
  is recorded in the phone's `pack.json`. Then `.part` is renamed into place,
  and `pack.json` is written last.
- **Where.** `maps/_packs/<packId>/` through the shared pack store
  (`openSharedPackFiles()` in `src/lib/storage/files.ts`): Capacitor
  Filesystem `LibraryNoCloud` in the crew app, OPFS on the website (Chrome,
  Firefox, Safari 26+). Website storage is best-effort and the sheet says so;
  it asks the browser to keep it (`navigator.storage.persist()`).
- **Ready-made packs** in the catalog are listed under **Ready-made** and
  download whole the same way.
- **No bucket, or outside it**: small areas (≤ 3,000 basemap tiles) still
  save, tile by tile from OpenFreeMap (4 at a time, within its terms) and AWS,
  into a pack the same shape. This is how the app works until
  `VITE_PACKS_URL` points at the bucket.

Each pack shows its size and date, with **Show** (fit the map to it) and
**Delete**.

**Reading packs** (`src/lib/packs/protocol.ts`, `registry.ts`). The style
keeps its normal network URLs. MapLibre's `transformRequest` sends a tile to
the `carmanah-pack://` protocol when a pack's bounds and zooms cover it, with
the network URL as the fallback. The protocol reads the newest pack that has
the tile, else fetches the network URL. With no packs nothing changes. The
basemap's TileJSON always goes through the protocol. Online it's fetched
and a copy is kept (shared IndexedDB). Offline the protocol uses that copy,
or builds one from the newest pack's planet build. So the basemap starts
offline even in the crew app, which has no service worker of ours.
Elevation (`src/lib/elevation.ts`) and "Send this area as a map"
(`src/map/print-render.ts`) read packs too.

Terrain in the live style now stops at z12 (`src/map/basemap.ts`), like the
packs, and MapLibre stretches it above that. So hillshade looks the same
with and without signal, and online use drops (z13–14 terrain tiles average
~110 kB).

The old tile-by-tile "Save offline" into the service worker's cache is
retired from the map (`downloadMapPack` in `src/lib/mappacks.ts` is no
longer called). Areas saved that way before still show offline on the
website: the service worker keeps serving them.

### Build setting

`VITE_PACKS_URL` is the bucket's public base URL, e.g.

```bash
VITE_PACKS_URL=https://pub-XXXX.r2.dev/ npm run build:embedded
```

Unset (as today), the app offers small areas only.

### Verified (2026-11-18)

Against a local stand-in for R2 (`npm run packs:serve`, same ranges, ETags
and CORS, throttled to field speeds). It held a 2,032,587 ha "Cariboo" cut
of the planet (basemap 22.4 MB, terrain 32 MB, built with
`--area <file>.geojson`) and the ready-made C40983 pack. Results are in the
fire-packs PR.

- **Website build, headless Chrome.**
  1. "A fire" → C40983 → Check size: 9.8 MB · 2,116 tiles.
  2. Killed the bucket at 20%: "Waiting for signal… 20%". Brought it back,
     and the download carried on.
  3. Reloaded the app at 66%: it carried on by itself at 67%.
  4. Both files in OPFS matched their sha256.
  5. Relaunched Chrome with every internet host unresolvable, and the bucket
     and web server stopped. The app started from its service worker and drew
     the fire at z9.5, z12.5 and z14.6 from the pack, hillshade included. The
     service worker's own tile cache had been emptied first.
- **iOS simulator, native store** (`native-harness/`, embedded build, iOS
  27.2).
  1. Same fire, same size shown.
  2. Bucket killed at 28%; the app terminated at 57%. Relaunched, it carried
     on from the `.part` file (67% six seconds later).
  3. `Library/NoCloud/maps/_packs/c40983-20261118/` held `basemap.pmtiles`,
     `terrain.pmtiles` and `pack.json`, both sha256 right, no `.part` or
     `job.json` left.
  4. A copy of the page whose Content-Security-Policy allows no http(s) at
     all drew the fire at z9.5–14.5 from the pack. Its only blocked requests
     were the TileJSON's network try and terrain for the start view, which
     lies outside the pack.

## 6. Where this goes next

- **Satellite**: one more file per pack (`satellite.pmtiles`, source
  `satellite`), cut the same way from `imagery/…` once that archive exists.
- **Background downloads** in the crew app (the download pauses while the
  app is in the background and carries on when it's back) would need
  `@capacitor/file-transfer`, a crew-app change
  ([spike §6](native-storage-spike.md#6-specs-for-the-carmanah-app-master-crew-app-mobile)).
- **Free space**: the sheet doesn't check it before a download (Filesystem
  can't report it; `@capacitor/device` could). A full disk fails the write,
  and the download stops with that message.
- **Terrain as lossless WebP** would cut terrain by roughly a third. MapLibre
  reads WebP DEM tiles.
- **Sharing a pack** phone to phone (AirDrop/Quick Share) and importing one:
  the files and `pack.json` with its sha256 are ready for it.
