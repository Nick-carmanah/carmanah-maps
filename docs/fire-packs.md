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
   next (`resumeAt`). The phone downloads that way (next PR); the Mac writes
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

## 5. Where this goes next

- **The app** (next PR): "Download this fire" from a live BCWS perimeter, an
  imported polygon or a drawn area. It shows the size before downloading,
  downloads resumably into `maps/_packs/`, and MapLibre reads packs before
  the network. It also has a pack list, works in the embedded build, and
  keeps a small-area path from OpenFreeMap that stays under their caps.
- **Satellite**: one more file per pack (`satellite.pmtiles`, source
  `satellite`), cut the same way from `imagery/…` once that archive exists.
- **Terrain as lossless WebP** would cut terrain by roughly a third. MapLibre
  reads WebP DEM tiles. Not done: the live map uses AWS's PNGs, and both should
  match.
