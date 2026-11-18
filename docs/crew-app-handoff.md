# The maps page in the crew app: hand-over

For the Carmanah App master. This is Phase 0.2 of
[the rebuild plan](avenza-rebuild-plan.md), built to the integration contract
in its §0. It covers what this repo hands over, how to put it into the crew
app, and what both sides must keep stable.

## 1. Build it

Node 22 or newer, from the root of this repo:

```bash
npm ci
```

```bash
npm run build:embedded
```

The output is `dist-embedded/`. It differs from the website build
(`npm run build`) in these ways only:

| | Website (`dist/`) | Crew app (`dist-embedded/`) |
|---|---|---|
| Base path | `/carmanah-maps/` | `/maps/` |
| Service worker | Its own (`sw.js`, workbox) | **None.** Nothing is registered and no worker file is written. |
| Web app manifest, `registerSW.js`, home-screen icons, demo KML | Yes | No |
| First script in `index.html` | — | `<script src="/capacitor.js"></script>` |
| `precache-manifest.json` | — | Yes, listing every other file |
| "Save offline" button (basemap tiles in the browser cache) | Yes | Hidden: see §8 |

Everything else is the same app, from the same source.

`npm test` builds the embedded bundle into a temporary folder and checks it
(`test/embedded-build.test.ts`):

- the manifest lists every file exactly once, with the right size and sha256;
- there's no service worker or registration;
- `/capacitor.js` comes first;
- every other address is under `/maps/`;
- the label fonts and icons are in the bundle, and nothing asks a font or
  icon server for them.

## 2. What goes into `public/maps/`

Replace the whole folder with the contents of `dist-embedded/`. Delete the
old folder first: JS and CSS names carry content hashes, so old files would
otherwise linger.

| Path | What | Size |
|---|---|---|
| `index.html` | The page | < 1 kB |
| `assets/` | App code, styles, the PDF reader and its worker. File names are content-hashed. | ~4.1 MB in 8 files |
| `basemap/fonts/<font>/<range>.pbf`, `basemap/fonts/OFL.txt` | Label fonts: Noto Sans Regular, Bold and Italic, 6 character ranges each, plus their licence | ~1.6 MB |
| `basemap/sprites/ofm*.{json,png}` | Map icons (1× and 2×) | ~0.23 MB |
| `nwcg/*.png` | Fire-ops symbols for pins | ~0.07 MB in 51 files |
| `precache-manifest.json` | The list below | |

That's about 83 files and 6.1 MB in all. The largest are the main script
(1.7 MB) and the PDF worker (1.2 MB).

Nothing is private. No data, no keys, no crew-only material: it's the same
code as the public website. Outside scripts: none. The page loads only its own
files and `/capacitor.js`. At run time it fetches map tiles, terrain, satellite
imagery and live fire data from public map services, as the website does.

Names without a hash: `index.html`, `basemap/**` and `nwcg/**`. Their content
rarely changes, but when it does the name stays the same. So fetch every file
past the browser's HTTP cache when you build a new cache
(`cache: 'reload'`). The manifest's `revision` changes whenever any file does.

**Font folder names contain spaces** (`basemap/fonts/Noto Sans Regular/…`),
because the map asks for fonts by name. Use each entry's `url`, which is
percent-encoded the way browsers request it (`Noto%20Sans%20Regular`), not
its `path`.

## 3. `MAPS_FILES` from the manifest

```json
{
  "version": 1,
  "base": "/maps/",
  "appVersion": "0.1.0",
  "revision": "56c1e9b669e4c802",
  "bytes": 6065486,
  "files": [
    { "url": "/maps/assets/index-CEqlLrPD.js", "path": "assets/index-CEqlLrPD.js", "bytes": 1667660, "sha256": "7177a9ba…" },
    { "url": "/maps/basemap/fonts/Noto%20Sans%20Bold/0-255.pbf", "path": "basemap/fonts/Noto Sans Bold/0-255.pbf", "bytes": 81170, "sha256": "…" },
    { "url": "/maps/index.html", "path": "index.html", "bytes": 707, "sha256": "…" }
  ]
}
```

- `files` holds every file in the folder except `precache-manifest.json`
  itself, sorted by `path`.
- `revision` is the first 16 hex digits of a sha256 over every path and hash.
  It's handy in `CACHE_NAME`.
- The manifest has no timestamps. The same source gives the same manifest.

The generator script can be this small (CommonJS, like the crew app's
scripts):

```js
const manifest = require('../public/maps/precache-manifest.json');
const MAPS_FILES = manifest.files.map((file) => file.url);
```

Suggested test on your side:

1. Every file under `public/maps/` except the manifest appears in
   `manifest.files` with the same `bytes` and `sha256`, and nothing else
   does.
2. `MAPS_FILES` in `sw.js` equals `manifest.files.map(f => f.url)`.

Cache the files one at a time, like `FIELD_FILES`, so a slow or failed maps
file never blocks the crew app's install. Every maps release is a crew
release with a new `CACHE_NAME`.

## 4. `/capacitor.js` and opening the page

- **The page loads `/capacitor.js` first**: a plain script, from the root,
  before the app's module script. In the store app it must be @capacitor/core's
  `dist/capacitor.js` (your `mobile/native-runtime/capacitor.js`). The page
  uses its `Capacitor.isNativePlatform`, `isPluginAvailable` and
  `registerPlugin`, the same lookup as your `_nativePlugin`. The tag is already
  in our `index.html`, so your bundle script doesn't need to add it. Please
  don't rewrite the file: its sha256 is in the manifest.
- **On the website** there is no `/capacitor.js`, so that request gets a 404.
  It's harmless: the page then takes the website paths (Web Share, downloads).
  But it is a render-blocking script, and on a weak connection the browser
  waits for it. Please have the website `sw.js` answer `/capacitor.js` with
  an empty script, e.g.
  `new Response('', { headers: { 'Content-Type': 'text/javascript' } })`, so
  the page opens at once offline. The store app registers no service worker,
  so this never touches it.
- **Open the page as `/maps/index.html`, never `/maps/`.** Capacitor's iOS
  scheme handler answers any address without a file extension with the app's
  root `index.html`, so `/maps/` would load the crew app again.
- **Getting back:** the page has no browser chrome in the store app, so the
  embedded build shows a **‹ Home** link in its top bar that goes to `/`. Tell
  us if Home should go somewhere else.

## 5. The hand-off: `carmanah.mapsContext.v1`

The crew app writes it to `localStorage` before it opens the page, and clears
it at sign-out. The page only ever reads it
(`src/lib/storage/owner.ts`).

```json
{ "ownerId": "u123", "fireNumber": "K61067", "callSign": "2P14", "name": "…", "crew": "…", "asOf": "2026-11-18T17:00:00Z" }
```

| Field | Read? | Rule |
|---|---|---|
| `ownerId` | Yes | Letters, digits, `-`, `_`, 1–64 characters. Names the person's storage (`carmanah-maps.<ownerId>`, `maps/<ownerId>/`). Anything else, or no hand-off, means `guest`. |
| `fireNumber` | Yes | Text, trimmed, at most 40 characters. `fire_number` and `fire` are also accepted. |
| `callSign` | Yes | Text, trimmed, at most 40 characters. `call_sign` and `callsign` are also accepted. |
| `name`, `crew`, `asOf`, anything else | No | Ignored. Never put sign-in tokens here. |

Where the page uses them:

- Owner: whose maps, tracks and layers open.
- Fire number and call sign together:
  - "Send this area as a map" titles a map "K61067 2P14 2026-11-18" by
    default.
  - New features are named the BCWS way, e.g. `Edge_NOV18_K61067_2P14`.
- Fire number alone: the default maps-library folder.
- Settings shows the call sign and fire number it received.

Both win over the phone's own profile fields: crews share phones, and the
profile belongs to the phone, not to whoever is signed in. If the hand-off
changes while the page is open (someone signs out or in), the page reloads
as the new owner.

## 6. Native plugins

The page uses the plugins through `window.Capacitor`. This repo has no
Capacitor package in its main bundle.

| Plugin | Calls | Version |
|---|---|---|
| @capacitor/core (as `/capacitor.js`) | `isNativePlatform`, `isPluginAvailable`, `registerPlugin` | 8.x; tested with 8.6.0 |
| @capacitor/filesystem | `writeFile`, `appendFile`, `rmdir` (Cache directory) | **≥ 8.1.0**: the coming native tile store reads by offset (`docs/native-storage-spike.md`). Tested with 8.1.5. |
| @capacitor/share | `share({ title, files: [uri] })` | Tested with 8.0.3 |

**How a share works in the store app** (`shareNatively` in
`src/lib/export.ts`). It's used for KMZ, KML, GPX and CSV exports, layer
shares, "Send this area as a map" PDFs and map originals from the library:

1. The page writes the file to the Cache directory as
   `shared/maps-<random id>/<file name>`. It goes in 3 MB base64 pieces
   (`writeFile`, then `appendFile`), so a large map original never becomes
   one huge string on the bridge.
2. It calls `Share.share` with the file's `file://` URI. This brings up
   AirDrop, Quick Share, Save to Files and "Open in …".
3. It deletes the folder. That's at once if the share was cancelled or
   failed, and 2 minutes after a completed share, because on Android the
   receiving app may read the file after the person comes back.

On the website it uses the Web Share API, and a download where that's
missing.

**Please keep clearing Cache `shared/`** at sign-out and when the app starts,
so a copy left by a closed page doesn't wait for the next person.

## 7. What must never change on your side

1. `/capacitor.js` stays at the root, as @capacitor/core's `dist/capacitor.js`
   8.x.
2. `public/maps/` is served exactly as built, at `/maps/`: no rewriting,
   minifying or re-encoding. The manifest hashes must match.
3. The Home button opens `/maps/index.html`.
4. The maps page and the crew app share one origin (`capacitor://localhost`
   on iOS, `https://localhost` on Android), because the hand-off travels in
   `localStorage`. Keep `server.hostname` and the schemes as they are.
5. The hand-off key and field names, the `ownerId` format, no tokens in it,
   and clearing it at sign-out.
6. @capacitor/filesystem stays ≥ 8.1.0, and @capacitor/share stays in the
   app.
7. Cache `shared/` is cleared at sign-out and at app start.
8. If the maps page ever gets a Content-Security-Policy, it must allow
   `script-src 'self'` (the page has no inline scripts), `worker-src blob:`,
   `img-src 'self' data: blob:`, and `connect-src` to the app's own scheme
   plus the map, terrain and fire-data hosts.
9. Every maps release is a crew release with a new `CACHE_NAME`.

## 8. Known limits in this build

- **The basemap still needs signal in the crew app.** Website saved areas
  live in the browser cache and are served by the website's own service
  worker, which the crew app doesn't have. So this build hides "Save
  offline", rather than offering areas it would never show offline.

  Labels and map icons are bundled, so they work offline from the first
  launch. So should the person's own pins, lines, tracks, layers and imported
  maps, which the page keeps in its own storage, but that hasn't been tested
  offline in the store app yet. Offline basemaps come with native packs (plan
  Phase 0.3/0.4). Those need to land before crews rely on the map page
  offline.
- Android hasn't been run. There's no Android SDK on the build Mac.

## 9. One line for `/privacy`

> Map tracks, pins, photos and imported maps stay on your phone. They leave it
> only when you share them yourself, for example by AirDrop or Quick Share, and
> none of it is sent to Carmanah.

## 10. What was tested in the iOS simulator

Setup: iPhone 18 Pro simulator on iOS 27.2, with the dev harness in
[`native-harness/`](../native-harness/) (`npm run sync:maps`). The harness
pins the crew app's versions: Capacitor 8.6.0, Filesystem 8.1.5, Share
8.0.3. The page was served from the app bundle at
`capacitor://localhost/maps/index.html`, with `/capacitor.js` taken from
@capacitor/core 8.6.0's `dist`, as the crew app does.

| Check | Result |
|---|---|
| The page renders, with labels and map icons | Yes |
| The page sees the store app (`Capacitor` present, `isNativePlatform`, Filesystem and Share available) | Yes |
| A stand-in hand-off (`ownerId u123`, `K61067`, `2P14`) | Map title "K61067 2P14 2026-11-18" |
| Share a 2.0 MB map | The iOS share sheet opened with the PDF. Copy written to `Library/Caches/shared/maps-<id>/`. |
| Cancel | "Share canceled" came back, and the copy was deleted at once |
| Save to Files | `activityType` `SaveToFiles`. The file in Files is byte-identical to the copy, which was deleted 2 minutes later. |
| Share an 11.7 MB map | 1 `writeFile` + 3 `appendFile`. Byte-identical in Files, and every PDF cross-reference offset is intact. |

Not proved here:

- AirDrop: the simulator has none.
- Quick Share and anything else on Android: not run.
- "Open in Avenza": not installed in the simulator.
- Memory and speed for very large files on a real phone.
- The KMZ, GPX, CSV and map-original shares. They use the same function, and
  unit tests cover it with fake plugins (`test/native-share.test.ts`).

On a desktop browser, `dist-embedded/` served under `/maps/` showed:

- no service worker registered;
- fonts and icons fetched only from `/maps/basemap/`, never from a font or
  icon server;
- the map drawn;
- `/capacitor.js` returning 404, as §4 expects.
