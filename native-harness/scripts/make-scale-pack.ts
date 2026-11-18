// Make the whole-fire scale-test pack on the Mac:
//
//   node scripts/make-scale-pack.ts [path/to/pack.json]
//
// Writes .scratch/scale-plan.json and .scratch/scale.pmtiles: about 15,000
// tiles as a z6–z14 pyramid (a 106 × 106 block at z14 plus its parents).
// That is the top of the field requirement: a 1M ha fire is ~5,500 vector +
// ~5,500 terrain tiles at z6–14, or ~15,000 vector tiles alone for ~2.7M ha.
//
// Tile sizes are sampled from the real downloaded vector tiles (pack.json
// pulled from the simulator) and scaled to a 40 kB mean, so the pack is
// ~0.6 GB like the largest real fire packs. Payloads are random bytes: the
// test measures storage and I/O, not rendering. Node runs this file directly
// (type stripping), using the same writer the app uses.

import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { planPack, PmCompression, PmTileType, type TileRef } from '../src/pmtiles-write.ts'

const out = join(import.meta.dirname, '..', '.scratch')
mkdirSync(out, { recursive: true })

const MEAN = 40_000
const N = 106 // z14 block is N × N tiles
const Z14_X0 = 2650 // anywhere; BC-ish (~121.8° W)
const Z14_Y0 = 5530 // ~50.6° N

// Real size distribution (z12–14 vector tiles), or a fallback.
let sample: number[] = []
const manifestPath = process.argv[2]
if (manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
  sample = (m.tiles.omt as number[][]).filter((t) => t[0] >= 12).map((t) => t[3])
}
if (sample.length < 5) sample = [12_000, 25_000, 38_000, 52_000, 70_000, 95_000]
const sampleMean = sample.reduce((a, b) => a + b, 0) / sample.length
const scale = MEAN / sampleMean

let seed = 1
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)

const tiles: TileRef[] = []
for (let z = 14; z >= 6; z--) {
  const d = 2 ** (14 - z)
  const x0 = Math.floor(Z14_X0 / d), x1 = Math.floor((Z14_X0 + N - 1) / d)
  const y0 = Math.floor(Z14_Y0 / d), y1 = Math.floor((Z14_Y0 + N - 1) / d)
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const base = sample[Math.floor(rnd() * sample.length)]
    const length = Math.max(200, Math.min(1_000_000, Math.round(base * scale * (0.85 + rnd() * 0.3))))
    tiles.push({ z, x, y, length })
  }
}
const totalBytes = tiles.reduce((s, t) => s + t.length, 0)

const plan = planPack(tiles, {
  tileType: PmTileType.Mvt, tileCompression: PmCompression.None, minZoom: 6, maxZoom: 14,
  bounds: [-180, -85, 180, 85], center: [0, 0, 10], metadata: { name: 'scale test (synthetic)' },
})

const pool = randomBytes(2 * 1024 * 1024)
const fd = openSync(join(out, 'scale.pmtiles'), 'w')
writeSync(fd, plan.prefix)
for (const t of plan.tiles) {
  const start = (t.x * 7919 + t.y * 104729 + t.z * 31) % (pool.length - t.length)
  writeSync(fd, pool, start, t.length)
}
closeSync(fd)

writeFileSync(join(out, 'scale-plan.json'), JSON.stringify({
  tiles: tiles.map((t) => [t.z, t.x, t.y, t.length]),
  totalBytes,
  meanBytes: Math.round(totalBytes / tiles.length),
  sampleFrom: manifestPath ? `${sample.length} real z12-14 vector tiles, mean ${Math.round(sampleMean)} B, scaled x${scale.toFixed(2)}` : 'fallback sizes',
  bboxNote: `z14 block ${N}x${N} at x=${Z14_X0}, y=${Z14_Y0} plus parents to z6`,
}))

console.log(JSON.stringify({
  tiles: tiles.length, totalBytes, meanBytes: Math.round(totalBytes / tiles.length),
  packBytes: plan.totalLength, rootDirBytes: plan.rootDirLength, leafDirBytes: plan.leafDirsLength, leafCount: plan.leafCount,
  directoryOverheadPct: Math.round(((plan.totalLength - totalBytes) / totalBytes) * 10000) / 100,
}, null, 2))
