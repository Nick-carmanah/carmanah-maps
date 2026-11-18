/**
 * "Plot photos": geotagged photos become placemarks in a "Photo Library"
 * layer (as Avenza does), each with its photo attached.
 *
 * Pure apart from reading the files: the caller saves the result.
 */
import type { Position } from 'geojson'
import type { UserFeature } from './features'
import type { FeaturePhoto } from './store'
import { declinationDeg } from './magnetic'
import { readPhotoGeotag, type PhotoGeotag } from './exif'
import { formatAltitude, formatBearing } from './units'

export const PHOTO_LAYER = 'Photo Library'

export const PHOTO_FIELDS = {
  time: 'Photo time',
  direction: 'Photo direction (°T)',
  altitude: 'Photo altitude (m)',
  accuracy: 'Photo GPS accuracy (m)',
  file: 'Photo file',
} as const

/** Direction in degrees true (magnetic converted with the WMM at the photo's
 * place and time). */
export function trueDirection(tag: PhotoGeotag): number | undefined {
  if (tag.direction === undefined) return undefined
  if (tag.directionRef !== 'M') return tag.direction
  const d = tag.direction + declinationDeg(tag.lat, tag.lon, new Date(tag.time ?? Date.now()))
  return ((d % 360) + 360) % 360
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '').trim() || fileName || 'Photo'
}

/** One line for the notes, in the units chosen now (like a saved track's). */
export function photoNotes(tag: PhotoGeotag): string {
  const at: Position = [tag.lon, tag.lat]
  const dir = trueDirection(tag)
  return [
    tag.time !== undefined
      ? `Taken ${new Date(tag.time).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })}`
      : null,
    dir !== undefined ? `facing ${formatBearing(dir, at)}` : null,
    tag.altitude !== undefined ? `altitude ${formatAltitude(tag.altitude)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Attributes in metres, degrees true and ISO time, unchanged by unit settings. */
export function photoAttributes(tag: PhotoGeotag, fileName: string): { k: string; v: string }[] {
  const out: { k: string; v: string }[] = [{ k: PHOTO_FIELDS.file, v: fileName }]
  if (tag.time !== undefined) out.push({ k: PHOTO_FIELDS.time, v: new Date(tag.time).toISOString() })
  const dir = trueDirection(tag)
  if (dir !== undefined) out.push({ k: PHOTO_FIELDS.direction, v: dir.toFixed(1) })
  if (tag.altitude !== undefined) out.push({ k: PHOTO_FIELDS.altitude, v: tag.altitude.toFixed(1) })
  if (tag.accuracyM !== undefined) out.push({ k: PHOTO_FIELDS.accuracy, v: tag.accuracyM.toFixed(1) })
  return out
}

export function photoPlacemark(
  fileName: string,
  tag: PhotoGeotag,
  layerId: string,
  color: string,
  now = Date.now(),
): UserFeature {
  return {
    id: crypto.randomUUID(),
    kind: 'pin',
    name: baseName(fileName),
    notes: photoNotes(tag),
    color,
    coordinates: [tag.lon, tag.lat],
    layerId,
    attributes: photoAttributes(tag, fileName),
    createdAt: now,
    updatedAt: now,
  }
}

export interface PhotoPlot {
  features: UserFeature[]
  photos: FeaturePhoto[]
  /** File names with no GPS position (or not readable as a photo). */
  noPosition: string[]
  /** File names already plotted in this layer at the same spot. */
  duplicates: string[]
}

/** Read each file's geotag and build its placemark + attached photo. */
export async function plotPhotos(
  files: File[],
  layerId: string,
  color: string,
  existing: UserFeature[],
): Promise<PhotoPlot> {
  const out: PhotoPlot = { features: [], photos: [], noPosition: [], duplicates: [] }
  const already = new Set(
    existing
      .filter((f) => f.layerId === layerId && f.kind === 'pin')
      .map((f) => f.attributes?.find((a) => a.k === PHOTO_FIELDS.file)?.v + '|' + (f.coordinates as Position).join(',')),
  )
  const now = Date.now()
  for (const file of files) {
    let tag: PhotoGeotag | null = null
    try {
      tag = await readPhotoGeotag(file)
    } catch {
      tag = null
    }
    if (!tag) {
      out.noPosition.push(file.name)
      continue
    }
    const key = `${file.name}|${tag.lon},${tag.lat}`
    if (already.has(key)) {
      out.duplicates.push(file.name)
      continue
    }
    already.add(key)
    const i = out.features.length
    const feature = photoPlacemark(file.name, tag, layerId, color, now + i)
    out.features.push(feature)
    out.photos.push({ id: crypto.randomUUID(), featureId: feature.id, blob: file, createdAt: now + i })
  }
  return out
}

/** "Plotted 3 photos in Photo Library. 2 had no GPS position: a.jpg, b.jpg." */
export function plotSummary(plot: PhotoPlot): { message: string; isError: boolean } {
  const n = plot.features.length
  const list = (names: string[]) =>
    names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')
  const parts = [
    n ? `Plotted ${n} photo${n === 1 ? '' : 's'} in ${PHOTO_LAYER}.` : 'No photos plotted.',
    plot.noPosition.length
      ? `${plot.noPosition.length} had no GPS position and ${plot.noPosition.length === 1 ? 'was' : 'were'} skipped: ${list(plot.noPosition)}.`
      : null,
    plot.duplicates.length ? `Already plotted: ${list(plot.duplicates)}.` : null,
    !n && plot.noPosition.length
      ? plot.noPosition.length === 1
        ? 'If it was taken with location on, the phone may have removed it when sharing: try picking it from Files instead.'
        : 'If they were taken with location on, the phone may have removed it when sharing: try picking them from Files instead.'
      : null,
  ]
  return { message: parts.filter(Boolean).join(' '), isError: plot.noPosition.length > 0 || !n }
}
