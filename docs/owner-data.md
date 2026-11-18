# Per-owner storage: what's kept where, and how to remove a person

Phase 0, item 3 of [the rebuild plan](avenza-rebuild-plan.md), for the
"shared phones" row of its §0 contract. Crews share phones, so everything
personal the map page keeps belongs to one **owner**. Another person signed in
on the same phone never sees it, and the crew app can remove one person's data
when their account is removed.

## The owner

`ownerId` comes from the crew app's read-only hand-off,
`carmanah.mapsContext.v1` in localStorage (`src/lib/storage/owner.ts`). With no
hand-off (the website, or a signed-out phone) the owner is `guest`.

- Owner ids are letters, digits, `-` and `_`, up to 64 characters, and
  **never start with `_`**. Names starting with `_` are reserved for things
  that belong to nobody (`maps/_packs/`). A hand-off with any other id runs as
  `guest`.
- The owner is read once per page load (`pageOwnerId()`) and every store uses
  that one id. If the hand-off changes while the page is open, the page
  reloads. It checks when another page changes the hand-off, and whenever the
  page comes back into view, including a restore from the back/forward cache.

## Where things live

| What | Where | Personal? |
|---|---|---|
| Layers, features (pins, lines, areas, tracks), photos, KMZ icons, personal flags | IndexedDB `carmanah-maps.<ownerId>` (stores `layers`, `features`, `photos`, `icons`, `kv`) | yes |
| Maps library records | same database, `maps` | yes |
| Pre-layers imports (`overlays`) and pre-library GeoPDF images (`rasters`) | same database | yes |
| Imported map files: originals, PMTiles pyramids | Files under `maps/<ownerId>/`: Capacitor Filesystem `Directory.LibraryNoCloud` in the app (iOS `Library/NoCloud`: not backed up, not in the Files app), OPFS on the website, or the `files` store of the owner's database on browsers without OPFS | yes |
| Units of measurement, call-sign profile | localStorage `carmanah-maps.<ownerId>.units`, `carmanah-maps.<ownerId>.profile` | yes |
| Live-fire cache (BC Wildfire Service data) | IndexedDB `carmanah-maps` → `kv` (`livefires`) | no, shared |
| Basemap packs | `maps/_packs/<packId>/` | no, shared |
| Display toggles: grid, basemap choice, live-fire layer on/off | localStorage `carmanah-grid`, `carmanah-basemap`, `carmanah-live-*` | no, per phone |

`store.ts` and `mydata.ts` keep their exported functions. They now read and
write the page owner's database. `getCached`/`setCached` are personal, except
for keys listed in `SHARED_CACHE_KEYS` (`src/lib/storage/shared-db.ts`), which
go to the shared database. New personal stores go in
`src/lib/storage/owner-db.ts`: bump `DB_VERSION` and create the store by name.

## Moving the website's existing data (one time)

Before owners, the website kept everything in one shared database,
`carmanah-maps`. All of it was made by guests, so it moves to `guest` only
(`src/lib/storage/legacy-migration.ts`). The move runs the first time the
guest's My Data is read:

1. Read every old record not copied before: features, layers, photos, icons,
   overlays, rasters, and personal `kv` keys. The live-fire cache stays where
   it is.
2. Write them into `carmanah-maps.guest` in **one transaction**, so either all
   of them land or none do.
3. Read them back and compare each one to the original: fields deep-equal,
   photos and images the same size and type.
4. Only then mark the old database. `kv` → `migrated:owner-v1` records every
   key that was copied.

The old records stay **untouched, as a backup**. Nothing writes to them any
more. A later release may remove them, but only from a database that carries
the mark.

- **If the first copy fails**, nothing is marked, and My Data reports an error
  instead of showing an empty map ("…Your data is safe; reload to try
  again"). That error also stops a run from setting flags in the empty guest
  database that would later hide the old data. The next load tries again.
- **After the mark**, the guest database is the live one. A later load copies
  only records that appeared in the old database after the mark (an older tab
  of the app, still open, can write there). It never overwrites the guest's
  records and never brings back something the guest deleted.
- Unit settings and the call-sign profile move the same way: the guest adopts
  the old `carmanah-unit-settings` / `carmanah-profile` keys once. A marker
  (`carmanah-maps._legacy-prefs-adopted`) records that, so deleting the guest
  doesn't bring them back. The old keys stay.
- A database from an older release than the one before (no `layers` store
  yet) goes through the same copy. The existing layers migration in
  `mydata.ts` then runs in the guest database.

The crew app's maps page never had the old database (its origin is the app's
own), so on phones there is nothing to move.

## Removing a person: `deleteOwnerData(ownerId)`

`src/lib/storage/delete-owner.ts`, for the crew app's account-removal step
(`_removePersonFromPhone`):

```ts
import { deleteOwnerData } from './lib/storage/delete-owner'
await deleteOwnerData('u123')
```

It does three things:

1. **Files:** deletes `maps/<ownerId>/` recursively, in Capacitor Filesystem
   `LibraryNoCloud` (in the app) and in OPFS (on the website).
2. **Settings:** removes every localStorage key starting with
   `carmanah-maps.<ownerId>.`.
3. **Database:** drops IndexedDB `carmanah-maps.<ownerId>`. If another page
   has it open, that page lets go and reloads. If something still holds it
   after 10 s, the call rejects, and the delete finishes once that page
   closes.

What it guarantees:

- It never touches `maps/_packs/`, the shared `carmanah-maps` database, or
  anyone else's data. It refuses any id that isn't a valid owner id (for
  example `_packs` or `../x`).
- Every step runs even if an earlier one fails. It then rejects with what
  failed, and running it again is safe.
- Removing someone who has no data is not an error.
- Call it with no map page open as that person, or reload the page after.

If the crew app would rather not load our code for this, the same three steps
by hand are: `Filesystem.rmdir({ path: 'maps/<ownerId>', directory:
Directory.LibraryNoCloud, recursive: true })`,
`indexedDB.deleteDatabase('carmanah-maps.<ownerId>')`, and remove the
localStorage keys with the prefix `carmanah-maps.<ownerId>.`. Settings in
localStorage are a third place on top of the contract's "database + folder".
They're kept there because units must be known before anything draws.

**`guest`:** `deleteOwnerData('guest')` removes the guest's data the same way.
On the website, the pre-owner backup in `carmanah-maps` stays until the
release that removes it, and it is never copied back.

## Native file store

The `native` backend of `FileStore` (`src/lib/storage/files.ts`) is chosen
automatically: native when `window.Capacitor.isNativePlatform()` is true, else
OPFS, else IndexedDB. A person whose files are already in a web backend keeps
it, so their files never seem to vanish. Following
[the spike](native-storage-spike.md) §5:

- **Filesystem without npm.** The store reaches Filesystem through
  `window.Capacitor` (`src/lib/storage/capacitor.ts`). It uses
  `Capacitor.Plugins.Filesystem` if the page registered it,
  `Capacitor.registerPlugin('Filesystem')` if `/capacitor.js` is loaded, or
  the native bridge's `nativePromise` otherwise. The main bundle has no
  Capacitor package.
- **Range reads.** `fetch(Capacitor.convertFileSrc(uri))` with
  `Range: bytes=a-b`. A response counts only if it is `206`, its
  `Content-Range` starts at the requested offset, and it holds exactly the
  bytes asked for (the iOS handler may overstate the range's end past the end
  of the file). When the store opens, it reads 3 known bytes of a 6-byte probe
  file. So a handler that ignores Range, or sends the wrong bytes, is caught
  on a tiny file, before any map or pack is read.
- **Fallback:** `Filesystem.readFile({ offset, length })` (Filesystem ≥
  8.1.0). It is used for the rest of the page load once a range response comes
  back wrong, without reading that response's body. The store never asks for
  `length: 0`, which the plugin would read to the end of the file.
- **Never a fetch without Range.** `read()` of a whole file (sharing an
  original) is range requests of 1 MB each. The iOS handler reads on the main
  thread, so each request stays small.
- **Writes** go to `<file>.part` with `writeFile` and then `appendFile`, in
  4 MB base64 chunks. The size is checked, then the `.part` file is renamed
  over the old file. A failed write leaves the previous file (or none), never
  half of one.
- `downloadFile` isn't used, so its LibraryNoCloud bug (spike §4.1) doesn't
  apply. Pack downloads (Phase 0.4) should use Range chunks + `appendFile`, or
  the `Directory.Library` + `NoCloud/…` workaround.

## Tests

- `test/owner-storage.test.ts`: old database → guest with nothing lost, run
  twice with nothing duplicated, the live-fire cache kept shared; owner
  isolation for My Data, `kv`, legacy maps, units, profile, library records
  and native files; `deleteOwnerData` removes one person and leaves others,
  packs and the shared database alone.
- `test/legacy-migration.test.ts`: a copy that was never marked, an old tab
  writing after the mark, an empty old database, a first-release database
  without `kv`.
- `test/native-file-store.test.ts`: the native backend against an in-memory
  Filesystem and scheme handler. Covers `206`, `200`, a 206 sending the whole
  file, a shifted 206, a 206 with a wrong `Content-Range`, a failing handler,
  chunked writes, a failed write, and a PMTiles pyramid read back tile by
  tile.
- In the iOS simulator: `native-harness/storage.html` runs the real code (see
  that folder's README).

## Verified (2026-11-18)

**iOS simulator** (iPhone 18 Pro, iOS 27.2; the harness's Capacitor 8.6.0 and
Filesystem 8.1.5; the app's real `src/lib/storage` and `src/lib/library`).
Run twice: once with only the native bridge, once with `@capacitor/core`
loaded as the crew app's `/capacitor.js` would be.

- The store picked `native`. The probe found range reads working. Files went
  to `<app>/Library/NoCloud/maps/<ownerId>/`, and nothing landed in
  `Documents`.
- A synthetic GeoPDF imported into the Maps library: 109 tiles, z8–15,
  731 kB, in 0.72–0.85 s. The original PDF read back byte for byte.
- All 109 tiles read back through PMTiles by range: 109 fetches, every one
  `206`, none without Range, the largest 11 kB, 32–34 ms in all. The same
  tiles read again through `readFile({ offset, length })`: 47–62 ms.
- A 9.4 MB file written in 3 chunks (`writeFile` + 2 × `appendFile` into
  `.part`, then renamed) in 38 ms. Ranges across the chunk boundaries and the
  whole file read back right. Replacing it worked and left no `.part` behind.
- `deleteOwnerData`: the owner's folder, database and settings keys were gone
  in 8–17 ms. `maps/_packs/sim-pack/pack.json` was untouched.

**Browser** (Chromium, same origin): the website's data upgraded in place.
The old code (`main` at d4c6e4f) seeded, through its own modules, a KML
import, a pin with a photo, a KMZ icon, the live-fire cache, a pre-library
GeoPDF image, a tiled library map (OPFS), and units and profile settings.
Then the new code loaded:

- Every personal record was in `carmanah-maps.guest`, identical to the
  original (hashes of each record, Blobs by size and type).
- The old database was unchanged apart from the `migrated:owner-v1` mark, and
  the live-fire cache was still shared.
- The same layers, features, units (chains, acres), 2 maps and live-fire
  status showed. The tiled map, the old GeoPDF image, the KML perimeter and
  the pins all drew.
- Another tab changing the hand-off reloaded this one, which then showed the
  new owner nothing. `deleteOwnerData` removed that owner's database, OPFS
  folder and keys, and left the guest's.

**Not proven here:** a real iPhone, Android (Range through
`WebViewLocalServer`, spike §7; the probe would switch Android to the
`readFile` fallback if ranges come back wrong), MapLibre drawing a library
map in the native app (tiles were read through the same PMTiles + `readRange`
path the `carmanah-map://` protocol uses, but not drawn on device), and the
crew app's real hand-off and account-removal code calling `deleteOwnerData`.
