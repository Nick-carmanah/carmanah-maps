/**
 * My Maps (Avenza's model): "you are here", distances and nearest-first
 * sorting; and which map reopens at launch, remembered per person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Position } from 'geojson'
import { metresPerDegree } from '../src/lib/geodesic'
import { containsPoint, distanceToMapM, mapDistances, roughDistance, sortByDistance } from '../src/lib/library/nearby'
import {
  BASE_MAP,
  parseMapChoice,
  readBasemapAround,
  readLastMap,
  readMapsSort,
  saveBasemapAround,
  saveLastMap,
  saveMapsSort,
  serializeMapChoice,
  startupChoice,
  type MapChoice,
} from '../src/lib/library/viewer'
import type { Corners } from '../src/lib/library/types'

/** A frame rotated like a UTM map in BC (grid convergence ~2°): corners TL, TR, BR, BL. */
function frame(lon: number, lat: number, wKm: number, hKm: number, rotDeg = 2): Corners {
  // Metres per degree on WGS84 at the frame's latitude.
  const { east: kx, north: ky } = metresPerDegree(lat)
  const r = (rotDeg * Math.PI) / 180
  const pt = (dx: number, dy: number): Position => {
    const x = dx * Math.cos(r) - dy * Math.sin(r)
    const y = dx * Math.sin(r) + dy * Math.cos(r)
    return [lon + (x * 1000) / kx, lat + (y * 1000) / ky]
  }
  return [pt(-wKm / 2, hKm / 2), pt(wKm / 2, hKm / 2), pt(wKm / 2, -hKm / 2), pt(-wKm / 2, -hKm / 2)]
}

/** A point `km` east (or west, negative) of a position, along its parallel. */
const east = ([lon, lat]: Position, km: number): Position => [lon + (km * 1000) / metresPerDegree(lat).east, lat]
const north = ([lon, lat]: Position, km: number): Position => [lon, lat + (km * 1000) / metresPerDegree(lat).north]

const CENTRE: Position = [-120.35, 50.67]
const MAP = frame(CENTRE[0], CENTRE[1], 8, 6)

describe('containsPoint', () => {
  it('is true inside the frame and false outside', () => {
    expect(containsPoint(MAP, CENTRE)).toBe(true)
    expect(containsPoint(MAP, east(CENTRE, 3.5))).toBe(true)
    expect(containsPoint(MAP, north(CENTRE, 2.8))).toBe(true)
    expect(containsPoint(MAP, east(CENTRE, 4.5))).toBe(false)
    expect(containsPoint(MAP, north(CENTRE, 3.4))).toBe(false)
    expect(containsPoint(MAP, east(CENTRE, -50))).toBe(false)
  })

  it('follows the rotated edge, not the bounding box', () => {
    // Just inside the bounding box's corner but outside the tilted frame.
    const [tl] = MAP
    const bboxCorner: Position = [Math.min(...MAP.map((c) => c[0])), Math.max(...MAP.map((c) => c[1]))]
    expect(containsPoint(MAP, bboxCorner)).toBe(false)
    expect(containsPoint(MAP, tl)).toBe(true) // a corner is on the edge
  })

  it('works whichever way round the corners go', () => {
    const reversed = [...MAP].reverse() as Corners
    expect(containsPoint(reversed, CENTRE)).toBe(true)
    expect(containsPoint(reversed, east(CENTRE, 6))).toBe(false)
  })
})

describe('distanceToMapM', () => {
  it('is 0 inside', () => {
    expect(distanceToMapM(MAP, CENTRE)).toBe(0)
  })

  it('measures to the nearest edge, within a few metres', () => {
    // An unrotated frame makes the expected distances exact.
    const square = frame(CENTRE[0], CENTRE[1], 8, 6, 0)
    expect(distanceToMapM(square, east(CENTRE, 10))).toBeCloseTo(6000, -1)
    expect(distanceToMapM(square, north(CENTRE, -5))).toBeCloseTo(2000, -1)
    // Off a corner: the straight line to the corner.
    const offCorner = north(east(CENTRE, 7), 6)
    expect(distanceToMapM(square, offCorner)).toBeCloseTo(Math.hypot(3000, 3000), -1)
  })

  it('stays sensible for a map far away (another fire)', () => {
    const far = frame(-123.1, 49.3, 8, 6) // ~250 km south-west
    const d = distanceToMapM(far, CENTRE)
    expect(d).toBeGreaterThan(200_000)
    expect(d).toBeLessThan(300_000)
  })
})

describe('mapDistances / sortByDistance', () => {
  const maps = [
    { id: 'far', corners: frame(-123.1, 49.3, 8, 6) },
    { id: 'here', corners: MAP },
    { id: 'near', corners: frame(east(CENTRE, 20)[0], CENTRE[1], 8, 6) },
    { id: 'also-here', corners: frame(CENTRE[0], CENTRE[1], 2, 2) },
  ]

  it('marks the maps you are on', () => {
    const d = mapDistances(maps, CENTRE)
    expect([...d].filter(([, v]) => v.inside).map(([id]) => id).sort()).toEqual(['also-here', 'here'])
    expect(d.get('near')!.metres).toBeCloseTo(16000, -2)
  })

  it('sorts maps you are on first, then nearest, keeping order on ties', () => {
    const sorted = sortByDistance(maps, mapDistances(maps, CENTRE)).map((m) => m.id)
    expect(sorted).toEqual(['here', 'also-here', 'near', 'far'])
  })

  it('leaves the list as it was without a position', () => {
    expect(mapDistances(maps, null).size).toBe(0)
    expect(sortByDistance(maps, mapDistances(maps, null)).map((m) => m.id)).toEqual(['far', 'here', 'near', 'also-here'])
  })
})

describe('roughDistance', () => {
  it('rounds the number for a list, in any unit', () => {
    expect(roughDistance('163.77 km')).toBe('164 km')
    expect(roughDistance('41.28 km')).toBe('41 km')
    expect(roughDistance('3.46 km')).toBe('3.5 km')
    expect(roughDistance('1.00 km')).toBe('1 km')
    expect(roughDistance('640 m')).toBe('640 m')
    expect(roughDistance('12.40 mi')).toBe('12 mi')
    expect(roughDistance('0.25 NM')).toBe('0.3 NM')
    expect(roughDistance('820 ft')).toBe('820 ft')
    expect(roughDistance('48.5 ch')).toBe('49 ch')
  })
})

describe('map choice', () => {
  it('round-trips the base map and a map', () => {
    const choices: MapChoice[] = [BASE_MAP, { kind: 'map', id: '0f8e4c1a-3b2d-4e5f-9a6b-7c8d9e0f1a2b' }]
    for (const c of choices) expect(parseMapChoice(serializeMapChoice(c))).toEqual(c)
  })

  it('reads anything unexpected as nothing remembered', () => {
    for (const raw of [null, '', 'map:', 'map:../x', 'map:a b', 'Base', '{"kind":"base"}', `map:${'x'.repeat(81)}`]) {
      expect(parseMapChoice(raw), String(raw)).toBeNull()
    }
  })

  it('opens on My Maps the first time, and back in the last map after', () => {
    const map: MapChoice = { kind: 'map', id: 'm1' }
    expect(startupChoice(null, null)).toBeNull()
    expect(startupChoice(BASE_MAP, new Set())).toEqual(BASE_MAP)
    // While the library loads, trust the remembered map…
    expect(startupChoice(map, null)).toEqual(map)
    // …and fall back to My Maps if it has since been deleted.
    expect(startupChoice(map, new Set(['m1', 'm2']))).toEqual(map)
    expect(startupChoice(map, new Set(['m2']))).toBeNull()
  })
})

describe('remembered per person', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("keeps each person's last map apart", () => {
    saveLastMap('u1', { kind: 'map', id: 'a' })
    saveLastMap('u2', BASE_MAP)
    expect(readLastMap('u1')).toEqual({ kind: 'map', id: 'a' })
    expect(readLastMap('u2')).toEqual(BASE_MAP)
    expect(readLastMap('guest')).toBeNull()
    // Under the person's prefix, so deleting their data removes it.
    expect([...store.keys()].sort()).toEqual(['carmanah-maps.u1.lastMap', 'carmanah-maps.u2.lastMap'])
  })

  it('forgets a last map when told (it was deleted)', () => {
    saveLastMap('u1', { kind: 'map', id: 'a' })
    saveLastMap('u1', null)
    expect(readLastMap('u1')).toBeNull()
    expect(store.size).toBe(0)
  })

  it('remembers "show base map around this map" and the sort, per person, off/by fire by default', () => {
    expect(readBasemapAround('u1')).toBe(false)
    expect(readMapsSort('u1')).toBe('folders')
    saveBasemapAround('u1', true)
    saveMapsSort('u1', 'nearest')
    expect(readBasemapAround('u1')).toBe(true)
    expect(readMapsSort('u1')).toBe('nearest')
    expect(readBasemapAround('u2')).toBe(false)
    expect(readMapsSort('u2')).toBe('folders')
    saveBasemapAround('u1', false)
    expect(readBasemapAround('u1')).toBe(false)
  })

  it('carries on when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    expect(() => saveLastMap('u1', BASE_MAP)).not.toThrow()
    expect(readLastMap('u1')).toBeNull()
    expect(readBasemapAround('u1')).toBe(false)
  })
})
