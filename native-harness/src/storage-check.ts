// Phase 0.3 check: the app's real storage code (src/lib/storage, src/lib/library)
// on the crew app's native side (Capacitor 8.6.0, Filesystem 8.1.5).
//
// Like the crew app's maps page, this page imports no Capacitor package by
// default: window.Capacitor comes from the native bridge iOS injects, and the
// store reaches Filesystem through it. With args.core it first loads
// @capacitor/core, as the crew app's injected /capacitor.js would.
//
// Steps (results in maps/_harness/results/storage-check*.json):
//   1. a shared basemap pack file in maps/_packs/ (must survive step 6)
//   2. open the owner's file store: backend 'native', range probe result
//   3. import a synthetic GeoPDF into the Maps library (tiles + original)
//   4. read every tile back through PMTiles by range; log every fetch's
//      Range header and status; then again through the readFile fallback
//   5. My Data + settings for the owner (IndexedDB, localStorage)
//   6. deleteOwnerData(owner): folder, database and settings gone, pack kept

import { PMTiles } from 'pmtiles'
import { buildGeoPdf, FIELD_MAP, TABLOID_LANDSCAPE } from '../../test/fixtures/geopdf-builder.ts'

const HARNESS = 'maps/_harness'
const DIR = 'LIBRARY_NO_CLOUD'
const log: string[] = []
const out = document.getElementById('out')!
function say(line: string) {
  log.push(line)
  out.textContent = log.join('\n')
  console.log('[storage-check]', line)
}

type Cap = { nativePromise(p: string, m: string, o?: unknown): Promise<any>; Plugins?: Record<string, unknown>; registerPlugin?: unknown }
const cap = () => (window as unknown as { Capacitor: Cap }).Capacitor
const fs = (method: string, options: unknown) => cap().nativePromise('Filesystem', method, options)

async function writeText(path: string, text: string) {
  await fs('writeFile', { path, directory: DIR, data: text, encoding: 'utf8', recursive: true })
}
async function readText(path: string): Promise<string | null> {
  try {
    return (await fs('readFile', { path, directory: DIR, encoding: 'utf8' })).data as string
  } catch {
    return null
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await fs('stat', { path, directory: DIR })
    return true
  } catch {
    return false
  }
}
async function listDir(path: string): Promise<string[]> {
  try {
    return ((await fs('readdir', { path, directory: DIR })).files as { name: string }[]).map((f) => f.name).sort()
  } catch {
    return []
  }
}

/** Every fetch the store makes, with its Range header and status. */
const fetches: { range: string | null; status: number; bytes: number }[] = []
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const resp = await realFetch(input, init)
  const range = new Headers(init?.headers).get('Range')
  fetches.push({ range, status: resp.status, bytes: Number(resp.headers.get('Content-Length') ?? -1) })
  return resp
}

async function run(args: Record<string, unknown>) {
  const ownerId = (args.owner as string) ?? 'sim-a'
  const result: Record<string, unknown> = { ownerId, withCore: !!args.core }
  if (args.core) await import('@capacitor/core')
  result.capacitor = {
    plugins: Object.keys(cap().Plugins ?? {}),
    registerPlugin: typeof cap().registerPlugin === 'function',
  }
  say(`capacitor.js loaded: ${!!args.core}; Plugins: ${JSON.stringify(result.capacitor)}`)

  // The crew app's hand-off names the owner.
  localStorage.setItem('carmanah.mapsContext.v1', JSON.stringify({ ownerId, fireNumber: 'K00000' }))

  // 1. A shared pack that deleteOwnerData must leave alone.
  await writeText('maps/_packs/sim-pack/pack.json', '{"id":"sim-pack"}')

  // 2. The file store.
  const { openFileStore } = await import('../../src/lib/storage/files.ts')
  const files = await openFileStore(ownerId)
  const rangeReads = (files as unknown as { rangeReads?: boolean }).rangeReads
  result.store = { backend: files.backend, rangeReads }
  say(`store: ${files.backend}, range reads after probe: ${rangeReads}`)
  if (files.backend !== 'native') throw new Error('expected the native backend')
  const uri = (await fs('getUri', { path: `maps/${ownerId}`, directory: DIR })).uri as string
  result.ownerFolderUri = uri.replace(/^.*\/data\/Containers\/Data\/Application\/[^/]+/, '<app>')
  say(`owner folder: ${result.ownerFolderUri}`)

  // 2b. A file bigger than one write chunk (4 MB): writeFile + appendFile into
  // a .part file, renamed into place; then replaced; read back by range.
  {
    const big = new Uint8Array(9 * 1024 * 1024 + 4321)
    for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, Math.min(i + 65536, big.length)))
    const tw = performance.now()
    await files.write('scratch/big.bin', [big.subarray(0, 1000), new Blob([big.subarray(1000)])])
    const writeMs = Math.round(performance.now() - tw)
    const samples = [0, 4 * 1024 * 1024 - 7, 4 * 1024 * 1024, 8 * 1024 * 1024 + 11, big.length - 100]
    let rangesOk = true
    for (const at of samples) {
      const got = new Uint8Array(await files.readRange('scratch/big.bin', at, 100))
      const want = big.subarray(at, at + 100)
      rangesOk &&= got.length === want.length && got.every((b, i) => b === want[i])
    }
    const whole = new Uint8Array(await (await files.read('scratch/big.bin'))!.arrayBuffer())
    const wholeOk = whole.length === big.length && whole.every((b, i) => b === big[i])
    await files.write('scratch/big.bin', [new Uint8Array([1, 2, 3])])
    const replaced = new Uint8Array(await files.readRange('scratch/big.bin', 0, 100))
    result.bigFile = {
      bytes: big.length,
      writeMs,
      rangesOk,
      wholeOk,
      replacedOk: replaced.join() === '1,2,3',
      sizeAfterReplace: await files.size('scratch/big.bin'),
      leftovers: (await listDir(`maps/${ownerId}/scratch`)).filter((n) => n !== 'big.bin'),
    }
    say(`big file: ${JSON.stringify(result.bigFile)}`)
    await files.removeDir('scratch')
  }

  // 3. Import a map (synthetic GeoPDF: nothing real in this public repo).
  const { MapsLibrary } = await import('../../src/lib/library/library.ts')
  const { importGeoPdf } = await import('../../src/lib/library/import.ts')
  const { bytes } = await buildGeoPdf([{ size: TABLOID_LANDSCAPE, frames: [FIELD_MAP] }])
  const library = await MapsLibrary.open(ownerId)
  const t0 = performance.now()
  const imported = await importGeoPdf(library, new File([bytes as Uint8Array<ArrayBuffer>], 'sim-field-map.pdf', { type: 'application/pdf' }), {
    folder: 'K00000',
    pickRegions: async (r) => r.regions,
    onProgress: (p) => say(`  import: ${p.label} ${Math.round(p.fraction * 100)}%`),
  })
  const importMs = Math.round(performance.now() - t0)
  const map = imported.maps[0]
  if (!map || map.raster.kind !== 'tiles') throw new Error(`import failed: ${JSON.stringify(imported.failed)}`)
  result.import = {
    ms: importMs,
    maps: imported.maps.length,
    failed: imported.failed,
    drawErrors: imported.drawErrors,
    raster: map.raster,
    storedBytes: map.storedBytes,
    originalPath: map.originalPath,
  }
  say(`imported "${map.name}": ${map.raster.tileCount} tiles, z${map.raster.minzoom}–${map.raster.maxzoom}, ${map.storedBytes} B in ${importMs} ms`)
  const onDisk = {
    pmtiles: await exists(`maps/${ownerId}/${map.raster.path}`),
    original: await exists(`maps/${ownerId}/${map.originalPath}`),
    partFiles: (await listDir(`maps/${ownerId}/library/maps/${map.id}`)).filter((n) => n.endsWith('.part')),
    listing: await listDir(`maps/${ownerId}/library`),
  }
  result.onDisk = onDisk
  say(`on disk: ${JSON.stringify(onDisk)}`)

  // The original reads back byte for byte (chunked range reads).
  const original = await library.readOriginal(map)
  const back = new Uint8Array(await original!.arrayBuffer())
  result.originalRoundTrip = back.length === bytes.length && back.every((b, i) => b === bytes[i])
  say(`original read back: ${back.length} B, identical: ${result.originalRoundTrip}`)

  // 4. Every tile back by range, as the map view's carmanah-map:// protocol does.
  async function readAllTiles(label: string) {
    const path = (map.raster as { path: string }).path
    const reader = new PMTiles({
      getKey: () => `${label}:${path}`,
      getBytes: async (offset: number, length: number) => ({ data: await files.readRange(path, offset, length) }),
    })
    const header = await reader.getHeader()
    let tiles = 0
    let tileBytes = 0
    const first = fetches.length
    const t = performance.now()
    for (let z = header.minZoom; z <= header.maxZoom; z++) {
      const n = 2 ** z
      const x0 = Math.floor(((header.minLon + 180) / 360) * n)
      const x1 = Math.floor(((header.maxLon + 180) / 360) * n)
      const y = (lat: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n)
      for (let x = x0; x <= x1; x++) for (let yy = y(header.maxLat); yy <= y(header.minLat); yy++) {
        const tile = await reader.getZxy(z, x, yy)
        if (tile) {
          tiles++
          tileBytes += tile.data.byteLength
        }
      }
    }
    const used = fetches.slice(first)
    return {
      tiles,
      tileBytes,
      ms: Math.round(performance.now() - t),
      fetches: used.length,
      statuses: [...new Set(used.map((f) => f.status))],
      withoutRange: used.filter((f) => !f.range).length,
      maxFetchBytes: Math.max(0, ...used.map((f) => f.bytes)),
    }
  }
  const byRange = await readAllTiles('range')
  result.readByRange = byRange
  say(`by range: ${JSON.stringify(byRange)}`)
  // The fallback path, on the same file.
  ;(files as unknown as { rangeReads: boolean }).rangeReads = false
  const byOffset = await readAllTiles('offset')
  ;(files as unknown as { rangeReads: boolean }).rangeReads = true
  result.readByOffset = byOffset
  say(`by readFile offset: ${JSON.stringify(byOffset)}`)
  if (byRange.tiles !== map.raster.tileCount || byOffset.tiles !== map.raster.tileCount) throw new Error('tile count mismatch')

  // 5. My Data and settings for this owner.
  const store = await import('../../src/lib/store.ts')
  const units = await import('../../src/lib/units.ts')
  await store.saveFeature({ id: 'sim-pin', kind: 'pin', name: 'Sim pin', notes: '', color: '#e11d1d', coordinates: [-123.37, 48.42], layerId: 'l', createdAt: 1, updatedAt: 1 } as never)
  units.setUnitSettings({ distance: 'chains' })
  const dbsBefore = (await indexedDB.databases()).map((d) => d.name).sort()
  result.before = {
    features: (await store.listFeatures()).map((f) => f.id),
    databases: dbsBefore,
    prefKeys: Object.keys(localStorage).filter((k) => k.startsWith(`carmanah-maps.${ownerId}.`)),
    ownerFolder: await listDir(`maps/${ownerId}`),
    packs: await listDir('maps/_packs'),
  }
  say(`before delete: ${JSON.stringify(result.before)}`)

  // 6. Account removal.
  const { deleteOwnerData } = await import('../../src/lib/storage/delete-owner.ts')
  const td = performance.now()
  await deleteOwnerData(ownerId)
  result.after = {
    ms: Math.round(performance.now() - td),
    databases: (await indexedDB.databases()).map((d) => d.name).sort(),
    prefKeys: Object.keys(localStorage).filter((k) => k.startsWith(`carmanah-maps.${ownerId}.`)),
    ownerFolderExists: await exists(`maps/${ownerId}`),
    maps: await listDir('maps'),
    pack: await readText('maps/_packs/sim-pack/pack.json'),
  }
  say(`after delete: ${JSON.stringify(result.after)}`)
  localStorage.removeItem('carmanah.mapsContext.v1')
  return result
}

async function save(name: string, data: unknown) {
  await writeText(`${HARNESS}/results/${name}.json`, JSON.stringify({ name, at: new Date().toISOString(), userAgent: navigator.userAgent, data, log }, null, 2))
}

;(async () => {
  let args: Record<string, unknown> = {}
  const cmd = await readText(`${HARNESS}/command.json`)
  if (cmd) {
    const parsed = JSON.parse(cmd)
    if (parsed.page === 'storage') {
      args = parsed.args ?? {}
      await fs('deleteFile', { path: `${HARNESS}/command.json`, directory: DIR }).catch(() => {})
    }
  }
  const name = `storage-check${args.core ? '-core' : ''}`
  try {
    const result = await run(args)
    await save(name, { ok: true, ...result })
    say('DONE ok')
  } catch (err) {
    say(`FAILED: ${(err as Error).stack ?? err}`)
    await save(name, { ok: false, error: String((err as Error).stack ?? err) })
  }
  await save('done', { action: 'storage-check' })
})()
