// Offline map page. Its Content-Security-Policy (index.html) allows no http(s)
// requests at all, so everything on screen — tiles, terrain, glyphs, sprites —
// came out of Capacitor Filesystem storage through a MapLibre custom protocol.

import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { listPacks, now, pool, saveResult, shuffle, summarize, takeCommand } from './fsx.ts'
import {
  READ_PATHS, SOURCES, forgetArchives, loadManifest, missingGlyphs, readTile, registerProtocols, resetStats,
  stats, styleFor, type PackManifest, type ReadPath,
} from './pack.ts'

const $ = (id: string) => document.getElementById(id)!

// ---- proof that this page has no network ----
let blocked = 0
const blockedUrls: string[] = []
document.addEventListener('securitypolicyviolation', (e) => {
  blocked++
  if (blockedUrls.length < 20) blockedUrls.push(`${e.violatedDirective} ${e.blockedURI}`)
  hud()
})
let selfTest = 'running'
fetch('https://tiles.openfreemap.org/planet', { cache: 'no-store' })
  .then(() => { selfTest = 'FAILED: network reachable' })
  .catch(() => { selfTest = 'blocked ✓' })
  .finally(() => hud())

let path: ReadPath = (() => { try { return (localStorage.getItem('readPath') as ReadPath) || 'range' } catch { return 'range' } })()
let pack = ''
let manifest: PackManifest | null = null
let map: maplibregl.Map | null = null
let firstIdleMs = 0
let fadeDuration = 300

function hud() {
  const s = stats[`${path}/omt`]
  const sum = s ? summarize(s.ms) : null
  $('hud').innerHTML =
    `<b>OFFLINE</b> · CSP self-test: ${selfTest} · blocked requests: ${blocked}<br>` +
    `pack <b>${pack || '—'}</b> · read path <b>${path}</b>` +
    (sum && sum.n ? ` · ${sum.n} vector tiles, p50 ${sum.p50} ms, p95 ${sum.p95} ms` : '') +
    (firstIdleMs ? ` · first render ${Math.round(firstIdleMs)} ms` : '') +
    (missingGlyphs.size ? `<br>missing glyph ranges: ${[...missingGlyphs].join(', ')}` : '')
  document.querySelectorAll<HTMLButtonElement>('button[data-path]').forEach((b) => b.classList.toggle('on', b.dataset.path === path))
}

function idle(m: maplibregl.Map, timeout = 30000): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeout)
    m.once('idle', () => { clearTimeout(t); resolve(true) })
  })
}

async function setPath(p: ReadPath) {
  path = p
  try { localStorage.setItem('readPath', p) } catch { /* private mode */ }
  forgetArchives()
  resetStats()
  if (map) {
    const t0 = now()
    map.setStyle(await styleFor(pack, p), { diff: false })
    await idle(map)
    firstIdleMs = now() - t0
  }
  hud()
}

// ---- benchmarks ----

/** Pure tile reads, no rendering: every tile in the pack, random order. */
async function benchTiles(rounds = 3, parallel = 6) {
  if (!manifest) return
  const out: Record<string, unknown> = { pack, rounds, parallel, tiles: Object.fromEntries(SOURCES.map((s) => [s, manifest!.tiles[s].length])) }
  for (let round = 1; round <= rounds; round++) {
    // Rotate the order so no path always goes first.
    const order = READ_PATHS.map((_, i) => READ_PATHS[(i + round - 1) % READ_PATHS.length])
    for (const p of order) {
      forgetArchives()
      for (const src of SOURCES) {
        const tiles = shuffle(manifest.tiles[src], round * 13 + src.length)
        for (const mode of ['sequential', 'parallel'] as const) {
          const ms: number[] = []
          let bytes = 0
          let bad = 0
          const t0 = now()
          await pool(tiles, mode === 'sequential' ? 1 : parallel, async ([z, x, y, len]) => {
            const r0 = now()
            const b = await readTile(p, pack, src, z, x, y)
            ms.push(now() - r0)
            if (!b || b.length !== len) bad++
            else bytes += b.length
          })
          const wall = now() - t0
          out[`r${round}/${p}/${src}/${mode}`] = { ...summarize(ms), wallMs: Math.round(wall), tilesPerSec: Math.round(tiles.length / (wall / 1000)), mbPerSec: Math.round((bytes / 1e6 / (wall / 1000)) * 10) / 10, bad }
        }
      }
    }
    $('hud').textContent = `bench-tiles round ${round}/${rounds} done`
  }
  await saveResult(`bench-tiles-${pack}`, out)
  hud()
}

/** Real rendering: same camera script per read path, time to `idle` for each view. */
async function benchRender(rounds = 2) {
  if (!manifest || !map) return
  const [lon, lat] = manifest.center
  const views: { center: [number, number]; zoom: number }[] = [
    { center: [lon, lat], zoom: 8 }, { center: [lon, lat], zoom: 10 }, { center: [lon, lat], zoom: 12 },
    { center: [lon, lat], zoom: 13 }, { center: [lon, lat], zoom: 14 }, { center: [lon - 0.02, lat + 0.01], zoom: 14.5 },
    { center: [lon + 0.02, lat - 0.01], zoom: 15 }, { center: [lon, lat], zoom: 16 }, { center: [lon, lat], zoom: 11 },
  ]
  const out: Record<string, unknown> = { pack, views, fadeDuration }
  for (let round = 1; round <= rounds; round++) {
    const order = round % 2 ? READ_PATHS : [...READ_PATHS].reverse()
    for (const p of order) {
      map.jumpTo(views[0])
      await setPath(p)
      const styleMs = firstIdleMs
      const perView: number[] = []
      for (const v of views) {
        const wait = idle(map)
        const t0 = now()
        map.jumpTo(v)
        const ok = await wait
        perView.push(ok ? Math.round(now() - t0) : -1)
      }
      const snap = Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, { ...summarize(s.ms), bytes: s.bytes, misses: s.misses, errors: s.errors }]))
      out[`r${round}/${p}`] = { styleLoadToIdleMs: Math.round(styleMs), perViewIdleMs: perView, totalMs: perView.reduce((a, b) => a + b, 0), requests: snap }
    }
  }
  out.missingGlyphs = [...missingGlyphs]
  await saveResult(`bench-render-${pack}`, out)
  hud()
}

async function show(args: Record<string, unknown>) {
  if (!map) return
  if (args.path && args.path !== path) await setPath(args.path as ReadPath)
  const wait = idle(map)
  map.jumpTo({ center: (args.center as [number, number]) ?? manifest!.center, zoom: (args.zoom as number) ?? 13, bearing: (args.bearing as number) ?? 0 })
  await wait
  hud()
  await saveResult('shown', { path, center: map.getCenter(), zoom: map.getZoom(), blocked, blockedUrls, selfTest, missingGlyphs: [...missingGlyphs], stats: Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, { ...summarize(s.ms), bytes: s.bytes, misses: s.misses, errors: s.errors }])) })
}

// ---- boot ----

;(async () => {
  registerProtocols()
  document.querySelectorAll<HTMLButtonElement>('button[data-path]').forEach((b) => { b.onclick = () => setPath(b.dataset.path as ReadPath) })
  $('bench-tiles').onclick = () => benchTiles()
  $('bench-render').onclick = () => benchRender()

  const packs = (await listPacks()).filter((p) => p !== 'scale-test')
  pack = packs.includes('bc-sample') ? 'bc-sample' : packs[0] ?? ''
  hud()
  const cmd = await takeCommand('index')
  if (!pack) { $('hud').innerHTML += '<br>No pack yet — open Tools and download one.'; return }
  manifest = await loadManifest(pack)
  if (cmd?.args?.path) path = cmd.args.path as ReadPath
  if (typeof cmd?.args?.fadeDuration === 'number') fadeDuration = cmd.args.fadeDuration

  const t0 = now()
  map = new maplibregl.Map({
    container: 'map',
    style: await styleFor(pack, path),
    center: manifest.center,
    zoom: 13,
    minZoom: manifest.minZoom,
    maxZoom: 18,
    attributionControl: { compact: true },
    // bench-render can turn fades off so time-to-idle is tile loading, not animation.
    fadeDuration,
  })
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
  map.on('error', (e) => console.warn('[map]', e.error?.message))
  await idle(map)
  firstIdleMs = now() - t0
  hud()
  await saveResult(`first-render-${path}`, { ms: Math.round(firstIdleMs), stats: Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, summarize(s.ms)])) })

  if (cmd) {
    const args = cmd.args ?? {}
    if (cmd.action === 'bench-tiles') await benchTiles((args.rounds as number) ?? 3)
    else if (cmd.action === 'bench-render') await benchRender((args.rounds as number) ?? 2)
    else if (cmd.action === 'show') await show(args)
    await saveResult('done', { action: cmd.action })
  }
})()
