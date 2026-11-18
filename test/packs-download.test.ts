/**
 * Downloading packs onto the phone (src/lib/packs/download.ts, manager.ts,
 * registry.ts, protocol.ts) against the crew app's native file store
 * (test/helpers/mock-capacitor.ts) and a fake bucket that serves byte
 * ranges, drops connections, and can change a file under a download.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { tileIdToZxy, zxyToTileId } from 'pmtiles'
import { mockCapacitor } from './helpers/mock-capacitor'
import { concat, fixtureTiles, makeArchive } from './helpers/pmtiles-fixture'
import { bboxRing, tileXToLon, tileYToLat, type PackArea } from '../src/lib/packs/area'
import { locateTiles, openArchive } from '../src/lib/packs/archive'
import { outputOf, planExtract } from '../src/lib/packs/extract'
import { manifestJson, parseManifest } from '../src/lib/packs/manifest'

const BASEMAP_TILES = fixtureTiles(4, 14, 330 << 4, 710 << 4, 96)
const TERRAIN_TILES = fixtureTiles(4, 12, 330 << 2, 710 << 2, 24).map((t) => ({ ...t, data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...t.data]) }))
const BASEMAP = makeArchive(BASEMAP_TILES, { leafSize: 500 })
const TERRAIN = makeArchive(TERRAIN_TILES, { leafSize: 200, tileType: 2 })
const basemapById = new Map(BASEMAP_TILES.map((t) => [zxyToTileId(t.z, t.x, t.y), t.data]))

// A "fire" well inside the fixtures (z14 tiles ~5290–5340 × 11370–11420).
const AREA: PackArea = {
  rings: [bboxRing([tileXToLon(5295, 14), tileYToLat(11410, 14), tileXToLon(5330, 14), tileYToLat(11375, 14)])],
  bufferM: 1000,
}
const BUCKET = 'https://tiles.example.test/'
/** Small reads, so this small fixture takes many (the app uses 32 kB / 2 MB). */
const READS = { gap: 256, max: 4096 }

/** A bucket on the network: Range, ETag, If-Range; drops and outages on demand. */
function fakeBucket() {
  const files: Record<string, Uint8Array> = { 'basemap/bc/b1.pmtiles': BASEMAP, 'terrain/bc/v1.pmtiles': TERRAIN }
  const state = { etag: '"v1"', down: false, dropEvery: 0, delayMs: 0, requests: 0, ranges: [] as string[], log: [] as { path: string; start: number }[] }
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith(BUCKET)) throw new TypeError(`no network for ${url}`)
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs))
    if (state.down) throw new TypeError('Failed to fetch')
    state.requests++
    if (state.dropEvery && state.requests % state.dropEvery === 0) throw new TypeError('The network connection was lost.')
    const bytes = files[url.slice(BUCKET.length)]
    if (!bytes) return new Response('NoSuchKey', { status: 404 })
    const h = new Headers(init?.headers)
    const range = h.get('Range')
    const ifRange = h.get('If-Range')
    if (!range || (ifRange && ifRange !== state.etag)) return new Response(bytes.slice(), { status: 200, headers: { ETag: state.etag } })
    state.ranges.push(range)
    const m = /^bytes=(\d+)-(\d+)$/.exec(range)!
    const start = +m[1]
    state.log.push({ path: url.slice(BUCKET.length), start })
    const end = Math.min(+m[2], bytes.length - 1)
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ETag: state.etag, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
    })
  })
  return { files, state, fetch }
}

/** What the Mac builder would write for the same area: the expected bytes. */
async function expectedCut(source: Uint8Array, zooms: [number, number], url: string) {
  const { coverArea, simplifyArea, tileIdsOf, areaBbox } = await import('../src/lib/packs/area')
  const read = async (o: number, l: number) => source.slice(o, o + l)
  const index = await openArchive(read)
  const ids = tileIdsOf(coverArea(simplifyArea(AREA, zooms[1]), zooms[0], zooms[1]), zooms[0], zooms[1])
  const b = areaBbox(AREA)
  const plan = planExtract(
    index,
    await locateTiles(index, ids),
    { minZoom: zooms[0], maxZoom: zooms[1], bounds: b, center: [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.min(zooms[1], zooms[0] + 4)], metadata: { ...index.metadata, carmanah: { from: url } } },
    { maxGap: READS.gap, maxRead: READS.max },
  )
  return plan
}

async function setup() {
  vi.resetModules()
  const cap = mockCapacitor()
  cap.install()
  const bucket = fakeBucket()
  const download = await import('../src/lib/packs/download')
  const { PackRegistry } = await import('../src/lib/packs/registry')
  const { openSharedPackFiles } = await import('../src/lib/storage/files')
  const registry = new PackRegistry(openSharedPackFiles)
  const store = (await registry.store())!
  const deps = { fetch: bucket.fetch as unknown as typeof fetch, wait: async () => {} }
  return { cap, bucket, download, registry, store, deps }
}

const req = { id: 'x12345-20261118', name: 'Test fire (X12345)', fireNumber: 'X12345', area: AREA }

afterEach(() => vi.unstubAllGlobals())

describe('cutting a fire from the bucket, on the phone', () => {
  let t: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    t = await setup()
  })

  it('knows the exact size before downloading, reading only the index', async () => {
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles`, build: 'b1' }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    const expected = await expectedCut(BASEMAP, [6, 14], `${BUCKET}basemap/bc/b1.pmtiles`)
    expect(planned.job.files[0].bytes).toBe(expected.totalLength)
    expect(planned.job.files[0].etag).toBe('"v1"')
    expect(planned.job.bytesTotal).toBe(planned.job.files[0].bytes + planned.job.files[1].bytes)
    const indexBytes = t.bucket.state.ranges.reduce((s, r) => {
      const [a, b] = r.slice(6).split('-').map(Number)
      return s + b - a + 1
    }, 0)
    expect(indexBytes).toBeLessThan(planned.job.bytesTotal)
  })

  it('downloads into maps/_packs/<id>/, survives drops, pauses and a restart, and matches the builder byte for byte', async () => {
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles`, build: 'b1' }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    expect(planned.plans.get('basemap.pmtiles')!.reads.length).toBeGreaterThan(1)
    // Every 4th request drops; pause partway through the basemap.
    t.bucket.state.dropEvery = 4
    const first = new AbortController()
    let waits = 0
    const run1 = t.download.runJob(planned.job, {
      store: t.store,
      deps: { ...t.deps, wait: async () => void waits++ },
      signal: first.signal,
      plans: planned.plans,
      onProgress: (p) => {
        if (p.done > planned.job.files[0].bytes / 2) first.abort()
      },
    })
    await expect(run1).rejects.toMatchObject({ name: 'AbortError' })
    expect(waits).toBeGreaterThan(0)
    const partPath = `maps/_packs/${req.id}/basemap.pmtiles.part`
    const partial = t.cap.file(partPath)!
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(planned.job.files[0].bytes)
    expect(t.cap.file(`maps/_packs/${req.id}/job.json`)).toBeDefined()

    // "Restart the app": a fresh registry finds the partial download.
    const { PackRegistry } = await import('../src/lib/packs/registry')
    const { openSharedPackFiles } = await import('../src/lib/storage/files')
    const again = new PackRegistry(openSharedPackFiles)
    await again.load()
    expect(again.packs).toEqual([])
    expect(again.jobs.map((j) => j.id)).toEqual([req.id])
    const job = (await t.download.readJob(t.store, req.id))!
    const before = t.bucket.state.log.length
    const manifest = await t.download.runJob(job, { store: t.store, deps: t.deps, signal: new AbortController().signal })

    // It carried on rather than starting again: after re-reading the index,
    // the basemap reads start past what was already on disk.
    const resumedReads = t.bucket.state.log.slice(before).filter((l) => l.path === 'basemap/bc/b1.pmtiles').map((l) => l.start)
    const expected = await expectedCut(BASEMAP, [6, 14], `${BUCKET}basemap/bc/b1.pmtiles`)
    const firstNeeded = expected.reads.find((r) => r.outEnd > partial.length)!.offset
    expect(resumedReads).toContain(firstNeeded)
    expect(resumedReads.filter((o) => o >= expected.reads[0].offset && o < firstNeeded)).toEqual([])

    // The finished file is exactly what the builder makes.
    const got = t.cap.file(`maps/_packs/${req.id}/basemap.pmtiles`)!
    const want = concat([expected.prefix, ...expected.reads.map((r) => outputOf(expected, r, BASEMAP.slice(r.offset, r.offset + r.length)))])
    expect(got).toEqual(want)
    expect(t.cap.file(partPath)).toBeUndefined()
    expect(t.cap.file(`maps/_packs/${req.id}/job.json`)).toBeUndefined()

    // pack.json describes what's on disk.
    const onDisk = parseManifest(JSON.parse(new TextDecoder().decode(t.cap.file(`maps/_packs/${req.id}/pack.json`)!)))
    expect(onDisk).toEqual(manifest)
    expect(onDisk.madeBy).toBe('app')
    for (const f of onDisk.files) {
      const bytes = t.cap.file(`maps/_packs/${req.id}/${f.name}`)!
      expect(bytes.length).toBe(f.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256)
    }

    // And the map can read it.
    await again.refresh()
    expect(again.packs.map((p) => p.id)).toEqual([req.id])
    const id = expected.reads.length && [...basemapById.keys()].find((k) => {
      const [z, x, y] = tileIdToZxy(k)
      return z === 14 && again.candidates('basemap', z, x, y).length > 0
    })!
    const [z, x, y] = tileIdToZxy(id)
    const tile = await again.tile('basemap', z, x, y)
    expect(new Uint8Array(tile!)).toEqual(basemapById.get(id))
  })

  it('stops with a clear error if the archive changes between pause and resume', async () => {
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles` }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    const ctl = new AbortController()
    await expect(
      t.download.runJob(planned.job, {
        store: t.store, deps: t.deps, signal: ctl.signal, plans: planned.plans,
        onProgress: (p) => p.done > planned.job.bytesTotal / 3 && ctl.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    t.bucket.state.etag = '"v2"' // replaced on the server
    const job = (await t.download.readJob(t.store, req.id))!
    await expect(t.download.runJob(job, { store: t.store, deps: t.deps, signal: new AbortController().signal })).rejects.toThrow(/changed/)
  })

  it('waits out an outage instead of failing', async () => {
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles` }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    let outage = 0
    t.bucket.state.down = true
    const progress: boolean[] = []
    const manifest = await t.download.runJob(planned.job, {
      store: t.store,
      deps: { ...t.deps, wait: async () => void (++outage > 5 && (t.bucket.state.down = false)) },
      signal: new AbortController().signal,
      plans: planned.plans,
      onProgress: (p) => progress.push(p.waiting),
    })
    expect(outage).toBeGreaterThan(5)
    expect(progress).toContain(true)
    expect(progress.at(-1)).toBe(false)
    expect(manifest.files).toHaveLength(2)
  })
})

describe('ready-made packs', () => {
  it('download whole with resume, and a damaged file is caught by its sha256', async () => {
    const t = await setup()
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
    const base = { minzoom: 6, maxzoom: 14, tiles: 1, attribution: 'x' }
    const manifest = {
      format: 'carmanah-pack', version: 1, id: 'ready-20261118', name: 'Ready', created: '2026-11-18T00:00:00Z',
      bbox: [-120, 50, -119, 51], bufferKm: 5, perimeter: null, areaHa: 1, attribution: 'x', madeBy: 'builder',
      files: [
        { ...base, name: 'basemap.pmtiles', source: 'basemap', format: 'mvt', bytes: BASEMAP.length, sha256: sha(BASEMAP) },
        { ...base, name: 'terrain.pmtiles', source: 'terrain', format: 'png', maxzoom: 12, bytes: TERRAIN.length, sha256: sha(TERRAIN) },
      ],
    }
    t.bucket.files['packs/ready-20261118/pack.json'] = new TextEncoder().encode(JSON.stringify(manifest))
    t.bucket.files['packs/ready-20261118/basemap.pmtiles'] = BASEMAP
    const damaged = TERRAIN.slice()
    damaged[damaged.length - 1] ^= 0xff
    t.bucket.files['packs/ready-20261118/terrain.pmtiles'] = damaged
    t.bucket.state.dropEvery = 3
    const planned = await t.download.planWhole(`${BUCKET}packs/ready-20261118/pack.json`, t.deps)
    await expect(t.download.runJob(planned.job, { store: t.store, deps: t.deps, signal: new AbortController().signal })).rejects.toThrow(/damaged/)
    // The good file stayed; the damaged one was thrown away, not renamed into place.
    expect(t.cap.file('maps/_packs/ready-20261118/basemap.pmtiles')).toEqual(BASEMAP)
    expect(t.cap.file('maps/_packs/ready-20261118/terrain.pmtiles')).toBeUndefined()
    expect(t.cap.file('maps/_packs/ready-20261118/terrain.pmtiles.part')).toBeUndefined()
    // Fixed on the server: the resume fetches only the terrain.
    t.bucket.files['packs/ready-20261118/terrain.pmtiles'] = TERRAIN
    const before = t.bucket.state.ranges.length
    const job = (await t.download.readJob(t.store, 'ready-20261118'))!
    const done = await t.download.runJob(job, { store: t.store, deps: t.deps, signal: new AbortController().signal })
    expect(done.id).toBe('ready-20261118')
    expect(t.bucket.state.ranges.length - before).toBe(Math.ceil(TERRAIN.length / (2 * 1024 * 1024)))
    expect(parseManifest(JSON.parse(new TextDecoder().decode(t.cap.file('maps/_packs/ready-20261118/pack.json')!)))).toMatchObject({ madeBy: 'builder' })
  })
})

describe('the map protocol', () => {
  it('serves tiles from packs, falls back to the network, and starts offline from a saved TileJSON', async () => {
    const t = await setup()
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles`, build: 'b20261115' }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    await t.download.runJob(planned.job, { store: t.store, deps: t.deps, signal: new AbortController().signal, plans: planned.plans })
    await t.registry.refresh()
    const { handlePackRequest, packTransformRequest, TILEJSON_URL } = await import('../src/lib/packs/protocol')

    // A tile inside the pack is rewritten to the protocol and read from the pack.
    const inside = [...basemapById.keys()].map((k) => tileIdToZxy(k)).find(([z, x, y]) => z === 13 && t.registry.candidates('basemap', z, x, y).length)!
    const net = `https://tiles.openfreemap.org/planet/b20261115/${inside.join('/')}.pbf`
    const rewritten = packTransformRequest(net, undefined, t.registry)!
    expect(rewritten.url).toMatch(/^carmanah-pack:\/\/tile\/basemap\//)
    const network = vi.fn(async () => new Response('from network'))
    const cache = new Map<string, unknown>()
    const deps = { registry: t.registry, fetch: network as unknown as typeof fetch, getCache: async (k: string) => cache.get(k), setCache: async (k: string, v: unknown) => void cache.set(k, v) }
    const got = await handlePackRequest(rewritten, new AbortController(), deps)
    expect(new Uint8Array(got.data as ArrayBuffer)).toEqual(basemapById.get(zxyToTileId(...(inside as [number, number, number]))))
    expect(network).not.toHaveBeenCalled()

    // Far away: not rewritten at all once the pack list is known.
    expect(packTransformRequest('https://tiles.openfreemap.org/planet/b/14/1/1.pbf', undefined, t.registry)).toBeUndefined()
    // In the pack's box but not in the pack (outside the cut): the network.
    expect(packTransformRequest('https://example.com/other.png', undefined, t.registry)).toBeUndefined()

    // TileJSON: online it's fetched and saved; offline the saved copy is used.
    const tj = { tiles: ['https://tiles.openfreemap.org/planet/b20261115/{z}/{x}/{y}.pbf'] }
    const online = vi.fn(async () => Response.json(tj))
    expect(packTransformRequest(TILEJSON_URL, undefined, t.registry)).toEqual({ url: 'carmanah-pack://tilejson' })
    expect((await handlePackRequest({ url: 'carmanah-pack://tilejson' }, new AbortController(), { ...deps, fetch: online as unknown as typeof fetch })).data).toEqual(tj)
    expect(cache.get('openfreemap-tilejson')).toEqual(tj)
  })

  it('builds a TileJSON from the newest pack when nothing was ever saved', async () => {
    const t = await setup()
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles`, build: '20261115_080022_pt' }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    await t.download.runJob(planned.job, { store: t.store, deps: t.deps, signal: new AbortController().signal, plans: planned.plans })
    await t.registry.refresh()
    vi.resetModules() // forget the protocol's in-memory copy
    const { handlePackRequest } = await import('../src/lib/packs/protocol')
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const res = await handlePackRequest({ url: 'carmanah-pack://tilejson' }, new AbortController(), {
      registry: t.registry,
      fetch: offline as unknown as typeof fetch,
      getCache: async () => undefined,
      setCache: async () => {},
    })
    expect((res.data as { tiles: string[] }).tiles[0]).toBe('https://tiles.openfreemap.org/planet/20261115_080022_pt/{z}/{x}/{y}.pbf')
  })
})

describe('download manager', () => {
  it('resumes, on the next start, a download that was running when the app closed', async () => {
    const t = await setup()
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles` }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    const ctl = new AbortController()
    // Simulate the app being killed: the run stops without the manager marking it paused.
    await expect(
      t.download.runJob(planned.job, { store: t.store, deps: t.deps, signal: ctl.signal, plans: planned.plans, onProgress: (p) => p.done > planned.job.bytesTotal / 3 && ctl.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    const { PackDownloads } = await import('../src/lib/packs/manager')
    const { PackRegistry } = await import('../src/lib/packs/registry')
    const { openSharedPackFiles } = await import('../src/lib/storage/files')
    const registry = new PackRegistry(openSharedPackFiles)
    const done: string[] = []
    const manager = new PackDownloads(registry, () => t.deps, (m) => done.push(m.id))
    await manager.resumeInterrupted()
    await vi.waitFor(() => expect(done).toEqual([req.id]))
    await vi.waitFor(() => expect(registry.packs.map((p) => p.id)).toEqual([req.id]))
    expect(registry.jobs).toEqual([])

    // Deleting removes the folder.
    await manager.remove(req.id)
    expect(t.cap.paths().filter((p) => p.startsWith(`maps/_packs/${req.id}`))).toEqual([])
  })

  it('a paused download is not resumed by itself', async () => {
    const t = await setup()
    const planned = await t.download.planCut(req, { url: `${BUCKET}basemap/bc/b1.pmtiles` }, { url: `${BUCKET}terrain/bc/v1.pmtiles` }, t.deps, undefined, READS)
    const { PackDownloads } = await import('../src/lib/packs/manager')
    const manager = new PackDownloads(t.registry, () => t.deps)
    t.bucket.state.delayMs = 20
    const started = manager.start(planned)
    await vi.waitFor(() => expect(manager.active.get(req.id)?.progress.done).toBeGreaterThan(0))
    manager.pause(req.id)
    await started
    const job = (await t.download.readJob(t.store, req.id))!
    expect(job.state).toBe('paused')
    expect(job.wasRunning).toBe(false)
    const fresh = new PackDownloads(t.registry, () => t.deps)
    await fresh.resumeInterrupted()
    expect(fresh.active.size).toBe(0)
  })
})

describe('pack.json from the phone', () => {
  it('round-trips', () => {
    const m = parseManifest(JSON.parse(manifestJson(parseManifest({
      format: 'carmanah-pack', version: 1, id: 'a-1', name: 'A', created: 'x', bbox: [0, 0, 1, 1], bufferKm: 5, perimeter: null, areaHa: 1,
      files: [{ name: 'basemap.pmtiles', source: 'basemap', format: 'mvt', minzoom: 6, maxzoom: 14, tiles: 1, bytes: 1, sha256: 'b'.repeat(64), attribution: '' }],
      attribution: '', madeBy: 'app',
    }))))
    expect(m.madeBy).toBe('app')
  })
})

describe('small areas straight from OpenFreeMap', () => {
  it('fetches the tiles 4 at a time and writes one pack, within the 3,000-tile limit', async () => {
    const t = await setup()
    const seen = { inFlight: 0, max: 0, ofm: 0, aws: 0 }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://tiles.openfreemap.org/planet') return Response.json({ tiles: ['https://tiles.openfreemap.org/planet/20261115_080022_pt/{z}/{x}/{y}.pbf'] })
      seen.inFlight++
      seen.max = Math.max(seen.max, seen.inFlight)
      await new Promise((r) => setTimeout(r, 1))
      seen.inFlight--
      if (url.includes('openfreemap')) {
        seen.ofm++
        return new Response(new Uint8Array([0x1a, 0x02, 0x78, 0x01]))
      }
      seen.aws++
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    })
    const small: PackArea = { rings: [bboxRing([-121.62, 50.215, -121.55, 50.26])], bufferM: 0 }
    const manifest = await t.download.downloadSmallArea(
      { id: 'view-20261118', name: 'Map view', area: small },
      {
        store: t.store,
        signal: new AbortController().signal,
        tileJsonUrl: 'https://tiles.openfreemap.org/planet',
        terrainUrl: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
        deps: { fetch: fetchImpl as unknown as typeof fetch, wait: async () => {} },
      },
    )
    const plan = t.download.planSmall(small)
    expect(seen.ofm).toBe(plan.basemap.length)
    expect(seen.aws).toBe(plan.terrain.length)
    expect(seen.max).toBeLessThanOrEqual(4)
    expect(manifest.files.map((f) => f.tiles)).toEqual([plan.basemap.length, plan.terrain.length])
    expect(manifest.files[0].build).toBe('20261115_080022_pt')
    for (const f of manifest.files) {
      const bytes = t.cap.file(`maps/_packs/view-20261118/${f.name}`)!
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256)
    }
    await t.registry.refresh()
    const [z, x, y] = [plan.basemap[0].z, plan.basemap[0].x, plan.basemap[0].y]
    expect(new Uint8Array((await t.registry.tile('basemap', z, x, y))!)).toEqual(new Uint8Array([0x1a, 0x02, 0x78, 0x01]))
  })

  it('refuses an area over 3,000 basemap tiles', async () => {
    const t = await setup()
    const big: PackArea = { rings: [bboxRing([-122, 50, -121, 51])], bufferM: 0 }
    await expect(
      t.download.downloadSmallArea({ id: 'big-1', name: 'Big', area: big }, {
        store: t.store, signal: new AbortController().signal, tileJsonUrl: 'x', terrainUrl: () => 'y', deps: t.deps,
      }),
    ).rejects.toThrow(/limit is 3000/)
  })
})
