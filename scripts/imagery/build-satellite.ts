// Build our own satellite basemap from Copernicus Sentinel-2 as one PMTiles
// file. See README.md in this folder.
//
//   node build-satellite.ts                       # BC, newest quarterly mosaic (needs CDSE keys)
//   node build-satellite.ts --estimate            # tile counts and sizes only, no keys needed
//   node build-satellite.ts --source aws-l2a --bbox=-121.70,50.17,-121.45,50.33 --name lytton
//
// Output goes under samples/bucket/ (git ignores samples/), a local copy of
// the R2 bucket (docs/hosting-r2.md): the file at its bucket key,
// imagery/s2-quarterly/<area>/<year>-q<n>.pmtiles, and its entry added to
// catalog.json "sources.imagery". Nothing is uploaded; the build prints the
// upload commands.
//
// Credentials (CDSE S3 keys) are read only from the environment:
//   CDSE_S3_ACCESS_KEY, CDSE_S3_SECRET_KEY
// They are never printed or written anywhere.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import sharp from 'sharp'
import { areaFromBbox, areaFromRings, countTiles, tileTouchesArea, type Area } from './lib/area.ts'
import { addImageryEntry, COPERNICUS_LICENCE, imageryKey, type Catalog } from './lib/catalog.ts'
import { PmTileType, PmCompression } from '../../src/lib/pmtiles-writer.ts'
import { SpoolWriter } from './lib/pmtiles-out.ts'
import { BlockCache, limitFetch, openSource, type OpenSource } from './lib/raster.ts'
import { alphaStats, downsample, drawTile, planTile, type Block, type BlockLookup } from './lib/render.ts'
import { awsL2aSources, cdseMosaicSources } from './lib/sources.ts'
import { TRUE_COLOUR } from './lib/stretch.ts'
import type { SourceSpec } from './lib/types.ts'
import { children, tileBounds, TILE_SIZE, type TileId } from './lib/tiles.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')

const { values: args } = parseArgs({
  options: {
    source: { type: 'string', default: 'cdse' },
    area: { type: 'string', default: 'bc' },
    bbox: { type: 'string' },
    name: { type: 'string' },
    quarter: { type: 'string', default: 'latest' },
    'fill-quarters': { type: 'string', default: '1' },
    dates: { type: 'string', default: '2026-07-01T00:00:00Z/2026-09-30T23:59:59Z' },
    'max-cloud': { type: 'string', default: '5' },
    'max-zoom': { type: 'string', default: '13' },
    format: { type: 'string', default: 'webp' },
    quality: { type: 'string', default: '80' },
    out: { type: 'string', default: join(REPO, 'samples/bucket') },
    concurrency: { type: 'string' },
    'cache-mb': { type: 'string', default: '1500' },
    resume: { type: 'boolean', default: false },
    estimate: { type: 'boolean', default: false },
    'tile-kb': { type: 'string', default: '10' },
  },
})

const maxZoom = Number(args['max-zoom'])
const format = args.format === 'jpeg' ? 'jpeg' : 'webp'
const quality = Number(args.quality)

function loadArea(): Area {
  if (args.bbox) {
    const box = args.bbox.split(',').map(Number) as [number, number, number, number]
    if (box.length !== 4 || box.some((v) => !Number.isFinite(v))) throw new Error('--bbox is west,south,east,north')
    return areaFromBbox(args.name ?? 'area', box)
  }
  if (args.area !== 'bc') throw new Error('--area bc, or give --bbox')
  const geo = JSON.parse(readFileSync(join(HERE, 'bc-boundary.geojson'), 'utf8')) as {
    geometry: { coordinates: [number, number][][][] }
  }
  // 10 km past the line: border fires, and Natural Earth 1:50m is a few km coarse.
  return areaFromRings('bc', geo.geometry.coordinates.map((polygon) => polygon[0]), 10)
}

function credentials() {
  const accessKeyId = process.env.CDSE_S3_ACCESS_KEY
  const secretAccessKey = process.env.CDSE_S3_SECRET_KEY
  if (!accessKeyId || !secretAccessKey) return null
  return { accessKeyId, secretAccessKey }
}

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e3).toFixed(0)} KB`

async function estimate(area: Area): Promise<void> {
  const tileBytes = Number(args['tile-kb']) * 1000
  console.log(`Area: ${area.name}${area.marginKm ? ` (+${area.marginKm} km)` : ''}`)
  for (const z of [maxZoom, maxZoom + 1]) {
    const counts = countTiles(area, z)
    const total = counts.reduce((a, b) => a + b, 0)
    console.log(`\nTo z${z}: ${total.toLocaleString()} tiles, about ${fmtBytes(total * tileBytes)} at ${args['tile-kb']} KB a tile`)
    console.log('  ' + counts.map((c, i) => `z${i} ${c.toLocaleString()}`).join(' · '))
  }
  if (args.source === 'cdse') {
    const { quarter, sources } = await cdseMosaicSources(area, args.quarter!, null)
    const bytes = sources.reduce((n, s) => n + (s.bytes ?? 0), 0)
    console.log(
      `\nSource: Sentinel-2 mosaic ${quarter}, ${sources.length} grid squares, ${fmtBytes(bytes)} of band files ` +
        `(red, green, blue; the build reads only the parts inside the area). ` +
        `Gaps are filled from ${args['fill-quarters']} earlier quarter(s), read only where needed.`,
    )
  }
}

async function encode(rgba: Uint8Array, opaque: boolean): Promise<Uint8Array> {
  let image = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width: TILE_SIZE, height: TILE_SIZE, channels: 4 },
  })
  if (format === 'jpeg') {
    return image.flatten({ background: '#000000' }).jpeg({ quality, mozjpeg: true }).toBuffer()
  }
  if (opaque) image = image.removeAlpha()
  return image.webp({ quality, alphaQuality: 90, effort: 5 }).toBuffer()
}

async function decode(bytes: Uint8Array): Promise<Uint8Array> {
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function semaphore(n: number) {
  let active = 0
  const queue: (() => void)[] = []
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r))
    else active++
    try {
      return await job()
    } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
}

async function build(area: Area): Promise<void> {
  let specs: SourceSpec[]
  let label: string
  let year: string
  if (args.source === 'cdse') {
    const creds = credentials()
    if (!creds) {
      throw new Error(
        'Set CDSE_S3_ACCESS_KEY and CDSE_S3_SECRET_KEY in your environment (free Copernicus Data Space account → ' +
          'https://eodata-s3keysmanager.dataspace.copernicus.eu). See README.md.',
      )
    }
    const found = await cdseMosaicSources(area, args.quarter!, creds, Number(args['fill-quarters']))
    specs = found.sources
    label = `Sentinel-2 quarterly mosaic ${found.quarter}`
    year = found.quarter.slice(0, 4)
  } else if (args.source === 'aws-l2a') {
    specs = await awsL2aSources(area, args.dates!, Number(args['max-cloud']))
    label = `Sentinel-2 L2A ${[...new Set(specs.map((s) => s.date))].join(', ')}`
    year = [...new Set(specs.map((s) => s.date.slice(0, 4)))].join('–')
  } else {
    throw new Error('--source cdse or aws-l2a')
  }
  if (specs.length === 0) throw new Error('No imagery found for this area')
  const attribution = `Contains modified Copernicus Sentinel data ${year}`
  const mainSpecs = specs.filter((s) => !s.priority)
  console.log(
    `${label}: ${mainSpecs.length} grid squares, ${fmtBytes(mainSpecs.reduce((n, s) => n + (s.bytes ?? 0), 0))} of band files` +
      (specs.length > mainSpecs.length ? ` (+${specs.length - mainSpecs.length} older squares to fill gaps)` : ''),
  )

  // CDSE allows 4 connections per user.
  limitFetch(Number(args.concurrency ?? (args.source === 'cdse' ? 4 : 8)))
  const cache = new BlockCache(Number(args['cache-mb']) * 1e6)
  const opened = new Map<string, Promise<OpenSource>>()
  const open = (spec: SourceSpec) => {
    let p = opened.get(spec.id)
    if (!p) opened.set(spec.id, (p = openSource(spec)))
    return p
  }

  // Bucket key (docs/hosting-r2.md): imagery/<product>/<area>/<period>.pmtiles.
  // Immutable once uploaded: a new quarter is a new key.
  const product = args.source === 'cdse' ? 's2-quarterly' : 's2-l2a'
  const period =
    args.source === 'cdse'
      ? label.slice(-7).toLowerCase() // 2026-q3
      : specs.map((s) => s.date).sort().at(-1)! // newest scene, 2026-09-18
  const key = imageryKey(product, area.name, period)
  const outPath = resolve(args.out!, key)
  mkdirSync(dirname(outPath), { recursive: true })
  const spool = new SpoolWriter(outPath, args.resume!)
  if (spool.count) console.log(`Resuming: ${spool.count} tiles already made`)

  const leaves = semaphore(16)
  const started = Date.now()
  let made = 0
  const total = countTiles(area, maxZoom).reduce((a, b) => a + b, 0)
  const progress = setInterval(() => {
    const s = (Date.now() - started) / 1000
    console.log(
      `  ${made.toLocaleString()} / ~${total.toLocaleString()} tiles · ${cache.loaded} blocks read · ` +
        `${fmtBytes(spool.bytes)} · ${Math.round(s)} s`,
    )
  }, 10_000)

  const renderLeaf = (tile: TileId) =>
    leaves(async () => {
      const [w, s, e, n] = tileBounds(tile)
      const wanted = specs.filter(({ bbox: [sw, ss, se, sn] }) => !(se < w || sw > e || sn < s || ss > n))
      const sources = await Promise.all(wanted.map(open))
      const plan = planTile(tile, sources)
      const blocks = new Map<string, Block>()
      const lookup: BlockLookup = { get: (src, level, bx, by) => blocks.get(`${src.id}|${level}|${bx}|${by}`) }
      const load = (priority: (p: number) => boolean) =>
        Promise.all(
          plan.entries
            .filter((entry) => priority(entry.source.priority ?? 0))
            .flatMap((entry) =>
              entry.blocks.map(async (b) => {
                blocks.set(`${b.source.id}|${b.level}|${b.bx}|${b.by}`, await cache.load(b.source as OpenSource, b.level, b.bx, b.by))
              }),
            ),
        )
      // Older quarters are read only when the main imagery leaves holes
      // (unloaded blocks count as no data in drawTile).
      await load((p) => p === 0)
      let rgba = drawTile(plan, lookup)
      if (!alphaStats(rgba).opaque && plan.entries.some((e) => (e.source.priority ?? 0) > 0)) {
        await load((p) => p > 0)
        rgba = drawTile(plan, lookup)
      }
      return rgba
    })

  const visit = async (tile: TileId): Promise<Uint8Array | null> => {
    if (!tileTouchesArea(tile, area)) return null
    const { z, x, y } = tile
    let rgba: Uint8Array | null
    if (z === maxZoom) {
      const saved = spool.read(z, x, y)
      rgba = saved ? await decode(saved) : await renderLeaf(tile)
    } else {
      rgba = downsample(await Promise.all(children(tile).map(visit)))
    }
    if (!rgba) return null
    const { empty, opaque } = alphaStats(rgba)
    if (empty) return null
    if (!spool.has(z, x, y)) spool.add(z, x, y, await encode(rgba, opaque))
    made++
    return rgba
  }

  await visit({ z: 0, x: 0, y: 0 })
  clearInterval(progress)

  const [w, s, e, n] = area.bbox
  const result = spool.finish({
    tileType: format === 'webp' ? PmTileType.Webp : PmTileType.Jpeg,
    tileCompression: PmCompression.None,
    minZoom: 0,
    maxZoom,
    bounds: [w, s, e, n],
    center: [(w + e) / 2, (s + n) / 2, Math.min(maxZoom, 6)],
    metadata: {
      name: `Sentinel-2 ${area.name.toUpperCase()}`,
      description: `${label}, true colour, 10 m. Built by carmanah-maps scripts/imagery.`,
      attribution,
      type: 'baselayer',
      format,
      version: new Date().toISOString().slice(0, 10),
      sources: specs.map((spec) => spec.id),
      stretch: TRUE_COLOUR,
    },
  })
  const secs = (Date.now() - started) / 1000
  console.log(
    `\nWrote ${outPath}\n  ${result.tiles.toLocaleString()} tiles, ${fmtBytes(result.bytes)}, ` +
      `${(result.bytes / result.tiles / 1000).toFixed(1)} KB a tile, ${cache.loaded} blocks read, ${Math.round(secs)} s\n` +
      `  Credit: ${attribution}`,
  )
  // The entry under catalog.json "sources.imagery" in the local bucket copy
  // (same shape as basemap and terrain; the bucket's LICENSE.txt points to it
  // for the licence and credit).
  const catalogPath = resolve(args.out!, 'catalog.json')
  const catalog = existsSync(catalogPath) ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as Catalog) : null
  const updated = addImageryEntry(catalog, {
    area: area.name,
    product,
    period,
    url: key,
    bounds: area.bbox,
    minzoom: 0,
    maxzoom: maxZoom,
    bytes: statSync(outPath).size,
    format,
    attribution,
    licence: COPERNICUS_LICENCE,
  })
  writeFileSync(catalogPath, JSON.stringify(updated, null, 2) + '\n')
  console.log(`  Catalog: ${relative(REPO, catalogPath)} (sources.imagery, ${area.name} ${product} ${period})`)
  // Publishing (docs/hosting-r2.md): the file first, the catalog last, so a
  // phone never sees an entry before its file.
  const local = (p: string) => `"${relative(REPO, p)}"`
  console.log(
    `\nTo publish (nothing was uploaded):\n` +
      `  node scripts/packs/upload.ts ${local(outPath)} ${key}\n` +
      `  node scripts/packs/upload.ts ${local(catalogPath)} catalog.json\n` +
      `  App: VITE_SATELLITE_PMTILES_URL=<bucket URL>/${key} in .github/workflows/deploy.yml (website)\n` +
      `       and for npm run build:embedded (crew app, docs/crew-app-handoff.md)`,
  )
}

const area = loadArea()
if (args.estimate) await estimate(area)
else await build(area)
