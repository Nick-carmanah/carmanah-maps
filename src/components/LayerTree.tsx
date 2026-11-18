import { useState } from 'react'
import { featureStat, KIND_ICONS, type UserFeature } from '../lib/features'
import { layerTree, subtreeIds, type Layer } from '../lib/layers'

interface LayerTreeProps {
  layers: Layer[]
  features: UserFeature[]
  /** Layers not drawn (hidden themselves or under a hidden parent). */
  hiddenLayerIds: Set<string>
  onToggleLayer: (id: string) => void
  onEditLayer: (id: string) => void
  onShareLayer: (id: string) => void
  onFocusLayer: (id: string) => void
  onEditFeature: (id: string) => void
  onFocusFeature: (id: string) => void
  onNewLayer: () => void
  onExport: () => void
}

/** Layers above this many features start collapsed. */
const OPEN_LIMIT = 15

/** "My Data": every layer (drawn or imported) as one editable tree. */
export default function LayerTree({
  layers,
  features,
  hiddenLayerIds,
  onToggleLayer,
  onEditLayer,
  onShareLayer,
  onFocusLayer,
  onEditFeature,
  onFocusFeature,
  onNewLayer,
  onExport,
}: LayerTreeProps) {
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const byLayer = new Map<string, UserFeature[]>()
  for (const f of features) {
    if (!byLayer.has(f.layerId)) byLayer.set(f.layerId, [])
    byLayer.get(f.layerId)!.push(f)
  }
  const total = (id: string) =>
    [...subtreeIds(layers, id)].reduce((n, l) => n + (byLayer.get(l)?.length ?? 0), 0)

  return (
    <>
      <div className="section-header">
        <span>My Data ({features.length})</span>
        <span className="export-btns">
          <button onClick={onNewLayer} title="Create an empty layer">
            + Layer
          </button>
          {features.length > 0 && (
            <button onClick={onExport} title="Export or share layers (KMZ, KML, GPX, CSV)">
              Export…
            </button>
          )}
        </span>
      </div>
      {layerTree(layers).map(({ layer, depth }) => {
        const own = byLayer.get(layer.id) ?? []
        const defaultOpen = own.length <= OPEN_LIMIT
        const open = toggled.has(layer.id) ? !defaultOpen : defaultOpen
        const dimmed = layer.visible && hiddenLayerIds.has(layer.id)
        const count = total(layer.id)
        return (
          <div key={layer.id}>
            <div
              className="layer-row layer-group"
              style={{ paddingLeft: 12 + depth * 16, opacity: dimmed ? 0.55 : 1 }}
            >
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={() => onToggleLayer(layer.id)}
                title={dimmed ? 'Shown, but a parent layer is hidden' : 'Show/hide layer'}
              />
              <button
                className="tree-toggle"
                onClick={() =>
                  setToggled((prev) => {
                    const next = new Set(prev)
                    if (next.has(layer.id)) next.delete(layer.id)
                    else next.add(layer.id)
                    return next
                  })
                }
                disabled={!own.length}
                aria-label={open ? 'Collapse' : 'Expand'}
              >
                {own.length ? (open ? '▾' : '▸') : '·'}
              </button>
              <span
                className="name group-name"
                onClick={() => count && onFocusLayer(layer.id)}
                title={count ? 'Zoom to layer' : undefined}
                style={{ cursor: count ? 'pointer' : undefined }}
              >
                {layer.name}
                <span className="meta"> · {count}</span>
                {(layer.source || layer.schema.length > 0) && (
                  <div className="meta">
                    {[
                      layer.source?.format && `${layer.source.format.toUpperCase()} import`,
                      layer.schema.length > 0 &&
                        `${layer.schema.length} attribute${layer.schema.length === 1 ? '' : 's'}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                )}
              </span>
              <span className="export-btns">
                {count > 0 && (
                  <button
                    onClick={() => onShareLayer(layer.id)}
                    title={`Share "${layer.name}" as KMZ with photos (opens in Avenza and Google Earth)`}
                  >
                    Share
                  </button>
                )}
                <button onClick={() => onEditLayer(layer.id)} title="Edit layer">
                  ✎
                </button>
              </span>
            </div>
            {open &&
              own.map((f) => (
                <div className="layer-row sub-row" key={f.id} style={{ paddingLeft: 28 + depth * 16 }}>
                  <span className="kind-icon" style={{ color: f.color }}>
                    {KIND_ICONS[f.kind]}
                  </span>
                  <span
                    className="name"
                    onClick={() => onFocusFeature(f.id)}
                    title="Zoom to"
                    style={{ cursor: 'pointer' }}
                  >
                    {f.name}
                    <div className="meta">{featureStat(f)}</div>
                  </span>
                  <button onClick={() => onEditFeature(f.id)} title="Edit">
                    ✎
                  </button>
                </div>
              ))}
          </div>
        )
      })}
    </>
  )
}
