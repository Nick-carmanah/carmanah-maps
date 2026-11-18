/**
 * EXIF reader (src/lib/exif.ts) and Plot photos (src/lib/plot-photos.ts),
 * against synthetic files built byte by byte in test/fixtures/exif.ts.
 * No real photos, no real people's locations: positions are round numbers.
 */
import { describe, expect, it } from 'vitest'
import { geotagFromTags, locateExif, parseTiff, readGeotag, readPhotoGeotag } from '../src/lib/exif'
import { declinationDeg } from '../src/lib/magnetic'
import {
  PHOTO_FIELDS,
  plotPhotos,
  plotSummary,
  trueDirection,
} from '../src/lib/plot-photos'
import type { UserFeature } from '../src/lib/features'
import { buildHeic, buildJpeg, buildPng, buildTiff, photoTiff } from './fixtures/exif'

const NORTH_WEST = {
  lat: 50.5,
  lon: -120.25,
  alt: 345.6,
  direction: 123.4,
  directionRef: 'T' as const,
  hError: 4.5,
}

/** 1e-7° ≈ 1 cm: the rationals carry seconds to 1/10000. */
const close = (a: number, b: number, eps = 1e-7) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('JPEG', () => {
  it('reads position, altitude, direction, accuracy and the time (big-endian TIFF)', () => {
    const jpeg = buildJpeg(
      photoTiff(false, NORTH_WEST, { dateTimeOriginal: '2026:08:01 09:12:30', offset: '-07:00' }),
    )
    const tag = readGeotag(jpeg)!
    close(tag.lat, 50.5)
    close(tag.lon, -120.25)
    expect(tag.altitude).toBeCloseTo(345.6, 2)
    expect(tag.direction).toBeCloseTo(123.4, 3)
    expect(tag.directionRef).toBe('T')
    expect(tag.accuracyM).toBeCloseTo(4.5, 2)
    // 09:12:30 at UTC−7 is 16:12:30 UTC.
    expect(tag.time).toBe(Date.UTC(2026, 7, 1, 16, 12, 30))
    expect(tag.timeZoneKnown).toBe(true)
  })

  it('reads southern/eastern positions, below sea level and magnetic direction (little-endian TIFF)', () => {
    const jpeg = buildJpeg(
      photoTiff(true, {
        lat: -33.875,
        lon: 151.2,
        alt: 12.5,
        belowSeaLevel: true,
        direction: 10,
        directionRef: 'M',
        gpsDate: '2026:08:01',
        gpsTime: [16, 12, 30.5],
      }),
    )
    const tag = readGeotag(jpeg)!
    close(tag.lat, -33.875)
    close(tag.lon, 151.2)
    expect(tag.altitude).toBeCloseTo(-12.5, 2)
    expect(tag.directionRef).toBe('M')
    // No DateTimeOriginal: the GPS date and time (UTC) are used.
    expect(tag.time).toBe(Date.UTC(2026, 7, 1, 16, 12, 30, 500))
    expect(tag.timeZoneKnown).toBe(true)
  })

  it('reads a camera time with no zone as local time, and says so', () => {
    const tag = readGeotag(
      buildJpeg(photoTiff(false, NORTH_WEST, { dateTimeOriginal: '2026:08:01 09:12:30' })),
    )!
    expect(tag.time).toBe(new Date(2026, 7, 1, 9, 12, 30).getTime())
    expect(tag.timeZoneKnown).toBe(false)
  })

  it('skips an XMP APP1 segment before the EXIF one', () => {
    const tag = readGeotag(buildJpeg(photoTiff(true, NORTH_WEST), { xmpFirst: true }))!
    close(tag.lat, 50.5)
  })

  it('is a real JPEG: markers in order, ends with EOI', () => {
    const jpeg = buildJpeg(photoTiff(true, NORTH_WEST))
    expect([...jpeg.slice(0, 2)]).toEqual([0xff, 0xd8])
    expect([...jpeg.slice(-2)]).toEqual([0xff, 0xd9])
  })

  it('returns null for photos without a GPS position', () => {
    expect(readGeotag(buildJpeg(photoTiff(false, null, { dateTimeOriginal: '2026:08:01 09:12:30' })))).toBeNull()
    expect(readGeotag(buildJpeg(null))).toBeNull()
    // Cameras with no fix sometimes write 0,0.
    expect(readGeotag(buildJpeg(photoTiff(false, { lat: 0, lon: 0 })))).toBeNull()
  })

  it('never throws on broken files', () => {
    const good = buildJpeg(photoTiff(false, NORTH_WEST, { dateTimeOriginal: '2026:08:01 09:12:30', offset: '+00:00' }))
    // Every truncation.
    for (let n = 0; n < good.length; n++) expect(() => readGeotag(good.slice(0, n))).not.toThrow()
    // Deterministic byte flips.
    let seed = 12345
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
    for (let k = 0; k < 2000; k++) {
      const bad = good.slice()
      for (let j = 0; j < 4; j++) bad[Math.floor(rand() * bad.length)] = Math.floor(rand() * 256)
      expect(() => readGeotag(bad)).not.toThrow()
    }
    expect(readGeotag(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
    expect(readGeotag(new TextEncoder().encode('not an image at all'))).toBeNull()
  })
})

describe('other containers', () => {
  it('HEIC: Exif item inside the first read', () => {
    const heic = buildHeic(photoTiff(false, NORTH_WEST))
    const tag = readGeotag(heic)!
    close(tag.lat, 50.5)
    close(tag.lon, -120.25)
  })

  it('HEIC: Exif item past the first 512 KB is read on its own', async () => {
    const heic = buildHeic(photoTiff(false, NORTH_WEST), { gapBytes: 600 * 1024 })
    const head = heic.slice(0, 512 * 1024)
    expect(locateExif(head)).toMatchObject({ length: expect.any(Number), offset: expect.any(Number) })
    expect(readGeotag(head)).toBeNull()
    const tag = (await readPhotoGeotag(new Blob([heic])))!
    close(tag.lat, 50.5)
    expect(tag.direction).toBeCloseTo(123.4, 3)
  })

  it('PNG eXIf chunk', () => {
    const tag = readGeotag(buildPng(photoTiff(true, NORTH_WEST)))!
    close(tag.lon, -120.25)
  })

  it('readPhotoGeotag reads a JPEG Blob', async () => {
    const tag = (await readPhotoGeotag(new Blob([buildJpeg(photoTiff(true, NORTH_WEST))])))!
    close(tag.lat, 50.5)
  })

  it('a bare TIFF block with no GPS IFD has no position', () => {
    const tiff = buildTiff({ le: true, ifd0: [{ tag: 0x010f, type: 2, value: 'Synthetic' }] })
    expect(geotagFromTags(parseTiff(tiff)!)).toBeNull()
  })
})

describe('plot photos', () => {
  const file = (name: string, bytes: Uint8Array) => new File([bytes], name, { type: 'image/jpeg' })

  it('makes a placemark per geotagged photo, with the photo attached; reports the rest', async () => {
    const files = [
      file('IMG_0001.JPG', buildJpeg(photoTiff(false, NORTH_WEST, { dateTimeOriginal: '2026:08:01 09:12:30', offset: '-07:00' }))),
      file('IMG_0002.JPG', buildJpeg(photoTiff(true, null))),
      file('notes.txt', new TextEncoder().encode('hello')),
      file('IMG_0003.HEIC', buildHeic(photoTiff(true, { lat: 50.6, lon: -120.3 }))),
    ]
    const plot = await plotPhotos(files, 'layer-1', '#a855f7', [])
    expect(plot.features.map((f) => f.name)).toEqual(['IMG_0001', 'IMG_0003'])
    expect(plot.noPosition).toEqual(['IMG_0002.JPG', 'notes.txt'])
    const [f] = plot.features
    expect(f.kind).toBe('pin')
    expect(f.layerId).toBe('layer-1')
    expect(f.color).toBe('#a855f7')
    expect((f.coordinates as number[])[0]).toBeCloseTo(-120.25, 7)
    expect((f.coordinates as number[])[1]).toBeCloseTo(50.5, 7)
    const attr = Object.fromEntries((f.attributes ?? []).map((a) => [a.k, a.v]))
    expect(attr[PHOTO_FIELDS.file]).toBe('IMG_0001.JPG')
    expect(attr[PHOTO_FIELDS.time]).toBe('2026-08-01T16:12:30.000Z')
    expect(attr[PHOTO_FIELDS.direction]).toBe('123.4')
    expect(attr[PHOTO_FIELDS.altitude]).toBe('345.6')
    expect(attr[PHOTO_FIELDS.accuracy]).toBe('4.5')
    expect(f.notes).toMatch(/facing 123°T/)
    // The photo itself is attached to its placemark.
    expect(plot.photos).toHaveLength(2)
    expect(plot.photos[0].featureId).toBe(f.id)
    expect(plot.photos[0].blob).toBe(files[0])

    const summary = plotSummary(plot)
    expect(summary.isError).toBe(true)
    expect(summary.message).toMatch(/^Plotted 2 photos in Photo Library\. 2 had no GPS position/)
    expect(summary.message).toContain('IMG_0002.JPG')
  })

  it('does not plot the same photo twice in the same place', async () => {
    const bytes = buildJpeg(photoTiff(false, NORTH_WEST))
    const first = await plotPhotos([file('IMG_0001.JPG', bytes)], 'layer-1', '#fff', [])
    const again = await plotPhotos([file('IMG_0001.JPG', bytes)], 'layer-1', '#fff', first.features as UserFeature[])
    expect(again.features).toHaveLength(0)
    expect(again.duplicates).toEqual(['IMG_0001.JPG'])
    // Another layer is another place to plot it.
    expect((await plotPhotos([file('IMG_0001.JPG', bytes)], 'layer-2', '#fff', first.features)).features).toHaveLength(1)
  })

  it('stores a magnetic direction as degrees true', () => {
    const tag = { lat: 50.5, lon: -120.25, direction: 10, directionRef: 'M' as const, time: Date.UTC(2026, 7, 1) }
    const dec = declinationDeg(50.5, -120.25, new Date(tag.time))
    expect(dec).toBeGreaterThan(10) // BC: about 15° east
    expect(trueDirection(tag)).toBeCloseTo(10 + dec, 6)
    expect(trueDirection({ ...tag, directionRef: 'T' })).toBe(10)
  })
})
