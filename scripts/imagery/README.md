# Satellite imagery build (Sentinel-2 → PMTiles)

These scripts build the app's own satellite basemap, Copernicus Sentinel-2 for
BC, as **one PMTiles file** of WebP tiles at zoom 0–13. The file is hosted on R2
([docs/hosting-r2.md](../../docs/hosting-r2.md)) and read by the app with HTTP
Range requests. The reasons for this source are in
[docs/satellite-imagery-options.md](../../docs/satellite-imagery-options.md).
In short, it's the only free source that is recent and clearly allowed offline
and in exported maps.

- **Source:** the [Copernicus Sentinel-2 quarterly cloudless mosaics](https://documentation.dataspace.copernicus.eu/Data/SentinelMissions/Sentinel2.html)
  (STAC collection `sentinel-2-global-mosaics`). Each one is three months of
  Sentinel-2 L2A with clouds removed, at 10 m, in 100 km UTM squares. The build
  uses the red, green and blue bands.
- **Licence:** Copernicus Sentinel data is free, full and open, commercial use
  included. Wherever the imagery appears, it must carry this credit (`year` is
  the mosaic's year):

  > **Contains modified Copernicus Sentinel data 2026**

  The build writes this into the file's metadata (`attribution`). The app's
  map shows it from there, so a new quarter brings its own year.
- **Zoom:** 0–13. At z13 a pixel is 12.5 m at 49°N and 9.6 m at 60°N, which
  matches the 10 m data. A z14 level would have 4× the tiles and no extra
  detail. Past z13 the map enlarges the z13 tiles.

## Setup

Node 22.18 or newer. Node runs the `.ts` files directly.

```bash
npm ci
```

```bash
npm ci --prefix scripts/imagery
```

The second command installs `geotiff` (reads the COG band files by byte
range) and `sharp` (encodes WebP). They're kept out of the app's own
dependencies.

### Copernicus Data Space keys (needed for the real build only)

The mosaic files sit in the Copernicus Data Space S3 store, which needs a
**free account**:

1. Register at <https://dataspace.copernicus.eu> (Copernicus General user).
2. Create S3 keys at <https://eodata-s3keysmanager.dataspace.copernicus.eu>
   and pick an expiry date. The secret is shown once.
3. Put them in your shell environment, not in the repo:

   ```bash
   export CDSE_S3_ACCESS_KEY=…   # in ~/.zshrc or a password manager's CLI
   export CDSE_S3_SECRET_KEY=…
   ```

The scripts read these two variables and nothing else. They never print them
or write them to disk. Each band file is read through a presigned URL, which
carries a signature but not the secret.

Free-account limits: 4 connections at 20 MB/s each, 2,000 requests a minute,
and 12 TB a month ([quotas](https://documentation.dataspace.copernicus.eu/Quotas.html)).
The build stays within them: 4 connections, retries with backoff.

## Build

Run each command from the repo folder.

**Size estimate.** No keys are needed: it counts the tiles and asks the
public catalogue how big the source files are.

```bash
node scripts/imagery/build-satellite.ts --estimate
```

**All of BC, newest quarter.** This needs the keys. Expect a few hours,
mostly reading about 80 GB of band files.

```bash
node scripts/imagery/build-satellite.ts
```

If a run stops, start it again with `--resume` and it carries on from the
tiles already made.

**A small test area without an account.** This uses single Sentinel-2 L2A
scenes from the [AWS Open Data registry](https://registry.opendata.aws/sentinel-2-l2a-cogs/)
instead of the mosaic: same Copernicus data and licence, but one day's
image, not a cloud-free mosaic.

```bash
node scripts/imagery/build-satellite.ts --source aws-l2a --bbox=-121.70,50.17,-121.45,50.33 --name lytton
```

Options:

| Option | Default | |
|---|---|---|
| `--source` | `cdse` | `cdse` (quarterly mosaic) or `aws-l2a` (single scenes, testing) |
| `--area` / `--bbox=w,s,e,n` + `--name` | `bc` | BC is the Natural Earth outline (`bc-boundary.geojson`, public domain) plus 10 km |
| `--quarter` | `latest` | e.g. `2026-Q3` |
| `--fill-quarters` | `1` | earlier quarters that fill pixels the main one never saw clearly (read only for tiles with gaps) |
| `--dates`, `--max-cloud` | Jul–Sep 2026, 5 % | `aws-l2a` only |
| `--max-zoom` | `13` | |
| `--format`, `--quality` | `webp`, `80` | `jpeg` has no transparency at the BC edge |
| `--out` | `samples/bucket` | a local copy of the bucket (git ignores `samples/`) |
| `--concurrency` | 4 (cdse), 8 | HTTP connections |
| `--cache-mb` | 1500 | decoded band blocks kept in memory |

Output goes to `samples/bucket/`, a local copy of the R2 bucket
([docs/hosting-r2.md](../../docs/hosting-r2.md)):

- **The file**, at the key it will have in the bucket:
  `imagery/<product>/<area>/<period>.pmtiles`. For example
  `imagery/s2-quarterly/bc/2026-q3.pmtiles`; test builds use product
  `s2-l2a` and the scene date as the period.
- **Its entry in `catalog.json` → `sources.imagery`**, the same shape as the
  basemap and terrain entries: `area`, `product`, `period`, `url`, `bounds`,
  `minzoom`, `maxzoom`, `bytes`, `format`, `attribution` and `licence`.
  The bucket's `LICENSE.txt` points to this entry for each imagery file's
  credit. A new build replaces the entry for the same area and product and
  leaves everything else in the catalog alone.

The file is a clustered PMTiles v3: tiles in tile-id order, about 9 KB
each, with no tile or directory compression. So the fire-packs code can cut
a fire's area out of it on the phone with Range reads, as it does for the
basemap and terrain.

## How it works

1. **Find the imagery** (`lib/sources.ts`): a STAC search for the mosaic
   squares that touch the area.
2. **Walk the tile pyramid** (`build-satellite.ts`) from z0 down, skipping
   tiles outside the area (`lib/area.ts`).
3. **Draw each z13 tile** (`lib/render.ts`) from the UTM band files:
   - Each pixel goes Web Mercator → lon/lat → UTM, through a 9 × 9 grid of
     exact points.
   - Each pixel is a bilinear sample.
   - Where squares overlap, the one in the pixel's own UTM zone wins, and
     nodata falls through to the next square.
   - `lib/raster.ts` reads the band blocks by byte range and caches them.
4. **Colour** (`lib/stretch.ts`): reflectance 0–0.3 maps to 0–255 with a
   gamma of 1.7, so forest, burns and cutblocks aren't black.
5. **Lower zooms** are 2 × 2 averages of the tiles below, weighted by alpha,
   not resampled from the source.
6. **Write** (`lib/pmtiles-out.ts`): tiles are spooled to disk as they're
   made, then written as a clustered PMTiles v3 file with the app's own
   writer (`src/lib/pmtiles-writer.ts`). Empty tiles are left out.

## Test it in the app

```bash
node scripts/imagery/serve.ts
```

```bash
VITE_SATELLITE_PMTILES_URL=http://127.0.0.1:8790/imagery/s2-l2a/lytton/2026-09-18.pmtiles npm run dev
```

Then choose Satellite and go to Lytton. `serve.ts` answers Range requests
with 206, ETags and CORS, like R2. Once the fire-packs tools are merged,
`npm run packs:serve` does the same for the whole bucket copy.

## Publish

Nothing here uploads. With the fire-packs tools ([docs/hosting-r2.md](../../docs/hosting-r2.md)),
use the commands the build printed, in this order:

1. Upload the file first:

   ```bash
   node scripts/packs/upload.ts "samples/bucket/imagery/s2-quarterly/bc/2026-q3.pmtiles" imagery/s2-quarterly/bc/2026-q3.pmtiles
   ```

2. Then upload the catalog. If the pack builder also keeps a
   `samples/bucket/catalog.json`, it's the same file: the imagery entry is
   added to it.

   ```bash
   node scripts/packs/upload.ts samples/bucket/catalog.json catalog.json
   ```

3. Point the app at the file's public URL with `VITE_SATELLITE_PMTILES_URL`.
   It's a build setting, never in a committed `.env` (the repo is public):
   - **Website:** the `env:` of the build step in
     `.github/workflows/deploy.yml`.
   - **Crew app:**
     `VITE_SATELLITE_PMTILES_URL=https://… npm run build:embedded`
     ([docs/crew-app-handoff.md](../../docs/crew-app-handoff.md) §1).

Each quarter is a new, immutable file. Keep the previous one for a month,
then delete it.
