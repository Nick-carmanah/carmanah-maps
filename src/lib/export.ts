import type { Position } from 'geojson'
import { zipSync } from 'fflate'
import { featureStat, type UserFeature } from './features'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** '#rrggbb' + opacity → KML's aabbggrr. */
function kmlColor(hex: string, alpha = 'ff'): string {
  const m = /^#(..)(..)(..)$/.exec(hex)
  return m ? `${alpha}${m[3]}${m[2]}${m[1]}` : `${alpha}ffffff`
}

const coordStr = (p: Position) => `${p[0]},${p[1]},0`

export function featuresToKml(
  features: UserFeature[],
  docName = 'Carmanah Maps export',
  photoRefs?: Map<string, string[]>,
): string {
  const placemarks = features
    .map((f) => {
      const photos = photoRefs?.get(f.id) ?? []
      const descBody = [
        f.notes ? esc(f.notes) : '',
        ...photos.map((p) => `<img src="${p}" width="400"/>`),
      ]
        .filter(Boolean)
        .join('<br/>')
      const desc = descBody ? `<description><![CDATA[${descBody}]]></description>` : ''
      const attrs = f.attributes?.filter((a) => a.k)
      const extended = attrs?.length
        ? `<ExtendedData>${attrs
            .map((a) => `<Data name="${esc(a.k)}"><value>${esc(a.v)}</value></Data>`)
            .join('')}</ExtendedData>`
        : ''
      let style: string
      let geom: string
      if (f.kind === 'pin') {
        style = `<Style><IconStyle><color>${kmlColor(f.color)}</color></IconStyle></Style>`
        geom = `<Point><coordinates>${coordStr(f.coordinates as Position)}</coordinates></Point>`
      } else if (f.kind === 'line') {
        style = `<Style><LineStyle><color>${kmlColor(f.color)}</color><width>3</width></LineStyle></Style>`
        geom = `<LineString><coordinates>${(f.coordinates as Position[]).map(coordStr).join(' ')}</coordinates></LineString>`
      } else {
        const ring = f.coordinates as Position[]
        style = `<Style><LineStyle><color>${kmlColor(f.color)}</color><width>3</width></LineStyle><PolyStyle><color>${kmlColor(f.color, '4d')}</color></PolyStyle></Style>`
        geom = `<Polygon><outerBoundaryIs><LinearRing><coordinates>${[...ring, ring[0]].map(coordStr).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
      }
      return `    <Placemark><name>${esc(f.name)}</name>${desc}${extended}${style}${geom}</Placemark>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(docName)}</name>
${placemarks}
  </Document>
</kml>
`
}

/** KMZ = zipped KML with photos embedded, so they travel with the share. */
export async function featuresToKmz(
  features: UserFeature[],
  photosByFeature: Map<string, Blob[]>,
  docName = 'Carmanah Maps export',
): Promise<Blob> {
  const files: Record<string, Uint8Array> = {}
  const photoRefs = new Map<string, string[]>()
  for (const [featureId, blobs] of photosByFeature) {
    const refs: string[] = []
    for (let i = 0; i < blobs.length; i++) {
      const path = `files/${featureId.slice(0, 8)}_${i + 1}.jpg`
      files[path] = new Uint8Array(await blobs[i].arrayBuffer())
      refs.push(path)
    }
    if (refs.length) photoRefs.set(featureId, refs)
  }
  files['doc.kml'] = new TextEncoder().encode(featuresToKml(features, docName, photoRefs))
  const zipped = zipSync(files)
  return new Blob([zipped.buffer as ArrayBuffer], {
    type: 'application/vnd.google-earth.kmz',
  })
}

export function featuresToGpx(features: UserFeature[]): string {
  const wpts = features
    .filter((f) => f.kind === 'pin')
    .map((f) => {
      const [lng, lat] = f.coordinates as Position
      return `  <wpt lat="${lat}" lon="${lng}"><name>${esc(f.name)}</name>${f.notes ? `<desc>${esc(f.notes)}</desc>` : ''}</wpt>`
    })
  const trks = features
    .filter((f) => f.kind !== 'pin')
    .map((f) => {
      const pts = f.coordinates as Position[]
      const ring = f.kind === 'area' ? [...pts, pts[0]] : pts
      const trkpts = ring
        .map((p, i) => {
          const t = f.times?.[i]
          const time = t ? `<time>${new Date(t).toISOString()}</time>` : ''
          return `        <trkpt lat="${p[1]}" lon="${p[0]}">${time}</trkpt>`
        })
        .join('\n')
      return `  <trk><name>${esc(f.name)}</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>`
    })
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Carmanah Maps" xmlns="http://www.topografix.com/GPX/1/1">
${[...wpts, ...trks].join('\n')}
</gpx>
`
}

export function featuresToCsv(features: UserFeature[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  const rows = features.map((f) => {
    const [lng, lat] =
      f.kind === 'pin' ? (f.coordinates as Position) : (f.coordinates as Position[])[0]
    const attrs = (f.attributes ?? [])
      .filter((a) => a.k)
      .map((a) => `${a.k}=${a.v}`)
      .join('; ')
    return [
      q(f.name),
      f.kind,
      lat.toFixed(6),
      lng.toFixed(6),
      q(featureStat(f)),
      q(f.notes),
      q(attrs),
      new Date(f.createdAt).toISOString(),
    ].join(',')
  })
  return ['name,kind,latitude,longitude,measurement,notes,attributes,created', ...rows].join(
    '\n',
  )
}

/** Share via the OS share sheet when available, otherwise download. */
export async function shareOrDownload(
  filename: string,
  mime: string,
  content: string | Blob,
): Promise<'shared' | 'downloaded'> {
  const file = new File([content], filename, { type: mime })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename })
      return 'shared'
    } catch {
      // fall through to download (user cancelled or share failed)
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return 'downloaded'
}
