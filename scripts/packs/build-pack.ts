// Build offline map packs on this Mac. See docs/fire-packs.md.
//
//   node scripts/packs/build-pack.ts --bcws C40983                 a fire's current BCWS perimeter + 5 km
//   node scripts/packs/build-pack.ts --perimeter fire.kml --name "…" --fire K12345
//   node scripts/packs/build-pack.ts --bbox=-121.7,50.1,-121.4,50.3 --name "…"   (note the =)
//   node scripts/packs/build-pack.ts --area bc                     the BC-wide archives phones cut fires from
//   node scripts/packs/build-pack.ts --area region.geojson         the same for any outline
//   … --measure                                                    sizes only, no tiles downloaded
//
// Output goes to samples/packs/ by default (git ignores samples/). Publish
// with scripts/packs/publish.ts.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { bboxRing, ringsFromGeoJSON, ringsHectares, areaBbox, coverArea, simplifyArea, type Bbox, type PackArea } from '../../src/lib/packs/area.ts'
import { isPackId, packIdFor, type CatalogSource } from '../../src/lib/packs/manifest.ts'
import { BASEMAP_ATTRIBUTION, TERRAIN_ATTRIBUTION } from '../../src/lib/packs/manifest.ts'
import { buildPack, buildTerrain, measure, planCut, writeCut } from './build.ts'
import { latestPlanetBuild, ofmPlanetUrl, openSource, USER_AGENT } from './sources.ts'

const BCWS = 'https://services6.arcgis.com/ubm4tcTYICKBpist/ArcGIS/rest/services'

const { values: args } = parseArgs({
  options: {
    bcws: { type: 'string' },
    perimeter: { type: 'string' },
    bbox: { type: 'string' },
    area: { type: 'string' },
    name: { type: 'string' },
    fire: { type: 'string' },
    id: { type: 'string' },
    'buffer-km': { type: 'string' },
    out: { type: 'string', default: 'samples/packs' },
    basemap: { type: 'string', default: 'latest' },
    terrain: { type: 'string', default: 'aws' },
    'terrain-version': { type: 'string', default: 'v1' },
    zooms: { type: 'string' },
    'terrain-zooms': { type: 'string' },
    created: { type: 'string' },
    cache: { type: 'string', default: 'samples/cache' },
    measure: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const log = (s: string) => console.log(s)

function zooms(spec: string | undefined, fallback: [number, number]): [number, number] {
  if (!spec) return fallback
  const m = /^(\d+)-(\d+)$/.exec(spec)
  if (!m || +m[1] > +m[2] || +m[2] > 15) throw new Error(`bad zoom range ${spec} (e.g. 6-14)`)
  return [+m[1], +m[2]]
}

async function bcwsPerimeter(fire: string): Promise<{ rings: [number, number][][]; name: string; hectares?: number }> {
  const where = `FIRE_NUMBER='${fire.replace(/[^A-Za-z0-9]/g, '')}'`
  const q = (service: string, extra: Record<string, string>) =>
    `${BCWS}/${service}/FeatureServer/0/query?${new URLSearchParams({ where, outFields: '*', outSR: '4326', f: 'geojson', ...extra })}`
  const res = await fetch(q('BCWS_FirePerimeters_PublicView', {}), { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`BCWS perimeters: HTTP ${res.status}`)
  const geo = (await res.json()) as { features?: { properties?: Record<string, unknown> }[] }
  const rings = ringsFromGeoJSON(geo)
  if (!rings.length) throw new Error(`BCWS has no current perimeter for ${fire} (older fires: export the perimeter and use --perimeter)`)
  let name = fire
  try {
    const pts = (await (await fetch(q('BCWS_ActiveFires_PublicView', { returnGeometry: 'false' }))).json()) as {
      features?: { properties?: Record<string, unknown> }[]
    }
    const incident = pts.features?.[0]?.properties?.INCIDENT_NAME
    if (typeof incident === 'string' && incident.trim()) name = `${incident.trim()} (${fire})`
  } catch {
    // The name is a nicety.
  }
  const hectares = Number(geo.features?.[0]?.properties?.FIRE_SIZE_HECTARES) || undefined
  return { rings, name, hectares }
}

async function perimeterFile(path: string): Promise<[number, number][][]> {
  const text = readFileSync(path, 'utf8')
  if (/\.kml$/i.test(path) || text.trimStart().startsWith('<')) {
    const { JSDOM } = await import('jsdom')
    const { kml } = await import('@tmcw/togeojson')
    const doc = new JSDOM(text, { contentType: 'text/xml' }).window.document
    return ringsFromGeoJSON(kml(doc as unknown as Document))
  }
  return ringsFromGeoJSON(JSON.parse(text))
}

async function main() {
  if (args.help || !(args.bcws || args.perimeter || args.bbox || args.area)) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 11).join('\n'))
    process.exit(args.help ? 0 : 2)
  }
  const areaMode = !!args.area
  const bufferM = Number(args['buffer-km'] ?? (areaMode ? 0 : 5)) * 1000
  const basemapZooms = zooms(args.zooms, areaMode ? [0, 14] : [6, 14])
  const terrainZooms = zooms(args['terrain-zooms'], areaMode ? [0, 12] : [6, 12])

  let rings: [number, number][][]
  let name = args.name
  let fire = args.fire
  if (args.bcws) {
    const p = await bcwsPerimeter(args.bcws)
    rings = p.rings
    name ??= p.name
    fire ??= args.bcws.toUpperCase()
    log(`BCWS perimeter ${fire}: ${p.hectares ? `${Math.round(p.hectares)} ha (BCWS)` : ''}`)
  } else if (args.perimeter) {
    rings = await perimeterFile(args.perimeter)
    name ??= basename(args.perimeter).replace(/\.[^.]+$/, '')
  } else if (args.bbox) {
    const b = args.bbox.split(',').map(Number)
    if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) throw new Error('--bbox=west,south,east,north')
    rings = [bboxRing(b as Bbox)]
    name ??= `Area ${args.bbox}`
  } else {
    // A named area in scripts/packs/areas/, or a GeoJSON file (named after the file).
    const isFile = /\.(geo)?json$/i.test(args.area!)
    const file = isFile ? resolve(args.area!) : new URL(`./areas/${args.area}.geojson`, import.meta.url)
    if (!existsSync(file)) throw new Error(`no area "${args.area}" (scripts/packs/areas/<name>.geojson, or a .geojson file)`)
    if (isFile) args.area = basename(args.area!).replace(/\.(geo)?json$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    rings = ringsFromGeoJSON(JSON.parse(readFileSync(file, 'utf8')))
    name ??= args.area!
  }
  if (!rings.length) throw new Error('no polygon found in the input')
  const area: PackArea = { rings, bufferM }
  log(`Area: ${Math.round(ringsHectares(rings)).toLocaleString('en-CA')} ha inside the perimeter, ${bufferM / 1000} km buffer, bbox ${areaBbox(area).map((v) => v.toFixed(3)).join(', ')}`)

  const build = args.basemap === 'latest' ? await latestPlanetBuild() : undefined
  const basemapUrl = build ? ofmPlanetUrl(build) : args.basemap!
  const basemap = await openSource(basemapUrl, log)
  const basemapBuild = build ?? (/(\d{8}_\d{6}_pt)/.exec(basemapUrl)?.[1] || undefined)
  const created = args.created ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z')

  if (args.measure) {
    const m = await measure(basemap, area, basemapZooms, terrainZooms)
    log(`Basemap z${basemapZooms.join('–')}: ${m.basemap.tiles} tiles, ${(m.basemap.bytes / 1e6).toFixed(1)} MB (exact); ` +
      `${m.basemap.reads} reads totalling ${(m.basemap.readBytes / 1e6).toFixed(1)} MB; index read ${(m.basemap.indexBytes / 1e3).toFixed(0)} kB`)
    log(`Terrain z${terrainZooms.join('–')}: ${m.terrain.tiles} tiles, ~${(m.terrain.bytesEstimate / 1e6).toFixed(1)} MB (sampled)`)
    log(`Per zoom (basemap): ${m.perZoom.map((p) => `z${p.z} ${p.tiles}`).join(', ')}`)
    log(`Total ≈ ${((m.basemap.bytes + m.terrain.bytesEstimate) / 1e6).toFixed(0)} MB`)
    return
  }

  if (areaMode) {
    // The area-wide archives, laid out as their bucket keys under <out>/area-<name>/.
    const root = resolve(args.out!, `area-${args.area}`)
    const bKey = `basemap/${args.area}/${basemapBuild ?? 'custom'}.pmtiles`
    const tKey = `terrain/${args.area}/${args['terrain-version']}.pmtiles`
    const bounds = areaBbox(area)
    log(`Basemap → ${bKey}`)
    const cut = await planCut(basemap, area, basemapZooms[0], basemapZooms[1], { carmanah: { area: args.area, from: basemapUrl, build: basemapBuild } })
    log(`  ${cut.plan.tiles} tiles, ${(cut.plan.totalLength / 1e6).toFixed(0)} MB in ${cut.plan.reads.length} reads`)
    const b = await writeCut(basemap, cut.plan, join(root, bKey), log)
    let t
    const tPath = join(root, tKey)
    if (existsSync(tPath)) {
      log(`Terrain ${tKey} already built; keeping it (terrain doesn't change)`)
      t = { bytes: statSync(tPath).size }
    } else {
      log(`Terrain → ${tKey} (AWS Terrain Tiles; fetched tiles are kept in ${args.cache})`)
      const levels = coverArea(simplifyArea(area, terrainZooms[1]), terrainZooms[0], terrainZooms[1])
      t = await buildTerrain(levels, bounds, tPath, { minZoom: terrainZooms[0], maxZoom: terrainZooms[1], cacheDir: args.cache, log })
    }
    const round = (v: number) => Math.round(v * 1e4) / 1e4
    const sources: { basemap: CatalogSource[]; terrain: CatalogSource[] } = {
      basemap: [{ area: args.area!, url: bKey, ...(basemapBuild ? { build: basemapBuild } : {}), bounds: bounds.map(round) as Bbox, minzoom: basemapZooms[0], maxzoom: basemapZooms[1], bytes: b.bytes, attribution: BASEMAP_ATTRIBUTION }],
      terrain: [{ area: args.area!, url: tKey, version: args['terrain-version'], bounds: bounds.map(round) as Bbox, minzoom: terrainZooms[0], maxzoom: terrainZooms[1], bytes: t.bytes, attribution: TERRAIN_ATTRIBUTION }],
    }
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'sources.json'), `${JSON.stringify(sources, null, 2)}\n`)
    log(`Done: ${root} (publish with: node scripts/packs/publish.ts --area ${root})`)
    return
  }

  const id = args.id ?? packIdFor(fire ?? name!, created)
  if (!isPackId(id)) throw new Error(`bad pack id "${id}": lower-case letters, digits and - only`)
  const terrain = args.terrain === 'aws' ? null : await openSource(args.terrain!, log)
  const manifest = await buildPack({
    id,
    name: name!,
    fireNumber: fire,
    area,
    created,
    basemap,
    basemapBuild,
    terrain,
    basemapZooms,
    terrainZooms,
    outDir: resolve(args.out!),
    cacheDir: args.cache,
    log,
  })
  log(`Done: ${join(resolve(args.out!), id)} — ${(manifest.bytes / 1e6).toFixed(1)} MB ` +
    `(${manifest.files.map((f) => `${f.name} ${(f.bytes / 1e6).toFixed(1)} MB, ${f.tiles} tiles`).join('; ')})`)
}

main().catch((err) => {
  console.error((err as Error).message)
  process.exit(1)
})
