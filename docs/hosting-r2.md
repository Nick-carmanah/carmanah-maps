# Hosting offline map packs on Cloudflare R2

Phase 0.4 of [the rebuild plan](avenza-rebuild-plan.md): offline basemaps for
a whole fire, up to 1,000,000+ ha. This page sets up the storage they're
downloaded from, step by step, and says what goes in it.

**Why we host them.** OpenFreeMap's free tile server allows an app to save at
most **3,000 tiles or 50 MB per download, 4 requests at a time**
([terms](https://openfreemap.org/tos/)). A 1M ha fire needs about 6,100 tiles
and 50–65 MB ([spike §3.4](native-storage-spike.md#34-what-a-real-fire-pack-weighs)).
So we cut the map data once, put it in our own bucket, and phones read it
from there.

**Why R2.** Downloads (egress) are free, it serves byte ranges, and there's
no server of ours to run: the app reads PMTiles files straight from the
bucket with `Range` requests.

---

## 1. What we host, and are we allowed to

| Data | Where it comes from | Terms |
|---|---|---|
| Vector basemap (roads, water, labels…) | OpenFreeMap's **weekly full-planet PMTiles**, `https://btrfs.openfreemap.com/areas/planet/<build>/tiles.pmtiles` (list: [files.txt](https://btrfs.openfreemap.com/files.txt)) | OpenFreeMap publishes these so people can take them elsewhere: "We also provide weekly full planet downloads both in Btrfs, MBTiles and PMTiles formats … allowing you to use the processed planet tiles with any other tool of your choice" ([README](https://github.com/hyperknot/openfreemap#readme)). The 3,000-tile cap and the ban on automated collection in the [terms](https://openfreemap.org/tos/) are about their tile server (`tiles.openfreemap.org`), which we stop using for big areas. The data is © OpenStreetMap contributors under the **ODbL**, tile schema © OpenMapTiles (**CC BY 4.0**). Attribution required: "© OpenMapTiles" and "Data from OpenStreetMap" (README, "Attribution"). Our copies are unchanged ODbL extracts, so we offer them under the ODbL too (`LICENSE.txt` in the bucket says so). |
| Terrain (hillshade, elevation) | [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/), Terrarium PNG, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | AWS Open Data, free to fetch. Licence depends on the source behind each area; in BC that's mainly Canada's CDEM (**Open Government Licence – Canada**) plus SRTM/GMTED (USGS, public domain, credit asked). Credits: [attribution.md](https://github.com/tilezen/joerd/blob/master/docs/attribution.md). |
| Satellite imagery | **Reserved** (`imagery/`) for the satellite work ([options](satellite-imagery-options.md)) | Per product; given in `catalog.json`. |

The app already shows these credits on the map (MapLibre's attribution
button). `scripts/packs/bucket-LICENSE.txt` is uploaded to the bucket as
`LICENSE.txt` so anyone who finds the files knows the terms.

**Courtesy note to OpenFreeMap.** Not required by their terms, but worth a
two-line email to info@openfreemap.org saying we cut a BC extract from the
weekly planet file about once a month for an offline field app, and credit
them. They've asked people with large offline needs to talk to them.

### What it costs

R2's free tier each month: **10 GB stored, 1 million writes (Class A),
10 million reads (Class B), unlimited egress** ([pricing](https://developers.cloudflare.com/r2/pricing/)).
Above that: $0.015/GB-month, $4.50 per million writes, $0.36 per million reads.

| | Size | Notes |
|---|---|---|
| BC vector archive, z0–14 | ~1–2 GB | one per refresh; keep the last 2 |
| BC terrain archive, z0–12 | ~1.5–2 GB | terrain doesn't change; build once |
| One fire pack (ready-made) | 20–150 MB | optional |
| One fire download from a phone | ~50–150 range reads | each read = 1 Class B operation |

Basemap and terrain for all of BC fit in the free 10 GB with room to spare.
Satellite imagery for BC (10–20 GB) would add about $0.15–0.30 a month.
10 million free reads is ~70,000 fire downloads a month.

---

## 2. Bucket layout

One bucket, **`carmanah-maps`**, public read. Everything except
`catalog.json` (and `LICENSE.txt`) is **immutable**: a new build gets a new
name and is never written over, so phones and Cloudflare's cache can keep
files for a year, and a download that resumes after a dropped connection
can't end up with half of one build and half of another.

```
catalog.json                          what the app reads first: which archives and packs exist
LICENSE.txt                           data licences and credits (bucket-LICENSE.txt)
basemap/<area>/<build>.pmtiles        area-wide vector archive, e.g. basemap/bc/20261115_080022_pt.pmtiles
terrain/<area>/<version>.pmtiles      area-wide terrain archive, e.g. terrain/bc/v1.pmtiles
packs/<packId>/pack.json              a ready-made pack: manifest with sha256 per file
packs/<packId>/basemap.pmtiles
packs/<packId>/terrain.pmtiles
imagery/…                             RESERVED for satellite imagery (another workstream):
                                      imagery/<product>/<area>/<period>.pmtiles, e.g. imagery/s2/bc/2026q3.pmtiles
```

Upload headers (set by `scripts/packs/upload.ts` from `scripts/packs/layout.ts`):

| Keys | Content-Type | Cache-Control |
|---|---|---|
| `*.pmtiles`, `packs/*/pack.json` | `application/vnd.pmtiles`, `application/json` | `public, max-age=31536000, immutable` |
| `catalog.json`, `imagery/**/*.json` | `application/json` | `public, max-age=300` |
| `LICENSE.txt` | `text/plain; charset=utf-8` | `public, max-age=3600` |

**How the app uses it.** "Download this fire" takes the perimeter plus a
buffer (5 km by default), reads the area-wide archive's PMTiles index, and
fetches only the tiles inside that area with `Range` requests, a few
megabytes at a time, resuming after a dropped connection. It writes one pack
on the phone. So any fire, any imported or drawn area, works the moment a
crew needs it; nobody has to build a pack first. Ready-made packs under
`packs/` download whole, then are checked against the sha256 in `pack.json`.

### `catalog.json`

```json
{
  "format": "carmanah-catalog",
  "version": 1,
  "updated": "2026-11-18T20:00:00Z",
  "sources": {
    "basemap": [{ "area": "bc", "url": "basemap/bc/20261115_080022_pt.pmtiles", "build": "20261115_080022_pt",
                  "bounds": [-139.1, 48.2, -114.0, 60.1], "minzoom": 0, "maxzoom": 14, "bytes": 0 }],
    "terrain": [{ "area": "bc", "url": "terrain/bc/v1.pmtiles", "version": "v1",
                  "bounds": [-139.1, 48.2, -114.0, 60.1], "minzoom": 0, "maxzoom": 12, "bytes": 0 }],
    "imagery": []
  },
  "packs": [{ "id": "c40983-20261118", "name": "…", "fireNumber": "C40983",
              "bbox": [-127.1, 53.2, -126.0, 53.9], "bytes": 0, "created": "2026-11-18T20:00:00Z",
              "url": "packs/c40983-20261118/pack.json" }]
}
```

URLs are relative to the catalog. The pack builder writes and updates this
file; see [Pack builder](#6-publishing-packs).

---

## 3. Set up R2, click by click

Everything here is in the Cloudflare dashboard, <https://dash.cloudflare.com>.
Allow 20 minutes.

### 3.1 Account and R2

1. Sign up or sign in at <https://dash.cloudflare.com>. Turn on two-factor
   authentication: **My Profile → Authentication → Two-Factor Authentication**.
2. In the left sidebar choose **R2 object storage**. The first time, Cloudflare
   asks you to turn R2 on and may ask for a payment method even for the free
   tier; nothing is charged inside the free amounts in §1.

### 3.2 The bucket

1. **R2 object storage → Overview → Create bucket**.
2. **Bucket name:** `carmanah-maps`.
3. **Location:** *Provide a location hint* → **North America West (WNAM)**
   (closest to BC). *Automatic* is fine too.
4. **Default storage class:** Standard.
5. **Create bucket**.

### 3.3 Public read access

The bucket needs a public web address. There are two kinds; start with the
first, move to the second before crews rely on it.

**A. Testing: the r2.dev address (5 minutes)**

1. **R2 object storage → Overview → carmanah-maps → Settings**.
2. Under **Public Development URL**, select **Enable**.
3. Type `allow` in the box and select **Allow**.
4. **Public URL Access** now says **Allowed**, and the page shows the address,
   like `https://pub-<long id>.r2.dev`. That's the base URL for the checks
   below and for a test build of the app.

Cloudflare rate-limits r2.dev addresses and doesn't cache them. They're for
testing only ([docs](https://developers.cloudflare.com/r2/buckets/public-buckets/)).

**B. Production: a custom domain**

An R2 custom domain must be a domain **whose DNS is run by Cloudflare, in the
same Cloudflare account**. Today `carmanahwildfire.com` uses Google's DNS
(`ns-cloud-b1…b4.googledomains.com`), so `tiles.carmanahwildfire.com` can't
be connected as things stand. (Cloudflare's CNAME-only "partial" setup, which
would avoid moving DNS, needs its Business plan.) Choose one:

| Option | What changes | When |
|---|---|---|
| **B1. A separate domain for map files** (recommended) | Register one through **Domain Registration → Register Domains** in Cloudflare (~US$10/year), e.g. a `carmanah-maps` name. Nothing about carmanahwildfire.com changes. | Any time |
| **B2. Move carmanahwildfire.com's DNS to Cloudflare** (free plan) | **Add a domain**, let Cloudflare copy the records, check every record (website, `app.`, email MX/SPF/DKIM) against Google's before switching the nameservers at the registrar. Affects the website, the crew app and email. | After the Dec 15 store launch |

Then connect it:

1. **R2 object storage → Overview → carmanah-maps → Settings**.
2. Under **Custom Domains**, select **Add**.
3. Enter `tiles.<your domain>` (e.g. `tiles.carmanahwildfire.com` after B2) and select **Continue**.
4. Check the DNS record Cloudflare will add, then **Connect Domain**.
5. Wait until the status reads **Active** (a few minutes). If it stays
   *Initializing*, use **…** next to the domain → **Retry connection**.
6. Once the custom domain works, go back to **Public Development URL** and
   **Disable** the r2.dev address.

The app's base URL is a build setting (§8), so moving from r2.dev to the
custom domain is a rebuild. Packs already on phones aren't affected.

### 3.4 CORS: let the map page read the files

The map page runs on several origins: the test website, the crew app's
website, and inside the iOS app (`capacitor://localhost`) and Android app
(`https://localhost`). The browser only lets it read ranges, ETags and sizes
if the bucket allows those origins.

1. **R2 object storage → Overview → carmanah-maps → Settings**.
2. Under **CORS Policy**, select **Add CORS policy**.
3. Choose the **JSON** tab, delete what's there, and paste the whole of
   [`scripts/packs/r2-cors.json`](../scripts/packs/r2-cors.json):

   ```json
   [
     {
       "AllowedOrigins": [
         "https://nick-carmanah.github.io",
         "https://app.carmanahwildfire.com",
         "capacitor://localhost",
         "https://localhost",
         "http://localhost:5173",
         "http://localhost:4173"
       ],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["range", "if-range", "if-match", "if-none-match"],
       "ExposeHeaders": ["ETag", "Content-Range", "Content-Length", "Accept-Ranges", "Last-Modified", "Cache-Control"],
       "MaxAgeSeconds": 86400
     }
   ]
   ```

4. **Save**. Changes take up to 30 seconds.

Only reading is allowed (GET, HEAD). If the dashboard ever refuses
`capacitor://localhost` as an origin, replace the whole `AllowedOrigins` list
with `["*"]`: the bucket holds only public map data and is read-only to the
world, so allowing every origin gives nothing away. When a new origin needs
access (another website), add it to `r2-cors.json` in the repo first, then
paste the file again.

### 3.5 Caching (custom domain only)

Cloudflare's cache doesn't keep `.pmtiles` or `.json` files unless told to.
With the cache on, the first phone to fetch a ready-made pack pulls it from
R2 and the next ones get it from the nearest Cloudflare data centre.

1. In the dashboard, open the **domain** you connected (not R2).
2. **Caching → Cache Rules → Create rule**.
3. **Rule name:** `Tile bucket`.
4. **If incoming requests match… → Custom filter expression:**
   Field **Hostname**, operator **equals**, value `tiles.<your domain>`.
5. **Cache eligibility:** **Eligible for cache**.
6. **Edge TTL:** *Use cache-control header if present, use default Cloudflare
   caching behavior if not*.
7. **Browser TTL:** *Respect origin TTL*.
8. **Deploy**.
9. Optional: **Caching → Tiered Cache → Smart Tiered Caching** on, so one
   data centre near the bucket fills the others.

Cloudflare caches files up to **512 MB** on the free plan. The area-wide
archives are bigger, so phones read their ranges from R2 directly; that's
expected and still free to download. After editing the CORS policy, purge
the cache for the domain (**Caching → Configuration → Purge Everything**) so
cached files pick up the new headers.

### 3.6 An upload key, for this Mac only

The pack tools upload with a key that can only touch this one bucket.

1. **R2 object storage → Overview**. Under **Account Details**, next to
   **API Tokens**, select **Manage**.
2. **Create Account API token**.
3. **Token name:** `carmanah-maps upload (Nick's Mac)`.
4. **Permissions:** **Object Read & Write**.
5. **Specify bucket(s):** **Apply to specific buckets only** → `carmanah-maps`.
6. **TTL:** pick an end date (a year is reasonable; set a reminder).
7. **Create Account API Token**.
8. The next page shows an **Access Key ID**, a **Secret Access Key** and the
   **S3 endpoint** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. The secret
   is shown **once**. Keep the page open and go straight to §4, which puts
   them into rclone on the Mac.

Never paste the keys into a chat, an email, a note, the repo or a PR. The
tools in this repo never ask for them, print them or store them: they use
rclone's own configuration on your Mac. This key can't create or delete
buckets, change settings, or reach any other bucket.

---

## 4. rclone on the Mac

rclone does the uploading (it handles the multi-gigabyte area archives in
parts).

```bash
brew install rclone
```

```bash
rclone config
```

Answer the prompts (type the bold values):

| Prompt | Answer |
|---|---|
| `e/n/d/r/c/s/q>` | **n** (new remote) |
| `name>` | **carmanah-r2** |
| `Storage>` | **s3** |
| `provider>` | **Cloudflare** |
| `env_auth>` | **false** (just press Enter) |
| `access_key_id>` | paste the **Access Key ID** |
| `secret_access_key>` | paste the **Secret Access Key** (hidden) |
| `region>` | **auto** (or Enter) |
| `endpoint>` | the S3 endpoint, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `Edit advanced config?` | **n** |
| `y/e/d>` | **y** (keep) |
| `e/n/d/r/c/s/q>` | **s** to set a password on the config file (recommended), or **q** to quit |

The keys now live only in `~/.config/rclone/rclone.conf` (encrypted if you
set a password). Close the Cloudflare page. Check it works:

```bash
rclone lsf carmanah-r2:carmanah-maps
```

No output on an empty bucket is right; an error means a wrong key or
endpoint (run `rclone config` again and edit the remote).

To use other names, set `R2_REMOTE` and `R2_BUCKET` before the upload
commands (defaults `carmanah-r2`, `carmanah-maps`).

---

## 5. First upload and check

From the repo folder (`npm ci` done once):

```bash
node scripts/packs/upload.ts scripts/packs/bucket-LICENSE.txt LICENSE.txt
```

Then check the bucket from outside, the way phones see it (no keys needed;
use your r2.dev or custom-domain address):

```bash
npm run packs:check -- https://pub-XXXX.r2.dev/ --key LICENSE.txt
```

It checks, for every origin in `r2-cors.json`: the CORS preflight, a
`Range` read answered with `206` and the exact bytes, the ETag, and the
cache headers. Once `catalog.json` and an archive are up (§6), run it
without `--key`: it then also reads the catalog and tests the first
archive it lists, including that it really is a PMTiles file. Run it again
after any change in §3.

`upload.ts` refuses to overwrite an immutable file (a different size under
the same name stops it; the same size is skipped), and checks the size in
the bucket after each upload.

---

## 6. Publishing packs

The pack builder (`scripts/packs/`, next PR) cuts the area-wide archives and
fire packs and publishes them with the commands above, then updates
`catalog.json` last, so a phone never sees a catalog entry before its files.

Refresh rhythm: the vector archive monthly in fire season (OSM edits to
roads and trails show up), terrain never. Keep the previous vector archive
for a month after a new one, so phones mid-download can finish, then delete
it (**R2 → carmanah-maps → Objects**, select, **Delete**; deleting is free).

---

## 7. If a key leaks, or a person leaves

1. **R2 object storage → Overview → API Tokens → Manage**.
2. Find the token, **…** → **Delete** (or **Roll** for a new secret).
3. Make a new one (§3.6) and update rclone: `rclone config` → **e** (edit)
   → `carmanah-r2`.

A leaked upload key can change files in this bucket only; it can't read
anything private (there's nothing private in it) or touch the rest of the
Cloudflare account. Re-upload from the builder's output if anything looks
wrong.

---

## 8. Pointing the app at the bucket

The map page reads `catalog.json` from one base URL, set when the app is
built: `VITE_PACKS_URL` (the next PRs add it), e.g.
`VITE_PACKS_URL=https://pub-XXXX.r2.dev/ npm run build:embedded`. The
default is the production custom domain once it exists.

For local testing without R2, `npm run packs:serve` serves a folder laid out
like the bucket (default `samples/bucket/`, which git ignores) on
<http://localhost:8787/> with the same ranges, ETags, headers and CORS
rules. `--throttle-kbps 300` slows it to field-LTE speeds for resume tests.
