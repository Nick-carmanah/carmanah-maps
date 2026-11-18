import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LngLatBounds } from 'maplibre-gl'
import { TILE_CACHE_PATTERN } from '../vite.config'
import { SATELLITE_TILE_URL, TILEJSON_URL } from '../src/map/basemap'
import {
  estimateTileCount,
  packUrls,
  removeSavedSatelliteTiles,
  SATELLITE_HOST,
} from '../src/lib/mappacks'
import { FAILURES_FOR_NO_SIGNAL, SatelliteSignal } from '../src/lib/satellite-signal'

// Esri's terms for World Imagery don't allow keeping its tiles offline outside
// Esri software (docs/satellite-imagery-options.md), so satellite is online only.

const esriTile = SATELLITE_TILE_URL.replace('{z}', '14').replace('{y}', '5629').replace('{x}', '2602')

/** A small area near Kamloops, BC. */
const bounds = {
  getWest: () => -120.4,
  getEast: () => -120.3,
  getNorth: () => 50.72,
  getSouth: () => 50.66,
} as unknown as LngLatBounds

describe('the service worker', () => {
  it('never keeps satellite tiles', () => {
    expect(SATELLITE_HOST).toBe('https://server.arcgisonline.com/')
    expect(TILE_CACHE_PATTERN.test(esriTile)).toBe(false)
  })

  it('still keeps basemap, font and terrain tiles', () => {
    expect(TILE_CACHE_PATTERN.test('https://tiles.openfreemap.org/planet/20261018_080001_pt/14/2602/5629.pbf')).toBe(true)
    expect(TILE_CACHE_PATTERN.test('https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf')).toBe(true)
    expect(TILE_CACHE_PATTERN.test('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/650/1407.png')).toBe(true)
  })
})

describe('Save offline', () => {
  const urls = packUrls(bounds, 'https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf')

  it('downloads no satellite tiles', () => {
    expect(urls.length).toBeGreaterThan(estimateTileCount(bounds) - 1)
    expect(urls.filter((url) => url.startsWith(SATELLITE_HOST))).toEqual([])
    expect(urls.filter((url) => url.includes('World_Imagery'))).toEqual([])
  })

  it('downloads only what the service worker serves offline', () => {
    // Anything on another host must be one the service worker keeps; fonts
    // and icons bundled with the app are same-origin paths.
    const remote = urls.filter((url) => /^https?:/.test(url))
    expect(remote.filter((url) => !TILE_CACHE_PATTERN.test(url))).toEqual([])
    expect(TILEJSON_URL.startsWith(SATELLITE_HOST)).toBe(false)
  })
})

describe('satellite signal', () => {
  function makeSignal(online = true, probeOk = true) {
    const state = { online, probeOk, probes: 0 }
    const signal = new SatelliteSignal({
      isOnline: () => state.online,
      probe: async () => {
        state.probes++
        return state.probeOk
      },
    })
    const changes = vi.fn()
    signal.subscribe(changes)
    return { signal, state, changes }
  }

  it('has no signal when the phone says it is offline', () => {
    const { signal } = makeSignal(false)
    expect(signal.ok()).toBe(false)
    expect(signal.needsRecheck()).toBe(false)
  })

  it('has no signal after several satellite tiles fail in a row', () => {
    const { signal, changes } = makeSignal()
    for (let i = 1; i < FAILURES_FOR_NO_SIGNAL; i++) signal.tileFailed()
    expect(signal.ok()).toBe(true)
    expect(changes).not.toHaveBeenCalled()
    signal.tileFailed()
    expect(signal.ok()).toBe(false)
    expect(changes).toHaveBeenCalledTimes(1)
    expect(signal.needsRecheck()).toBe(true)
  })

  it('a tile that loads resets the count', () => {
    const { signal } = makeSignal()
    for (let i = 1; i < FAILURES_FOR_NO_SIGNAL; i++) signal.tileFailed()
    signal.tileLoaded()
    for (let i = 1; i < FAILURES_FOR_NO_SIGNAL; i++) signal.tileFailed()
    expect(signal.ok()).toBe(true)
  })

  it('comes back when a recheck loads a tile', async () => {
    const { signal, state, changes } = makeSignal(true, false)
    for (let i = 0; i < FAILURES_FOR_NO_SIGNAL; i++) signal.tileFailed()
    await signal.recheck()
    expect(signal.ok()).toBe(false)
    state.probeOk = true
    await signal.recheck()
    expect(signal.ok()).toBe(true)
    expect(state.probes).toBe(2)
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it("doesn't recheck while the phone is offline or tiles are loading", async () => {
    const offline = makeSignal(false)
    await offline.signal.recheck()
    expect(offline.state.probes).toBe(0)
    const fine = makeSignal()
    await fine.signal.recheck()
    expect(fine.state.probes).toBe(0)
  })

  it('starts afresh when the phone goes online or offline', () => {
    const { signal, state, changes } = makeSignal()
    for (let i = 0; i < FAILURES_FOR_NO_SIGNAL; i++) signal.tileFailed()
    state.online = false
    signal.networkChanged()
    expect(signal.ok()).toBe(false)
    state.online = true
    signal.networkChanged()
    expect(signal.ok()).toBe(true)
    expect(changes).toHaveBeenCalledTimes(3)
  })
})

describe('satellite tiles older versions kept', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage

  afterEach(() => {
    ;(globalThis as { caches?: unknown }).caches = originalCaches
    ;(globalThis as { localStorage?: unknown }).localStorage = originalStorage
  })

  function fakeCache(urls: string[]) {
    const entries = new Set(urls)
    const cache = {
      keys: async () => [...entries].map((url) => ({ url }) as Request),
      delete: async (request: Request) => entries.delete(request.url),
    }
    ;(globalThis as { caches?: unknown }).caches = {
      has: async (name: string) => name === 'map-tiles',
      open: async () => cache,
    }
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    return { entries, store }
  }

  it('removes only satellite tiles, then stops checking once none are left', async () => {
    const vector = 'https://tiles.openfreemap.org/planet/14/2602/5629.pbf'
    const terrain = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/650/1407.png'
    const { entries, store } = fakeCache([vector, esriTile, terrain, esriTile.replace('5629', '5630')])

    expect(await removeSavedSatelliteTiles()).toBe(2)
    expect([...entries]).toEqual([vector, terrain])
    expect(store.size).toBe(0) // checks again next start

    expect(await removeSavedSatelliteTiles()).toBe(0)
    expect(store.size).toBe(1)

    entries.add(esriTile)
    expect(await removeSavedSatelliteTiles()).toBe(0) // done for good
  })
})
