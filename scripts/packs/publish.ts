// Publish what build-pack.ts made: upload the files, then update
// catalog.json last, so a phone never sees a catalog entry before its files.
//
//   node scripts/packs/publish.ts --pack samples/packs/<id>            a ready-made pack
//   node scripts/packs/publish.ts --area samples/packs/area-bc         the BC-wide archives
//   node scripts/packs/publish.ts --remove-pack <id>                   drop a pack from the catalog
//
// Add --to <folder> to publish into a local folder laid out like the bucket
// (for scripts/packs/serve-local.ts) instead of R2. R2 uploads go through
// upload.ts (rclone; no credentials here).

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { emptyCatalog, parseCatalog, parseManifest, type Catalog, type CatalogSource } from '../../src/lib/packs/manifest.ts'
import { objectHeaders } from './layout.ts'
import { BUCKET, REMOTE, uploadOne } from './upload.ts'

export interface Target {
  describe: string
  getCatalog(): Catalog
  put(file: string, key: string): void
}

export function localTarget(root: string): Target {
  return {
    describe: root,
    getCatalog() {
      const path = join(root, 'catalog.json')
      return existsSync(path) ? parseCatalog(JSON.parse(readFileSync(path, 'utf8'))) : emptyCatalog()
    },
    put(file, key) {
      const headers = objectHeaders(key)
      if (!headers) throw new Error(`${key} isn't a key in the bucket layout`)
      const dest = join(root, ...key.split('/'))
      if (headers.immutable && existsSync(dest)) {
        if (statSync(dest).size === statSync(file).size) return
        throw new Error(`${key} already exists with a different size; immutable keys are never replaced`)
      }
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(file, dest)
      console.log(`copied  ${key}`)
    },
  }
}

export function r2Target(): Target {
  return {
    describe: `${REMOTE}:${BUCKET}`,
    getCatalog() {
      const out = spawnSync('rclone', ['cat', `${REMOTE}:${BUCKET}/catalog.json`], { encoding: 'utf8' })
      if (out.status !== 0) {
        if (/not found|doesn't exist|NoSuchKey|404/i.test(out.stderr)) return emptyCatalog()
        throw new Error(`can't read catalog.json from ${REMOTE}:${BUCKET}`)
      }
      return parseCatalog(JSON.parse(out.stdout))
    },
    put(file, key) {
      uploadOne(file, key)
    },
  }
}

function putCatalog(target: Target, catalog: Catalog) {
  catalog.updated = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const file = join(tmpdir(), `catalog-${process.pid}.json`)
  writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`)
  target.put(file, 'catalog.json')
}

export function publishPack(target: Target, dir: string): void {
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')))
  for (const f of manifest.files) {
    if (statSync(join(dir, f.name)).size !== f.bytes) throw new Error(`${f.name} isn't the size pack.json says`)
    target.put(join(dir, f.name), `packs/${manifest.id}/${f.name}`)
  }
  target.put(join(dir, 'pack.json'), `packs/${manifest.id}/pack.json`)
  const catalog = target.getCatalog()
  catalog.packs = catalog.packs.filter((p) => p.id !== manifest.id)
  catalog.packs.unshift({
    id: manifest.id,
    name: manifest.name,
    ...(manifest.fireNumber ? { fireNumber: manifest.fireNumber } : {}),
    bbox: manifest.bbox,
    bytes: manifest.bytes,
    created: manifest.created,
    url: `packs/${manifest.id}/pack.json`,
  })
  putCatalog(target, catalog)
}

export function publishArea(target: Target, dir: string): void {
  const sources = JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8')) as Record<'basemap' | 'terrain', CatalogSource[]>
  const catalog = target.getCatalog()
  for (const kind of ['basemap', 'terrain'] as const) {
    for (const s of sources[kind] ?? []) {
      target.put(join(dir, ...s.url.split('/')), s.url)
      // One archive per area in the catalog: the newest. Phones that started
      // from the old one keep reading it until it's deleted (docs/hosting-r2.md §6).
      catalog.sources[kind] = [s, ...catalog.sources[kind].filter((o) => o.area !== s.area)]
    }
  }
  putCatalog(target, catalog)
}

export function removePack(target: Target, id: string): void {
  const catalog = target.getCatalog()
  catalog.packs = catalog.packs.filter((p) => p.id !== id)
  putCatalog(target, catalog)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: { pack: { type: 'string' }, area: { type: 'string' }, 'remove-pack': { type: 'string' }, to: { type: 'string' } },
  })
  try {
    const target = values.to ? localTarget(values.to) : r2Target()
    if (values.pack) publishPack(target, values.pack)
    else if (values.area) publishArea(target, values.area)
    else if (values['remove-pack']) removePack(target, values['remove-pack'])
    else {
      console.error('usage: node scripts/packs/publish.ts --pack <dir> | --area <dir> | --remove-pack <id>  [--to <local folder>]')
      process.exit(2)
    }
    console.log(`Published to ${target.describe}`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
