// @vitest-environment jsdom
/**
 * Track pause/resume (src/lib/track.ts): a pause leaves a gap, not a
 * straight jump, and distance, time, speed and climb leave the gap out —
 * while recording, on the saved feature, and through KML/GPX export and
 * re-import.
 */
// The storage module opens IndexedDB on import; tests use an in-memory one.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { strToU8 } from 'fflate'
import type { Position } from 'geojson'
import {
  appendFix,
  finishTrack,
  markPause,
  segmentedDurationMs,
  segmentedLengthM,
  splitSegments,
  trackSegmentStarts,
  trackStats,
  type TrackPoint,
} from '../src/lib/track'
import { featureDetails, featureGeometry, featureStat, type UserFeature } from '../src/lib/features'
import { featuresToGpx, featuresToKml, type ExportInput, type ExportOptions } from '../src/lib/export'
import { parseKmlBytes } from '../src/lib/kml'
import { parseGpxBytes } from '../src/lib/importers'
import { insideFence } from '../src/lib/fences'
import { newLayer } from '../src/lib/layers'
import { haversineMeters } from '../src/lib/measure'

const T0 = Date.UTC(2026, 7, 1, 16, 0, 0)
const M_PER_DEG_LAT = (Math.PI / 180) * 6371008.8
const ORIGIN: Position = [-120.25, 50.5]
/** A point this many metres east/north of ORIGIN. */
const at = (east: number, north: number): Position => [
  ORIGIN[0] + east / (M_PER_DEG_LAT * Math.cos((ORIGIN[1] * Math.PI) / 180)),
  ORIGIN[1] + north / M_PER_DEG_LAT,
]

/**
 * Walk 100 m north in 10 m steps (10 s apart), pause, get driven 1 km east
 * during a 10-minute pause, resume and walk 100 m north again.
 */
function recordWithPause(): TrackPoint[] {
  let pts: TrackPoint[] = []
  let t = T0
  for (let i = 0; i <= 10; i++) pts = appendFix(pts, at(0, i * 10), (t = T0 + i * 10_000), 100 + i)
  pts = markPause(pts)
  t += 10 * 60_000
  for (let i = 0; i <= 10; i++) pts = appendFix(pts, at(1000, 100 + i * 10), t + i * 10_000, 200 + i)
  return pts
}

describe('recording', () => {
  it('a pause starts a new segment at the next fix', () => {
    const pts = recordWithPause()
    expect(pts).toHaveLength(22)
    expect(trackSegmentStarts(pts)).toEqual([11])
  })

  it('stats leave the gap out: distance, time, speed and climb', () => {
    const s = trackStats(recordWithPause())
    // 200 m walked, not 200 m + the 1 km jump.
    expect(s.distanceM).toBeGreaterThan(199)
    expect(s.distanceM).toBeLessThan(201)
    // 2 × 100 s recording, not 100 s + 10 min + 100 s.
    expect(s.durationMs).toBe(200_000)
    expect(s.avgSpeedKmh).toBeCloseTo((0.2 / 200) * 3600, 1)
    // +10 m in each segment; the +90 m across the pause is not a climb.
    expect(s.elevGainM).toBe(20)
  })

  it('the first fix after resuming is kept even if it is within the jitter distance', () => {
    let pts: TrackPoint[] = []
    pts = appendFix(pts, at(0, 0), T0)
    pts = appendFix(pts, at(0, 10), T0 + 1000)
    pts = appendFix(pts, at(0, 11), T0 + 2000) // 1 m: jitter, dropped
    expect(pts).toHaveLength(2)
    pts = markPause(pts)
    pts = appendFix(pts, at(0, 11), T0 + 60_000) // resumed 1 m away: kept
    pts = appendFix(pts, at(0, 12), T0 + 61_000) // jitter again: dropped
    pts = appendFix(pts, at(0, 30), T0 + 62_000)
    expect(pts).toHaveLength(4)
    expect(trackSegmentStarts(pts)).toEqual([2])
  })

  it('pausing twice with nothing in between is one gap; pausing at the end is none', () => {
    let pts: TrackPoint[] = [{ position: at(0, 0), time: T0, altitude: null }]
    pts = appendFix(pts, at(0, 10), T0 + 1000)
    pts = markPause(markPause(pts))
    pts = appendFix(pts, at(50, 10), T0 + 5000)
    pts = appendFix(pts, at(50, 20), T0 + 6000)
    pts = markPause(pts)
    expect(trackSegmentStarts(pts)).toEqual([2])
    expect(markPause([])).toEqual([])
  })

  it('on stop, a segment of a single fix is dropped so the saved track is valid lines', () => {
    let pts = recordWithPause()
    pts = markPause(pts)
    pts = appendFix(pts, at(2000, 0), T0 + 3_600_000) // resumed, one fix, stopped
    expect(trackSegmentStarts(pts)).toEqual([11, 22])
    const done = finishTrack(pts)
    expect(done).toHaveLength(22)
    expect(trackSegmentStarts(done)).toEqual([11])
    expect(done[done.length - 1].pausedAfter).toBeUndefined()
    // A lone first fix goes too.
    const lone = finishTrack(markPause([{ position: at(0, 0), time: T0, altitude: null }]).concat(
      appendFix([], at(0, 50), T0 + 1000), appendFix([], at(0, 60), T0 + 2000),
    ))
    expect(lone).toHaveLength(2)
    expect(trackSegmentStarts(lone)).toEqual([])
  })
})

describe('segments', () => {
  it('splitSegments ignores bad indexes', () => {
    expect(splitSegments([1, 2, 3, 4], [2])).toEqual([[1, 2], [3, 4]])
    expect(splitSegments([1, 2, 3, 4], [0, 4, -1, 2.5, 2, 2])).toEqual([[1, 2], [3, 4]])
    expect(splitSegments([1, 2, 3], undefined)).toEqual([[1, 2, 3]])
    expect(splitSegments([], [1])).toEqual([[]])
  })
})

/** The saved feature, as App saves a stopped recording. */
function savedTrack(): UserFeature {
  const pts = recordWithPause()
  return {
    id: 'trk',
    kind: 'line',
    name: 'Track 1',
    notes: '',
    color: '#38bdf8',
    layerId: 'tracks',
    coordinates: pts.map((p) => p.position),
    times: pts.map((p) => p.time),
    segmentStarts: trackSegmentStarts(pts),
    createdAt: T0,
    updatedAt: T0,
  }
}

describe('saved track', () => {
  it('draws as a MultiLineString with a gap', () => {
    const g = featureGeometry(savedTrack())
    expect(g.type).toBe('MultiLineString')
    const parts = (g as { coordinates: Position[][] }).coordinates
    expect(parts.map((p) => p.length)).toEqual([11, 11])
    // Nothing joins the two parts.
    expect(haversineMeters(parts[0][10], parts[1][0])).toBeGreaterThan(900)
    // An unpaused line is still a LineString.
    expect(featureGeometry({ ...savedTrack(), segmentStarts: undefined }).type).toBe('LineString')
  })

  it('length, speed and pace on the feature sheet leave the gap out', () => {
    const f = savedTrack()
    expect(segmentedLengthM(f.coordinates as Position[], f.segmentStarts)).toBeCloseTo(200, 0)
    expect(segmentedDurationMs(f.times!, f.segmentStarts)).toBe(200_000)
    expect(featureStat(f)).toBe('200 m')
    // 200 m in 200 s = 3.6 km/h; 1000 s/km pace.
    expect(featureDetails(f)).toEqual(['200 m', 'avg 3.6 km/h', '16:40 /km', 'paused 1×'])
  })

  it('a fence along the track does not cover the gap', () => {
    const f = { ...savedTrack(), geofence: { enabled: true, radiusM: 50 } }
    expect(insideFence(at(0, 50), f)).toBe(true)
    expect(insideFence(at(500, 100), f)).toBe(false) // halfway along the jump
    expect(insideFence(at(500, 100), { ...f, segmentStarts: undefined })).toBe(true)
  })
})

describe('export and import keep the gap', () => {
  const layer = newLayer('Tracks', { style: { color: '#38bdf8' } })
  const input = (): ExportInput => ({
    layers: [layer],
    features: [{ ...savedTrack(), layerId: layer.id }],
    photos: new Map(),
    symbolPng: async () => null,
  })
  const opts = (format: ExportOptions['format'], tracksAsLines = false): ExportOptions => ({
    format,
    layerIds: [layer.id],
    includePhotos: false,
    tracksAsLines,
    docName: 'Tracks',
  })
  const expectSameTrack = (back: UserFeature) => {
    const f = savedTrack()
    expect(back.kind).toBe('line')
    expect(back.segmentStarts).toEqual([11])
    expect(back.times).toEqual(f.times)
    const coords = back.coordinates as Position[]
    expect(coords).toHaveLength(22)
    coords.forEach((p, i) => expect(haversineMeters(p, (f.coordinates as Position[])[i])).toBeLessThan(0.01))
  }

  it('KML: gx:MultiTrack with one gx:Track per segment, read back as one track', () => {
    const kml = featuresToKml(input(), opts('kml'))
    expect(kml).toContain('<gx:MultiTrack><gx:interpolate>0</gx:interpolate><gx:Track>')
    expect(kml.match(/<gx:Track>/g)).toHaveLength(2)
    const back = parseKmlBytes(strToU8(kml), { fileName: 'rt.kml', format: 'kml' })
    expect(back.features).toHaveLength(1)
    expectSameTrack(back.features[0])
  })

  it('GPX: one <trkseg> per segment, read back as one track', () => {
    const gpx = featuresToGpx(input(), opts('gpx'))
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2)
    expect(gpx.match(/<trk>/g)).toHaveLength(1)
    const back = parseGpxBytes(strToU8(gpx), { fileName: 'rt.gpx' })
    expect(back.features).toHaveLength(1)
    expectSameTrack(back.features[0])
  })

  it('tracks as lines: still two parts, no straight jump', () => {
    const kml = featuresToKml(input(), opts('kml', true))
    expect(kml).toContain('<MultiGeometry><LineString>')
    expect(kml).not.toContain('gx:Track')
    const gpx = featuresToGpx(input(), opts('gpx', true))
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2)
    expect(gpx).not.toContain('<time>')
  })

  it('an unpaused track exports exactly as before (one gx:Track, one trkseg)', () => {
    const plain = (): ExportInput => ({ ...input(), features: [{ ...savedTrack(), layerId: layer.id, segmentStarts: undefined }] })
    const kml = featuresToKml(plain(), opts('kml'))
    expect(kml).not.toContain('MultiTrack')
    expect(kml.match(/<gx:Track>/g)).toHaveLength(1)
    expect(featuresToGpx(plain(), opts('gpx')).match(/<trkseg>/g)).toHaveLength(1)
  })
})
