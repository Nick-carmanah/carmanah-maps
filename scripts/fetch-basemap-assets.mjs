#!/usr/bin/env node
// Refreshes the label fonts and map icons the basemap draws with, kept in
// public/basemap/ so labels and symbols draw offline from the first launch
// (no glyph or sprite request ever leaves the app). Run it when
// src/map/openfreemap-liberty.json is refreshed or GLYPH_RANGES changes:
//
//   node scripts/fetch-basemap-assets.mjs
//
// Sources and licences:
//  - fonts/<font>/<range>.pbf: OpenFreeMap's glyph PBFs of Noto Sans
//    (SIL Open Font License 1.1; fonts/OFL.txt ships beside them).
//  - sprites/ofm*.{json,png}: OpenFreeMap's ofm_f384 sprite (Maki icons, CC0;
//    OpenMapTiles design, CC BY 4.0, credited in the map's attribution).
//
// 18 glyph files and 4 sprite files, ~1.8 MB: far inside OpenFreeMap's terms.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'basemap')
const style = JSON.parse(await readFile(join(ROOT, 'src/map/openfreemap-liberty.json'), 'utf8'))
// Keep in step with GLYPH_RANGES in src/map/basemap.ts.
const RANGES = ['0-255', '256-511', '512-767', '768-1023', '7680-7935', '8192-8447']

const fonts = new Set(['Noto Sans Regular'])
for (const layer of style.layers) {
  const font = layer.layout?.['text-font']
  if (Array.isArray(font)) fonts.add(font.join(','))
}

const jobs = []
for (const font of fonts) {
  for (const range of RANGES) {
    jobs.push({
      url: style.glyphs.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range),
      path: join(OUT, 'fonts', font, `${range}.pbf`),
    })
  }
}
for (const name of ['ofm.json', 'ofm.png', 'ofm@2x.json', 'ofm@2x.png']) {
  jobs.push({ url: style.sprite.replace(/ofm$/, name), path: join(OUT, 'sprites', name) })
}

for (const { url, path } of jobs) {
  const res = await fetch(url, { headers: { 'User-Agent': 'CarmanahMaps-build/0.1' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  console.log(`${String(bytes.length).padStart(7)}  ${path.slice(ROOT.length + 1)}`)
}
