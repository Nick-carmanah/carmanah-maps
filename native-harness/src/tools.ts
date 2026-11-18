// Online tools page: download a real area, build PMTiles packs on the phone,
// and run the whole-fire scale test. Its CSP allows only the tile hosts and
// the Mac-side test server; the offline map page allows no network at all.

import { Directory, Filesystem } from '@capacitor/filesystem'
import {
  DIR, PACKS, appendBytes, exists, fmtBytes, hasNativeBase64, now, pool, readBytes, remove, saveResult,
  shuffle, summarize, takeCommand, writeBytes, writeText,
} from './fsx.ts'
import { planPack, tilesForBbox, PmCompression, PmTileType, type TileRef } from './pmtiles-write.ts'
import { SOURCES, archive, forgetArchives, loadManifest, packDir, pmtilesPath, readTile, tilePath, type PackManifest, type SrcId } from './pack.ts'

const OFM = 'https://tiles.openfreemap.org'
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
const MAC = 'http://localhost:8787'
// OpenFreeMap offline terms: each download at most 3,000 tiles or 50 MB, at
// most 4 parallel requests, unique User-Agent (set in capacitor.config.json).
const OFM_MAX_TILES = 3000
const OFM_MAX_BYTES = 50e6
const PARALLEL = 4
// Latin, Latin-1, Latin Extended A/B, IPA, spacing modifiers, combining
// marks (BC place names use these), Latin Extended Additional, punctuation.
const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '7680-7935', '8192-8447']

const logEl = document.getElementById('log')!
function log(msg: string) {
  const line = `${new Date().toISOString().slice(11, 19)} ${msg}`
  logEl.textContent = line + '\n' + logEl.textContent
  console.log('[tools]', msg)
}

// ---------------- 1. Download a real area ----------------

export async function downloadArea(name: string, bbox: [number, number, number, number], minZoom: number, maxZoom: number) {
  const dir = packDir(name)
  await remove(dir)
  const t0 = now()
  log(`Downloading ${name} z${minZoom}-${maxZoom} bbox ${bbox.join(',')}`)

  const tj = await (await fetch(`${OFM}/planet`)).json()
  const omtTemplate: string = tj.tiles[0]
  const style = await (await fetch(`${OFM}/styles/liberty`)).json()
  const coords = tilesForBbox(bbox, minZoom, maxZoom)
  if (coords.length > OFM_MAX_TILES) throw new Error(`${coords.length} tiles exceeds OpenFreeMap's ${OFM_MAX_TILES}-tile offline limit`)

  const tiles: PackManifest['tiles'] = { omt: [], terrain: [] }
  const timing: Record<SrcId, { fetchMs: number[]; writeMs: number[] }> = { omt: { fetchMs: [], writeMs: [] }, terrain: { fetchMs: [], writeMs: [] } }
  let ofmBytes = 0
  let ofmRequests = 2

  const jobs: { src: SrcId; z: number; x: number; y: number }[] = []
  for (const c of coords) for (const src of SOURCES) jobs.push({ src, ...c })
  let done = 0
  // One pool of 4 for everything: that keeps OpenFreeMap at <= 4 in flight.
  await pool(jobs, PARALLEL, async (j) => {
    const url = (j.src === 'omt' ? omtTemplate : TERRARIUM).replace('{z}', String(j.z)).replace('{x}', String(j.x)).replace('{y}', String(j.y))
    const f0 = now()
    const resp = await fetch(url)
    if (resp.status === 204 || resp.status === 404) return // empty tile upstream
    if (!resp.ok) throw new Error(`${resp.status} ${url}`)
    const bytes = new Uint8Array(await resp.arrayBuffer())
    const f1 = now()
    if (j.src === 'omt') {
      ofmBytes += bytes.length; ofmRequests++
      if (ofmBytes > OFM_MAX_BYTES) throw new Error('over OpenFreeMap 50 MB offline limit')
    }
    await writeBytes(tilePath(name, j.src, j.z, j.x, j.y), bytes)
    timing[j.src].fetchMs.push(f1 - f0)
    timing[j.src].writeMs.push(now() - f1)
    tiles[j.src].push([j.z, j.x, j.y, bytes.length])
    if (++done % 20 === 0) log(`  ${done}/${jobs.length} tiles`)
  })
  const tilesMs = now() - t0

  // Glyphs for every font stack the style uses, and the sprite sheets.
  const fontstacks = new Set<string>()
  for (const l of style.layers) {
    const tf = l.layout?.['text-font']
    if (Array.isArray(tf) && tf.every((v: unknown) => typeof v === 'string')) fontstacks.add(tf.join(','))
  }
  const assetJobs: { url: string; path: string }[] = []
  for (const fs of fontstacks) for (const r of GLYPH_RANGES) {
    assetJobs.push({ url: `${OFM}/fonts/${encodeURIComponent(fs)}/${r}.pbf`, path: `${dir}/glyphs/${fs}/${r}.pbf` })
  }
  const spriteBase: string = Array.isArray(style.sprite) ? style.sprite[0].url : style.sprite
  for (const f of ['ofm.json', 'ofm.png', 'ofm@2x.json', 'ofm@2x.png']) {
    assetJobs.push({ url: spriteBase.replace(/ofm$/, f), path: `${dir}/sprites/${f}` })
  }
  const missing: string[] = []
  let assetBytes = 0
  await pool(assetJobs, PARALLEL, async (a) => {
    const resp = await fetch(a.url)
    ofmRequests++
    if (!resp.ok) { missing.push(a.path); return }
    const bytes = new Uint8Array(await resp.arrayBuffer())
    assetBytes += bytes.length; ofmBytes += bytes.length
    await writeBytes(a.path, bytes)
  })

  // Rewrite the style to read from this pack. "pkfile://" is swapped for the
  // chosen read path when the map loads it.
  const attribution = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © OpenMapTiles © OpenStreetMap contributors · Terrain: Mapzen/AWS Terrain Tiles'
  delete style.sources.ne2_shaded
  style.layers = style.layers.filter((l: { source?: string }) => l.source !== 'ne2_shaded')
  style.sources.openmaptiles = { type: 'vector', tiles: [`pkfile://${name}/omt/{z}/{x}/{y}`], minzoom: minZoom, maxzoom: maxZoom, bounds: bbox, attribution }
  style.sources.terrain = { type: 'raster-dem', encoding: 'terrarium', tileSize: 256, tiles: [`pkfile://${name}/terrain/{z}/{x}/{y}`], minzoom: minZoom, maxzoom: maxZoom, bounds: bbox }
  const at = style.layers.findIndex((l: { id: string }) => l.id === 'waterway_tunnel')
  style.layers.splice(at, 0, { id: 'hillshade', type: 'hillshade', source: 'terrain', paint: { 'hillshade-exaggeration': 0.4, 'hillshade-shadow-color': '#473B24' } })
  style.glyphs = `pkasset://${name}/glyphs/{fontstack}/{range}.pbf`
  style.sprite = `pkasset://${name}/sprites/ofm`
  await writeText(`${dir}/style.json`, JSON.stringify(style))

  const sum = (src: SrcId) => tiles[src].reduce((s, t) => s + t[3], 0)
  const manifest: PackManifest = {
    name, created: new Date().toISOString(), bbox,
    center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], minZoom, maxZoom, attribution,
    upstream: { omt: omtTemplate, terrain: TERRARIUM, style: `${OFM}/styles/liberty`, sprite: spriteBase },
    tiles,
    glyphs: { fontstacks: [...fontstacks], ranges: GLYPH_RANGES, missing },
    download: {
      totalMs: Math.round(now() - t0), tilesMs: Math.round(tilesMs), parallel: PARALLEL,
      omt: { count: tiles.omt.length, bytes: sum('omt'), fetch: summarize(timing.omt.fetchMs), write: summarize(timing.omt.writeMs) },
      terrain: { count: tiles.terrain.length, bytes: sum('terrain'), fetch: summarize(timing.terrain.fetchMs), write: summarize(timing.terrain.writeMs) },
      assets: { count: assetJobs.length - missing.length, bytes: assetBytes, missing },
      openFreeMap: { requests: ofmRequests, bytes: ofmBytes },
    },
  }
  await writeText(`${dir}/pack.json`, JSON.stringify(manifest))
  log(`Done in ${(manifest.download!.totalMs as number / 1000).toFixed(1)} s: ${tiles.omt.length} vector (${fmtBytes(sum('omt'))}), ${tiles.terrain.length} terrain (${fmtBytes(sum('terrain'))}), ${assetJobs.length - missing.length} glyph/sprite files; OpenFreeMap ${ofmRequests} requests, ${fmtBytes(ofmBytes)}`)
  await saveResult(`download-${name}`, manifest.download)
  return manifest
}

// ---------------- 2. Build PMTiles on the phone ----------------

const CHUNK = 4 * 1024 * 1024

/** Stream a PMTiles file to disk: prefix first, then tile bytes in ~4 MB appends. */
async function writePack(path: string, tiles: TileRef[], info: Parameters<typeof planPack>[1], bytesFor: (t: TileRef) => Promise<Uint8Array>) {
  const t0 = now()
  const plan = planPack(tiles, info)
  await remove(path)
  await writeBytes(path, plan.prefix)
  let buf: Uint8Array[] = []
  let bufLen = 0
  let readMs = 0
  let appendMs = 0
  const flush = async () => {
    if (!bufLen) return
    const merged = new Uint8Array(bufLen)
    let o = 0
    for (const b of buf) { merged.set(b, o); o += b.length }
    const a0 = now()
    await appendBytes(path, merged)
    appendMs += now() - a0
    buf = []; bufLen = 0
  }
  for (const t of plan.tiles) {
    const r0 = now()
    const b = await bytesFor(t)
    readMs += now() - r0
    if (b.length !== t.length) throw new Error(`tile ${t.z}/${t.x}/${t.y} is ${b.length} B, planned ${t.length}`)
    buf.push(b); bufLen += b.length
    if (bufLen >= CHUNK) await flush()
  }
  await flush()
  const size = (await Filesystem.stat({ path, directory: DIR })).size
  if (size !== plan.totalLength) throw new Error(`pack is ${size} B, planned ${plan.totalLength}`)
  return { bytes: size, buildMs: Math.round(now() - t0), readMs: Math.round(readMs), appendMs: Math.round(appendMs), leafCount: plan.leafCount, rootDirBytes: plan.rootDirLength, leafDirBytes: plan.leafDirsLength }
}

export async function buildPacks(name: string) {
  const m = await loadManifest(name)
  const out: Record<string, unknown> = {}
  m.packed = {}
  for (const src of SOURCES) {
    const refs = m.tiles[src].map(([z, x, y, length]) => ({ z, x, y, length }))
    const r = await writePack(pmtilesPath(name, src), refs, {
      tileType: src === 'omt' ? PmTileType.Mvt : PmTileType.Png,
      tileCompression: PmCompression.None,
      minZoom: m.minZoom, maxZoom: m.maxZoom, bounds: m.bbox, center: [m.center[0], m.center[1], m.maxZoom - 1],
      metadata: { name: `${name} ${src}`, attribution: m.attribution, generator: 'carmanah-maps native-harness' },
    }, (t) => readBytes(tilePath(name, src, t.z, t.x, t.y)))
    m.packed[src] = { file: `${src}.pmtiles`, bytes: r.bytes, buildMs: r.buildMs, leafCount: r.leafCount }
    out[src] = r
    log(`Built ${src}.pmtiles: ${fmtBytes(r.bytes)} in ${r.buildMs} ms (${refs.length} tiles)`)
  }
  await writeText(`${packDir(name)}/pack.json`, JSON.stringify(m))
  // Round-trip check: every tile reads back identically through every path.
  forgetArchives()
  let checked = 0
  for (const src of SOURCES) for (const [z, x, y, len] of m.tiles[src]) {
    const a = await readTile('file', name, src, z, x, y)
    const b = await readTile('range', name, src, z, x, y)
    const c = await readTile('offset', name, src, z, x, y)
    if (!a || !b || !c || a.length !== len || b.length !== len || c.length !== len) throw new Error(`mismatch at ${src} ${z}/${x}/${y}`)
    for (let i = 0; i < len; i += 997) if (a[i] !== b[i] || a[i] !== c[i]) throw new Error(`byte mismatch at ${src} ${z}/${x}/${y}`)
    checked++
  }
  log(`Round-trip check OK: ${checked} tiles identical via file, range and offset`)
  await saveResult(`build-${name}`, { ...out, roundTripChecked: checked })
}

// ---------------- 3. Whole-fire scale test ----------------
//
// The Mac writes scale-plan.json (15,000 tile coordinates over a ~1.5M ha
// box, sizes sampled from the real downloaded tiles and scaled to a 40 kB
// mean) and scale.pmtiles. Payloads are random bytes: this measures storage
// and I/O, not rendering.

const SCALE = 'scale-test'
interface ScalePlan { tiles: [number, number, number, number][]; totalBytes: number; meanBytes: number; bboxNote: string }

let payloadPool: Uint8Array | null = null
function payload(t: TileRef): Uint8Array {
  if (!payloadPool) {
    payloadPool = new Uint8Array(2 * 1024 * 1024)
    for (let i = 0; i < payloadPool.length; i += 65536) crypto.getRandomValues(payloadPool.subarray(i, i + 65536))
  }
  const start = ((t.x * 7919 + t.y * 104729 + t.z * 31) % (payloadPool.length - t.length))
  return payloadPool.subarray(start, start + t.length)
}

async function scalePlan(): Promise<ScalePlan> {
  const resp = await fetch(`${MAC}/scale-plan.json`, { cache: 'no-store' })
  if (!resp.ok) throw new Error('Run `npm run serve-pack` on the Mac first')
  return resp.json()
}

export async function scaleWriteFiles(parallel = PARALLEL) {
  const plan = await scalePlan()
  const dir = `${packDir(SCALE)}/tiles/omt`
  await remove(dir)
  log(`Writing ${plan.tiles.length} tile files (${fmtBytes(plan.totalBytes)}), ${parallel} in parallel…`)
  const ms: number[] = []
  const t0 = now()
  let done = 0
  await pool(plan.tiles, parallel, async ([z, x, y, length]) => {
    const b = payload({ z, x, y, length })
    const w0 = now()
    await writeBytes(`${dir}/${z}/${x}/${y}.pbf`, b)
    ms.push(now() - w0)
    if (++done % 1000 === 0) log(`  ${done}/${plan.tiles.length} files, ${((now() - t0) / 1000).toFixed(1)} s`)
  })
  const totalMs = Math.round(now() - t0)
  log(`Wrote ${plan.tiles.length} files in ${(totalMs / 1000).toFixed(1)} s`)
  await saveResult('scale-write-files', { tiles: plan.tiles.length, bytes: plan.totalBytes, parallel, totalMs, perWrite: summarize(ms), nativeBase64: hasNativeBase64 })
}

export async function scaleBuildPack() {
  const plan = await scalePlan()
  const refs = plan.tiles.map(([z, x, y, length]) => ({ z, x, y, length }))
  log(`Building scale pack on the phone: ${refs.length} tiles, ${fmtBytes(plan.totalBytes)}…`)
  const r = await writePack(`${packDir(SCALE)}/omt-built-on-phone.pmtiles`, refs, {
    tileType: PmTileType.Mvt, tileCompression: PmCompression.None, minZoom: 6, maxZoom: 14,
    bounds: [-180, -85, 180, 85], center: [0, 0, 10], metadata: { name: 'scale test (synthetic)' },
  }, async (t) => payload(t))
  log(`Built in ${(r.buildMs / 1000).toFixed(1)} s (appends ${r.appendMs} ms), ${r.leafCount} leaf directories`)
  await saveResult('scale-build-pack', { tiles: refs.length, ...r })
}

export async function scaleDownloadPack() {
  const path = `${packDir(SCALE)}/omt.pmtiles`
  await remove(path)
  log('Downloading scale.pmtiles from the Mac with Filesystem.downloadFile…')
  let last = 0
  const h = await Filesystem.addListener('progress', (p) => {
    if (p.bytes - last > 100e6) { last = p.bytes; log(`  ${fmtBytes(p.bytes)} / ${fmtBytes(p.contentLength)}`) }
  })
  const t0 = now()
  // Filesystem 8.1.5's (legacy) downloadFile on iOS only knows DOCUMENTS,
  // CACHE and LIBRARY: LIBRARY_NO_CLOUD silently falls back to Documents,
  // which iCloud backs up. Library + "NoCloud/" is the same folder as
  // Directory.LibraryNoCloud.
  await Filesystem.downloadFile({ url: `${MAC}/scale.pmtiles`, path: `NoCloud/${path}`, directory: Directory.Library, progress: true })
  const ms = Math.round(now() - t0)
  await h.remove()
  const size = (await Filesystem.stat({ path, directory: DIR })).size
  log(`Downloaded ${fmtBytes(size)} in ${(ms / 1000).toFixed(1)} s`)
  await saveResult('scale-download-pack', { bytes: size, ms, mbPerSec: Math.round((size / 1e6 / (ms / 1000)) * 10) / 10 })
}

export async function scaleRead(sample = 1000, parallel = 6) {
  const plan = await scalePlan()
  const picks = shuffle(plan.tiles, 7).slice(0, sample)
  const out: Record<string, unknown> = { sample, parallel }
  forgetArchives()
  const packFile = `${packDir(SCALE)}/omt.pmtiles`
  if (!(await exists(packFile))) throw new Error('run the scale download first')
  // Open cost: header + root directory.
  for (const path of ['range', 'offset'] as const) {
    const o0 = now()
    const a = await archive(SCALE, 'omt', path, packFile)
    await a.getHeader()
    out[`${path}-open-ms`] = Math.round((now() - o0) * 100) / 100
  }
  const readers: Record<string, (z: number, x: number, y: number) => Promise<Uint8Array | null>> = {
    file: async (z, x, y) => { try { return await readBytes(`${packDir(SCALE)}/tiles/omt/${z}/${x}/${y}.pbf`) } catch { return null } },
    range: async (z, x, y) => { const r = await (await archive(SCALE, 'omt', 'range', packFile)).getZxy(z, x, y); return r ? new Uint8Array(r.data) : null },
    offset: async (z, x, y) => { const r = await (await archive(SCALE, 'omt', 'offset', packFile)).getZxy(z, x, y); return r ? new Uint8Array(r.data) : null },
  }
  for (const [name, read] of Object.entries(readers)) {
    for (const mode of ['sequential', 'parallel'] as const) {
      const ms: number[] = []
      let bytes = 0
      let bad = 0
      const t0 = now()
      await pool(picks, mode === 'sequential' ? 1 : parallel, async ([z, x, y, len]) => {
        const r0 = now()
        const b = await read(z, x, y)
        ms.push(now() - r0)
        if (!b || b.length !== len) bad++
        else bytes += b.length
      })
      const wall = now() - t0
      out[`${name}-${mode}`] = { ...summarize(ms), wallMs: Math.round(wall), tilesPerSec: Math.round(picks.length / (wall / 1000)), mbPerSec: Math.round((bytes / 1e6 / (wall / 1000)) * 10) / 10, bad }
      log(`${name} ${mode}: p50 ${summarize(ms).p50} ms, p95 ${summarize(ms).p95} ms, ${Math.round(picks.length / (wall / 1000))} tiles/s, bad ${bad}`)
    }
  }
  await saveResult('scale-read', out)
}

export async function scaleDelete() {
  const out: Record<string, number> = {}
  let t0 = now()
  await Filesystem.rmdir({ path: `${packDir(SCALE)}/tiles`, directory: DIR, recursive: true }).catch(() => {})
  out.rmdirFilesMs = Math.round(now() - t0)
  for (const f of ['omt.pmtiles', 'omt-built-on-phone.pmtiles']) {
    t0 = now()
    await Filesystem.deleteFile({ path: `${packDir(SCALE)}/${f}`, directory: DIR }).catch(() => {})
    out[`delete-${f}-ms`] = Math.round(now() - t0)
  }
  await remove(packDir(SCALE))
  log(`Deleted: ${JSON.stringify(out)}`)
  await saveResult('scale-delete', out)
}

// ---------------- wiring ----------------

const DEFAULT_AREA = { name: 'bc-sample', bbox: [-121.62, 50.215, -121.55, 50.26] as [number, number, number, number], minZoom: 6, maxZoom: 14 }

async function run(label: string, fn: () => Promise<unknown>) {
  log(`▶ ${label}`)
  try { await fn() } catch (e) {
    log(`✗ ${label}: ${(e as Error).message}`)
    await saveResult(`error-${label.replace(/\W+/g, '-')}`, { message: (e as Error).message, stack: (e as Error).stack })
  }
}

const actions: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  download: (a) => downloadArea((a.name as string) ?? DEFAULT_AREA.name, (a.bbox as [number, number, number, number]) ?? DEFAULT_AREA.bbox, (a.minZoom as number) ?? 6, (a.maxZoom as number) ?? 14),
  build: (a) => buildPacks((a.name as string) ?? DEFAULT_AREA.name),
  'scale-write-files': (a) => scaleWriteFiles((a.parallel as number) ?? PARALLEL),
  'scale-build-pack': () => scaleBuildPack(),
  'scale-download-pack': () => scaleDownloadPack(),
  'scale-read': (a) => scaleRead((a.sample as number) ?? 1000, (a.parallel as number) ?? 6),
  'scale-delete': () => scaleDelete(),
}

document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((b) => {
  b.onclick = () => run(b.dataset.action!, () => actions[b.dataset.action!]({}))
})

;(async () => {
  log(`Ready. Native base64: ${hasNativeBase64}. Packs in Library/NoCloud/${PACKS}.`)
  const cmd = await takeCommand('tools')
  if (!cmd) return
  const steps = cmd.action.split(',')
  for (const s of steps) await run(s, () => actions[s](cmd.args ?? {}))
  await saveResult('done', { steps })
  if (cmd.args?.thenOpenMap) location.href = './index.html'
})()

