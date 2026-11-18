/**
 * The area a pack covers (src/lib/packs/area.ts): perimeters from GeoJSON,
 * hectares, and the tiles within a buffer of the perimeter, checked against
 * an independent point-sampling reference.
 */
import { describe, expect, it } from 'vitest'
import {
  areaBbox,
  bboxRing,
  coverArea,
  coverZoom,
  parentZoom,
  ringsFromGeoJSON,
  ringsHectares,
  simplifyRing,
  tileIdsOf,
  tileXToLon,
  tileYToLat,
  type LonLat,
  type PackArea,
} from '../src/lib/packs/area'

const R = 6371008.8
const RAD = Math.PI / 180

/** Metres from a point to the polygon (0 inside), by brute force in a local projection. */
function distanceToArea(lon: number, lat: number, rings: LonLat[][], lat0: number): number {
  const kx = R * RAD * Math.cos(lat0 * RAD)
  const ky = R * RAD
  const x = lon * kx
  const y = lat * ky
  let best = Infinity
  for (const ring of rings) {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = [ring[i][0] * kx, ring[i][1] * ky]
      const [xj, yj] = [ring[j][0] * kx, ring[j][1] * ky]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      const dx = xj - xi
      const dy = yj - yi
      const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(x - (xi + t * dx), y - (yi + t * dy)))
    }
    if (inside) return 0
  }
  return best
}

// A lopsided "fire" near Williams Lake: concave, with a long thin arm.
const FIRE: LonLat[] = [
  [-122.2, 51.9],
  [-121.9, 51.85],
  [-121.75, 52.0],
  [-121.95, 52.05],
  [-121.97, 52.25],
  [-122.0, 52.25],
  [-122.02, 52.06],
  [-122.25, 52.08],
  [-122.3, 51.97],
]

describe('ringsFromGeoJSON', () => {
  it('takes outer rings of polygons and multipolygons, fills holes, drops the closing point', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
              [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.2]],
            ],
          },
        },
        { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[[[5, 5], [6, 5], [6, 6], [5, 5]]], [[[7, 7], [8, 7], [8, 8]]]] } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
        { type: 'Feature', geometry: null },
      ],
    }
    const rings = ringsFromGeoJSON(fc)
    expect(rings).toHaveLength(3)
    expect(rings[0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]])
    expect(rings[2]).toEqual([[7, 7], [8, 7], [8, 8]])
  })
})

describe('ringsHectares', () => {
  it('measures a 0.1° square at 50°N (~7,957 ha)', () => {
    const ha = ringsHectares([bboxRing([-120.05, 49.95, -119.95, 50.05])])
    expect(ha).toBeGreaterThan(7957 * 0.995)
    expect(ha).toBeLessThan(7957 * 1.005)
  })
})

describe('coverZoom', () => {
  it('matches a point-sampling reference: every tile touches the buffer, no touching tile is missed', () => {
    const area: PackArea = { rings: [FIRE], bufferM: 3000 }
    const z = 13
    const got = new Set(coverZoom(area, z).keys)
    const n = 2 ** z
    const [w, s, e, nn] = areaBbox({ rings: [FIRE], bufferM: 8000 })
    const tileM = (2 * Math.PI * R * Math.cos(52 * RAD)) / n
    const slack = tileM / 8 // samples are 1/8 tile apart
    let checked = 0
    for (let x = Math.floor(((w + 180) / 360) * n); x <= Math.floor(((e + 180) / 360) * n); x++) {
      for (let y = 0; y < n; y++) {
        const north = tileYToLat(y, z)
        const south = tileYToLat(y + 1, z)
        if (south > nn || north < s) continue
        let min = Infinity
        for (let i = 0; i <= 8; i++) {
          for (let j = 0; j <= 8; j++) {
            const lon = tileXToLon(x + i / 8, z)
            const lat = tileYToLat(y + j / 8, z)
            min = Math.min(min, distanceToArea(lon, lat, [FIRE], 52))
          }
        }
        const key = x * n + y
        if (got.has(key)) expect(min, `tile ${x}/${y} included`).toBeLessThanOrEqual(3000 + slack)
        else expect(min, `tile ${x}/${y} left out`).toBeGreaterThan(3000 - 1)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(300)
    expect(got.size).toBeGreaterThan(150)
  })

  it('covers a polygon smaller than a tile, and nothing with no rings', () => {
    const tiny: PackArea = { rings: [bboxRing([-121.5001, 50.0001, -121.5, 50.0002])], bufferM: 0 }
    expect(coverZoom(tiny, 10).keys).toHaveLength(1)
    expect(coverZoom({ rings: [], bufferM: 1000 }, 10).keys).toEqual([])
  })

  it('derives lower zooms from parents exactly as computing them directly', () => {
    for (const bufferM of [0, 5000]) {
      const area: PackArea = { rings: [FIRE], bufferM }
      const direct = new Set(coverZoom(area, 11).keys)
      const derived = new Set(parentZoom(coverZoom(area, 12)).keys)
      expect([...derived].sort()).toEqual([...direct].sort())
    }
  })

  it('a bigger buffer never covers fewer tiles, and coverArea spans the zooms', () => {
    const small = coverZoom({ rings: [FIRE], bufferM: 1000 }, 13).keys.length
    const big = coverZoom({ rings: [FIRE], bufferM: 5000 }, 13).keys.length
    expect(big).toBeGreaterThan(small)
    const levels = coverArea({ rings: [FIRE], bufferM: 5000 }, 6, 14)
    expect(levels.map((l) => l.z)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14])
    expect(levels[0].keys.length).toBeGreaterThanOrEqual(1)
    const ids = tileIdsOf(levels)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    expect(new Set(ids).size).toBe(ids.length)
    expect(tileIdsOf(levels, 6, 12).length).toBeLessThan(ids.length)
  })
})

describe('simplifyRing', () => {
  it('drops points closer than the tolerance to the line, keeps the shape', () => {
    const wiggly: LonLat[] = []
    for (let i = 0; i <= 200; i++) wiggly.push([-121 + i * 0.001, 50 + (i % 2) * 0.00001])
    wiggly.push([-120.8, 50.1], [-121, 50.1])
    const out = simplifyRing(wiggly, 20)
    expect(out.length).toBeLessThan(10)
    expect(out[0]).toEqual(wiggly[0])
    expect(ringsHectares([out])).toBeCloseTo(ringsHectares([wiggly]), -1)
  })
})
