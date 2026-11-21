/**
 * Plot GPS average maths (src/lib/gps-average.ts): accuracy limit, outlier
 * rejection, the mean, the spread, stop rules and the saved attributes.
 * Fixes are synthetic: a known point plus seeded Gaussian noise.
 */
import { describe, expect, it } from 'vitest'
import {
  AVERAGE_FIELDS,
  averageAttributes,
  averageFixes,
  stopReached,
  type AverageFix,
} from '../src/lib/gps-average'
import { metresPerDegree } from '../src/lib/geodesic'
import { haversineMeters } from '../src/lib/measure'

const TRUTH: [number, number] = [-120.25, 50.5]
/** Metres per degree east and north on WGS84 at the truth's latitude, as the maths use. */
const M_PER_DEG = metresPerDegree(TRUTH[1])
const T0 = Date.UTC(2026, 7, 1, 16, 0, 0)

/** Seeded normal noise (mulberry32 + Box–Muller). */
function gaussian(seed: number) {
  let a = seed
  const uniform = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform())
}

/** A fix this many metres east/north of the truth. */
function fixAt(east: number, north: number, i: number, accuracy: number | null = 4, altitude: number | null = null): AverageFix {
  const [lng, lat] = TRUTH
  return {
    lng: lng + east / M_PER_DEG.east,
    lat: lat + north / M_PER_DEG.north,
    accuracy,
    altitude,
    time: T0 + i * 1000,
  }
}

function noisyFixes(n: number, sigmaM: number, seed = 1): AverageFix[] {
  const g = gaussian(seed)
  return Array.from({ length: n }, (_, i) => fixAt(g() * sigmaM, g() * sigmaM, i, 3 + Math.abs(g())))
}

const errorM = (pos: number[] | null) => haversineMeters(pos!, TRUTH)

describe('averageFixes', () => {
  it('averages a scatter close to the truth, with the expected spread', () => {
    const r = averageFixes(noisyFixes(120, 2))
    expect(r.count).toBe(120)
    expect(r.inaccurate + r.outliers).toBeLessThanOrEqual(1)
    // σ = 2 m per axis: the mean of 120 is ~0.18 m off; allow 0.6 m.
    expect(errorM(r.position)).toBeLessThan(0.6)
    // RMS distance of a 2-D normal is σ√2 ≈ 2.83 m.
    expect(r.spreadM!).toBeGreaterThan(2.83 * 0.85)
    expect(r.spreadM!).toBeLessThan(2.83 * 1.15)
    expect(r.startTime).toBe(T0)
    expect(r.endTime).toBe(T0 + 119 * 1000)
  })

  it('spread is the RMS distance from the average (exact case)', () => {
    const r = averageFixes([fixAt(1, 0, 0), fixAt(-1, 0, 1), fixAt(0, 1, 2), fixAt(0, -1, 3)])
    expect(errorM(r.position)).toBeLessThan(1e-6)
    expect(r.spreadM!).toBeCloseTo(1, 6)
    expect(r.meanAccuracyM).toBe(4)
  })

  it('discards fixes worse than the accuracy limit (default 20 m), and fixes with no accuracy', () => {
    const fixes = [
      ...noisyFixes(20, 1),
      // Poor fixes, all on one side: they would pull the average 15 m east.
      ...Array.from({ length: 20 }, (_, i) => fixAt(30, 0, 100 + i, 25)),
      fixAt(30, 0, 200, null),
    ]
    const r = averageFixes(fixes)
    expect(r.inaccurate).toBe(21)
    expect(r.count + r.outliers).toBe(20)
    expect(r.status.slice(20)).toEqual(new Array(21).fill('inaccurate'))
    expect(errorM(r.position)).toBeLessThan(0.6)

    // A looser limit lets the 25 m fixes in (they then dominate as a cluster).
    const loose = averageFixes(fixes, { maxAccuracyM: 30 })
    expect(loose.inaccurate).toBe(1)
    expect(errorM(loose.position)).toBeGreaterThan(10)
  })

  it('rejects multipath jumps that still report a good accuracy', () => {
    const good = noisyFixes(40, 1.5, 7)
    const jumps = [fixAt(40, 5, 50, 4), fixAt(38, -3, 51, 4), fixAt(-35, 30, 52, 4)]
    const r = averageFixes([...good, ...jumps])
    expect(r.outliers).toBeGreaterThanOrEqual(3)
    expect(r.status.slice(40)).toEqual(['outlier', 'outlier', 'outlier'])
    expect(errorM(r.position)).toBeLessThan(0.6)
    // Without the outlier step the jumps would drag the average ~1 m.
    const naive = averageFixes([...good, ...jumps], { minForOutliers: Infinity })
    expect(errorM(naive.position)).toBeGreaterThan(errorM(r.position) + 0.5)
  })

  it('keeps a tight cluster: nothing within 2 m of the rest is an outlier', () => {
    // A phone repeating the same position, then one fix 1.5 m off and one 3 m off.
    const same = Array.from({ length: 10 }, (_, i) => fixAt(0, 0, i))
    const r = averageFixes([...same, fixAt(1.5, 0, 10), fixAt(3, 0, 11)])
    expect(r.status[10]).toBe('kept')
    expect(r.status[11]).toBe('outlier')
  })

  it('looks for outliers only with 5 or more accurate fixes', () => {
    const r = averageFixes([fixAt(0, 0, 0), fixAt(0.5, 0, 1), fixAt(0, 0.5, 2), fixAt(50, 0, 3)])
    expect(r.outliers).toBe(0)
    expect(r.count).toBe(4)
  })

  it('works at high latitude (local frame, not degrees)', () => {
    const at69 = metresPerDegree(69)
    const north = (dLatM: number, dLonM: number): AverageFix => ({
      lng: -135 + dLonM / at69.east,
      lat: 69 + dLatM / at69.north,
      accuracy: 3,
      altitude: null,
      time: T0,
    })
    const r = averageFixes([north(0, 10), north(0, -10), north(10, 0), north(-10, 0)])
    expect(haversineMeters(r.position!, [-135, 69])).toBeLessThan(0.01)
    expect(r.spreadM!).toBeCloseTo(10, 3)
  })

  it('averages altitude when the fixes have one, and reports nothing without fixes', () => {
    const r = averageFixes([fixAt(0, 0, 0, 4, 100), fixAt(0, 0, 1, 4, 104), fixAt(0, 0, 2, 4, null)])
    expect(r.altitude).toBe(102)
    const none = averageFixes([fixAt(0, 0, 0, 50)])
    expect(none.position).toBeNull()
    expect(none.count).toBe(0)
    expect(none.inaccurate).toBe(1)
    expect(none.spreadM).toBeNull()
    expect(averageFixes([]).received).toBe(0)
  })

  it('one fix has a position but no spread', () => {
    const r = averageFixes([fixAt(2, 2, 0)])
    expect(r.count).toBe(1)
    expect(r.spreadM).toBeNull()
    expect(haversineMeters(r.position!, [fixAt(2, 2, 0).lng, fixAt(2, 2, 0).lat])).toBeLessThan(1e-6)
  })
})

describe('stop rules', () => {
  it('manual never stops by itself; timer and fix count do', () => {
    expect(stopReached({ kind: 'manual' }, 1000, 1e9)).toBe(false)
    expect(stopReached({ kind: 'seconds', value: 30 }, 0, 29_999)).toBe(false)
    expect(stopReached({ kind: 'seconds', value: 30 }, 0, 30_000)).toBe(true)
    expect(stopReached({ kind: 'fixes', value: 20 }, 19, 1e9)).toBe(false)
    expect(stopReached({ kind: 'fixes', value: 20 }, 20, 0)).toBe(true)
  })
})

describe('saved attributes', () => {
  it('records fix count, mean accuracy, spread, discards and start/end time in metres and ISO', () => {
    const fixes = [fixAt(1, 0, 0, 4, 100), fixAt(-1, 0, 1, 6, 102), fixAt(0, 0, 2, 50)]
    const attrs = Object.fromEntries(averageAttributes(averageFixes(fixes), 20).map((a) => [a.k, a.v]))
    expect(attrs).toEqual({
      [AVERAGE_FIELDS.count]: '2',
      [AVERAGE_FIELDS.meanAccuracy]: '5.0',
      [AVERAGE_FIELDS.spread]: '1.00',
      [AVERAGE_FIELDS.discarded]: '1',
      [AVERAGE_FIELDS.limit]: '20',
      [AVERAGE_FIELDS.start]: '2026-08-01T16:00:00.000Z',
      [AVERAGE_FIELDS.end]: '2026-08-01T16:00:01.000Z',
      [AVERAGE_FIELDS.altitude]: '101.0',
    })
  })
})
