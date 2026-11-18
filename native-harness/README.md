# Native storage harness (dev only)

A throwaway Capacitor iOS app that answers one question: can MapLibre draw a
basemap offline from tiles kept in Capacitor Filesystem storage, fast enough
for field use, at whole-fire scale? Findings: [`docs/native-storage-spike.md`](../docs/native-storage-spike.md).

This folder is **not** part of the production web build or the PR check. It
has its own `package.json` and lock. The root `tsconfig` only includes `src/`,
and the root Vite build starts from the root `index.html`. Capacitor is pinned
to exactly the crew app's `mobile/` versions: `@capacitor/core`, `@capacitor/ios`
and `@capacitor/cli` 8.6.0, `@capacitor/filesystem` 8.1.5, `@capacitor/share`
8.0.3. iOS uses Swift Package Manager, no CocoaPods.

## What's in it

| File | Does |
|---|---|
| `index.html`, `src/main.ts` | Offline map. Its Content-Security-Policy allows no http(s) at all, so anything it draws came from on-device storage. Switch between the three read paths, and run the tile and render benchmarks. |
| `tools.html`, `src/tools.ts` | Online page: download a real area (OpenFreeMap + AWS Terrain Tiles), build PMTiles packs on the phone, and run the 15,000-tile scale test. |
| `src/pack.ts` | Pack layout, the three read paths as MapLibre custom protocols, and PMTiles sources over Capacitor. |
| `src/pmtiles-write.ts` | Minimal PMTiles v3 writer (streams to disk; leaf directories). Shared with Node. |
| `src/fsx.ts` | Filesystem helpers (`Library/NoCloud`), timing, and the command file the Mac uses to drive runs. |
| `scripts/make-scale-pack.ts` | Makes the synthetic 15,074-tile, 0.6 GB scale pack on the Mac (`node scripts/make-scale-pack.ts`). |
| `scripts/serve-pack.mjs` | Range-capable localhost server for the scale pack (`npm run serve-pack`). |
| `scripts/sim.sh` | Writes a command into the simulator app's container, relaunches it, and waits for the results JSON. `BUNDLE=<id>` picks another bundle id. |
| `storage.html`, `src/storage-check.ts` | Phase 0.3 check: the app's own storage layer (`../src/lib/storage`) and Maps library on Filesystem. Imports a synthetic GeoPDF, reads every tile back by range and by `readFile` offset, writes a 9 MB file in chunks, then `deleteOwnerData`. Imports no Capacitor package unless `args.core` (like the crew app's maps page). See [`docs/owner-data.md`](../docs/owner-data.md). |

## The crew app's map page

`npm run sync:maps` (after `npm run build:embedded` at the repo root) also puts
the embedded build at `maps/` and @capacitor/core's `dist/capacitor.js` at
`/capacitor.js`, the way the crew app serves them
(`scripts/add-maps-page.mjs`). The harness copy of `maps/index.html` gets one
extra script that reports load failures, uncaught errors and a status line to
the Xcode console. Open it from the Mac, optionally with a stand-in for the
crew app's hand-off (`null` removes it):

```bash
scripts/sim.sh <udid> '{"page":"maps","action":"open","args":{"mapsContext":{"ownerId":"u123","fireNumber":"K61067","callSign":"2P14"}}}' 60
```

`"args":{"localStorage":{…}}` sets other keys first (e.g.
`"carmanah-live-enabled":"1"`), and `"offline":true` opens `maps/offline.html`:
the same page under a Content-Security-Policy that allows no http(s) at all,
to prove what it draws comes from the phone. `scripts/maps-driver.js` (harness
copy only) can drive the page from a `harness.drive` key: Offline maps → a
fire → Check size → Download, or fly over an area and report what was drawn
(`maps/_harness/results/<step>.json`). The fire-packs check (2026-11-18) used
it with the bundle id `com.carmanahwildfire.mapsharness.packs`.

Share copies land in the app's `Library/Caches/shared/maps-<id>/`. Results of
the 2026-11-18 run: [`docs/crew-app-handoff.md`](../docs/crew-app-handoff.md) §10.

## Run it

```bash
export PATH="/opt/homebrew/bin:$PATH"
```

```bash
cd native-harness && npm ci && npm run sync
```

```bash
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -derivedDataPath ../../.scratch/DerivedData build
```

Install `.scratch/DerivedData/Build/Products/Debug-iphonesimulator/App.app`
on the simulator, then either tap through the UI or drive it from the Mac:

```bash
scripts/sim.sh <udid> '{"page":"tools","action":"download,build"}'
```

```bash
scripts/sim.sh <udid> '{"page":"index","action":"bench-tiles","args":{"rounds":3}}'
```

```bash
scripts/sim.sh <udid> '{"page":"index","action":"bench-render","args":{"rounds":2,"fadeDuration":0}}'
```

Storage check (Phase 0.3). Build with a separate bundle id so it can't replace
another session's harness install; results land in
`.scratch/results/storage-check[-core].json`:

```bash
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -derivedDataPath ../../.scratch/DerivedData PRODUCT_BUNDLE_IDENTIFIER=com.carmanahwildfire.mapsharness.storage build
```

```bash
BUNDLE=com.carmanahwildfire.mapsharness.storage scripts/sim.sh <udid> '{"page":"storage","action":"check","args":{"owner":"sim-a"}}' 180
```

Scale test (start `npm run serve-pack` in another terminal first, after
`node scripts/make-scale-pack.ts .scratch/<pulled pack.json>`):

```bash
scripts/sim.sh <udid> '{"page":"tools","action":"scale-download-pack,scale-write-files,scale-build-pack,scale-read,scale-delete"}' 900
```

Results land in the app's `Library/NoCloud/maps/_harness/results/` and are
copied to `.scratch/results/` (gitignored).

The sample area download stays inside OpenFreeMap's offline terms: well under
3,000 tiles and 50 MB, at most 4 requests in flight, and a User-Agent that
names the app (`appendUserAgent` in `capacitor.config.json`).

`NSAllowsLocalNetworking` in `ios/App/App/Info.plist` exists only so the
harness can reach the Mac's test server. The crew app doesn't need it.
