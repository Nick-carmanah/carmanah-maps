// The tile bucket's layout (docs/hosting-r2.md): which keys exist, and the
// headers each one is uploaded with. Upload (upload.ts), the local stand-in
// server (serve-local.ts) and the hosting check (check-hosting.ts) all use
// this, so they can't drift apart.
//
//   catalog.json                          what the app reads first (short cache)
//   LICENSE.txt                           data licences and credits
//   basemap/<area>/<build>.pmtiles        area-wide vector archive (immutable)
//   terrain/<area>/<version>.pmtiles      area-wide terrain archive (immutable)
//   packs/<packId>/pack.json              ready-made pack manifest (immutable)
//   packs/<packId>/<name>.pmtiles         ready-made pack files (immutable)
//   imagery/...                           reserved for satellite imagery (another session)
//
// Immutable keys are never overwritten: a new build gets a new key, so
// phones and Cloudflare's cache can keep them for a year.

export interface ObjectHeaders {
  contentType: string
  cacheControl: string
  /** Never overwritten once uploaded. */
  immutable: boolean
}

export const IMMUTABLE = 'public, max-age=31536000, immutable'
/** catalog.json changes when a pack or a new weekly build is published. */
export const CATALOG_CACHE = 'public, max-age=300'
const PMTILES = 'application/vnd.pmtiles'

const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}'
const RULES: { re: RegExp; headers: ObjectHeaders }[] = [
  { re: /^catalog\.json$/, headers: { contentType: 'application/json', cacheControl: CATALOG_CACHE, immutable: false } },
  { re: /^LICENSE\.txt$/, headers: { contentType: 'text/plain; charset=utf-8', cacheControl: 'public, max-age=3600', immutable: false } },
  { re: new RegExp(`^(basemap|terrain)/${SEGMENT}/${SEGMENT}\\.pmtiles$`), headers: { contentType: PMTILES, cacheControl: IMMUTABLE, immutable: true } },
  { re: new RegExp(`^packs/${SEGMENT}/pack\\.json$`), headers: { contentType: 'application/json', cacheControl: IMMUTABLE, immutable: true } },
  { re: new RegExp(`^packs/${SEGMENT}/${SEGMENT}\\.pmtiles$`), headers: { contentType: PMTILES, cacheControl: IMMUTABLE, immutable: true } },
  // Reserved for the satellite session; same rules for its PMTiles and JSON.
  { re: new RegExp(`^imagery/(${SEGMENT}/)*${SEGMENT}\\.pmtiles$`), headers: { contentType: PMTILES, cacheControl: IMMUTABLE, immutable: true } },
  { re: new RegExp(`^imagery/(${SEGMENT}/)*${SEGMENT}\\.json$`), headers: { contentType: 'application/json', cacheControl: CATALOG_CACHE, immutable: false } },
]

/** Headers for a bucket key, or null if the key isn't part of the layout. */
export function objectHeaders(key: string): ObjectHeaders | null {
  if (key.split('/').some((part) => part === '..' || part === '.')) return null
  return RULES.find((rule) => rule.re.test(key))?.headers ?? null
}
