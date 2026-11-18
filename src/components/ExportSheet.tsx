import { useState } from 'react'
import type { UserFeature } from '../lib/features'
import { layerTree, subtreeIds, type Layer } from '../lib/layers'
import type { ExportFormat, ExportOptions } from '../lib/export'

interface ExportSheetProps {
  layers: Layer[]
  features: UserFeature[]
  /** Layers ticked when the sheet opens. */
  initialLayerIds: string[]
  busy: boolean
  onExport: (opts: ExportOptions) => void
  onClose: () => void
}

const FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
  {
    format: 'kmz',
    label: 'KMZ',
    hint: 'For Avenza Maps and Google Earth: layers, attributes, styles, icons and photos in one file.',
  },
  { format: 'kml', label: 'KML', hint: 'Like KMZ but without photos or icon files.' },
  { format: 'gpx', label: 'GPX', hint: 'Placemarks, lines and tracks (with times) for GPS units. No styles or attributes.' },
  { format: 'csv', label: 'CSV', hint: 'Placemarks only, one row each, with a column per attribute.' },
]

/** Avenza-style export settings: which layers, which format, photos, tracks. */
export default function ExportSheet({
  layers,
  features,
  initialLayerIds,
  busy,
  onExport,
  onClose,
}: ExportSheetProps) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initialLayerIds))
  const [format, setFormat] = useState<ExportFormat>('kmz')
  const [includePhotos, setIncludePhotos] = useState(true)
  const [tracksAsLines, setTracksAsLines] = useState(false)

  const tree = layerTree(layers)
  const picked = features.filter((f) => chosen.has(f.layerId))
  const count = format === 'csv' ? picked.filter((f) => f.kind === 'pin').length : picked.length
  const hasTracks = picked.some((f) => f.kind === 'line' && f.times?.length)
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev)
      const ids = subtreeIds(layers, id)
      const on = !prev.has(id)
      for (const l of ids) {
        if (on) next.add(l)
        else next.delete(l)
      }
      return next
    })
  const roots = tree.filter(({ layer }) => !layer.parentId || !chosen.has(layer.parentId))
  const docName =
    roots.filter(({ layer }) => chosen.has(layer.id)).length === 1
      ? roots.find(({ layer }) => chosen.has(layer.id))!.layer.name
      : 'Carmanah Maps export'

  return (
    <div className="feature-sheet export-sheet">
      <div className="sheet-header">
        <span className="kind-icon">⇪</span>
        <span className="sheet-title">Export layers</span>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      <div className="sheet-scroll">
        <div className="export-layers">
          <div className="export-layer-actions">
            <button className="btn small" onClick={() => setChosen(new Set(layers.map((l) => l.id)))}>
              All
            </button>
            <button className="btn small" onClick={() => setChosen(new Set())}>
              None
            </button>
          </div>
          {tree.map(({ layer, depth }) => (
            <label key={layer.id} className="export-layer" style={{ paddingLeft: depth * 16 }}>
              <input type="checkbox" checked={chosen.has(layer.id)} onChange={() => toggle(layer.id)} />
              {layer.name}
              <span className="meta"> · {features.filter((f) => f.layerId === layer.id).length}</span>
            </label>
          ))}
        </div>

        <div className="units-toggle">
          {FORMATS.map((f) => (
            <button
              key={f.format}
              className={`btn small${format === f.format ? ' active' : ''}`}
              onClick={() => setFormat(f.format)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="settings-hint">{FORMATS.find((f) => f.format === format)!.hint}</div>

        {format === 'kmz' && (
          <label className="export-option">
            <input
              type="checkbox"
              checked={includePhotos}
              onChange={(e) => setIncludePhotos(e.target.checked)}
            />
            Include photos
          </label>
        )}
        {format !== 'csv' && hasTracks && (
          <label className="export-option">
            <input
              type="checkbox"
              checked={tracksAsLines}
              onChange={(e) => setTracksAsLines(e.target.checked)}
            />
            Tracks as lines (drop the GPS times)
          </label>
        )}

        <button
          className="btn primary"
          disabled={!count || busy}
          onClick={() =>
            onExport({
              format,
              layerIds: [...chosen],
              includePhotos,
              tracksAsLines,
              docName,
            })
          }
        >
          {busy
            ? 'Preparing…'
            : count
              ? `Share ${count} ${format === 'csv' ? 'placemark' : 'feature'}${count === 1 ? '' : 's'} as ${format.toUpperCase()}`
              : format === 'csv'
                ? 'No placemarks in these layers'
                : 'Pick at least one layer with features'}
        </button>
      </div>
    </div>
  )
}
