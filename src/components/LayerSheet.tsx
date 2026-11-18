import { useEffect, useState } from 'react'
import { DEFAULT_LINE_WIDTH, FEATURE_COLORS } from '../lib/features'
import {
  ATTR_TYPES,
  layerTree,
  subtreeIds,
  type AttrField,
  type AttrType,
  type Layer,
} from '../lib/layers'

interface LayerSheetProps {
  layer: Layer
  layers: Layer[]
  /** Features in this layer and its sublayers. */
  featureCount: number
  onChange: (layer: Layer) => void
  /** Rename a schema field and the values stored under it. */
  onRenameField: (layerId: string, from: string, to: string) => void
  onDelete: (id: string) => void
  onClose: () => void
}

const WIDTHS = [1, 2, 3, 4, 6, 8]

/** Edit a layer: name, parent, default style for new features, and its
 * attribute schema (Avenza's String / Boolean / Integer / Real + picklists). */
export default function LayerSheet({
  layer,
  layers,
  featureCount,
  onChange,
  onRenameField,
  onDelete,
  onClose,
}: LayerSheetProps) {
  const update = (patch: Partial<Layer>) => onChange({ ...layer, ...patch, updatedAt: Date.now() })
  const setField = (i: number, patch: Partial<AttrField>) =>
    update({ schema: layer.schema.map((f, j) => (j === i ? { ...f, ...patch } : f)) })

  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  // Field names commit on blur, so values are renamed once, not per keystroke.
  const [names, setNames] = useState(layer.schema.map((f) => f.name))
  useEffect(() => setNames(layer.schema.map((f) => f.name)), [layer.id, layer.schema])

  const blocked = subtreeIds(layers, layer.id)
  const parents = layerTree(layers).filter(({ layer: l }) => !blocked.has(l.id))

  return (
    <div className="feature-sheet layer-sheet">
      <div className="sheet-header">
        <span className="kind-icon" style={{ color: layer.style.color }}>
          🗂
        </span>
        <input
          className="name-input"
          value={layer.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Layer name"
        />
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="sheet-scroll">
        {layer.source && (
          <div className="sheet-stat">
            Imported{layer.source.fileName ? ` from ${layer.source.fileName}` : ''} ·{' '}
            {new Date(layer.source.importedAt).toLocaleDateString()}
          </div>
        )}
        <div className="layer-field">
          <span>Inside</span>
          <select
            value={layer.parentId ?? ''}
            onChange={(e) => update({ parentId: e.target.value || undefined })}
          >
            <option value="">Top level</option>
            {parents.map(({ layer: l, depth }) => (
              <option key={l.id} value={l.id}>
                {'  '.repeat(depth)}
                {l.name}
              </option>
            ))}
          </select>
        </div>

        <div className="layer-field">
          <span>New features</span>
          <div className="color-swatches">
            {FEATURE_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch${layer.style.color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => update({ style: { ...layer.style, color: c } })}
                aria-label={`Default colour ${c}`}
              />
            ))}
          </div>
          <select
            value={layer.style.width ?? DEFAULT_LINE_WIDTH}
            onChange={(e) => update({ style: { ...layer.style, width: Number(e.target.value) } })}
            title="Line width"
          >
            {WIDTHS.map((w) => (
              <option key={w} value={w}>
                {w} px
              </option>
            ))}
          </select>
        </div>

        <div className="attr-section">
          <div className="attr-title">Attributes</div>
          {layer.schema.map((f, i) => (
            <div className="schema-field" key={i}>
              <div className="attr-row">
                <input
                  value={names[i] ?? ''}
                  placeholder="Attribute name"
                  onChange={(e) => setNames((prev) => prev.map((n, j) => (j === i ? e.target.value : n)))}
                  onBlur={() => {
                    const to = (names[i] ?? '').trim()
                    if (to && to !== f.name && !layer.schema.some((s) => s.name === to)) {
                      onRenameField(layer.id, f.name, to)
                    } else setNames(layer.schema.map((s) => s.name))
                  }}
                />
                <select
                  value={f.type}
                  onChange={(e) => setField(i, { type: e.target.value as AttrType })}
                >
                  {ATTR_TYPES.map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => update({ schema: layer.schema.filter((_, j) => j !== i) })}
                  title="Remove attribute (values stay on features as extra fields)"
                >
                  ✕
                </button>
              </div>
              {f.type !== 'boolean' && (
                <textarea
                  className="picklist-input"
                  rows={Math.min(4, Math.max(1, (f.picklist?.length ?? 0) + 1))}
                  value={(f.picklist ?? []).join('\n')}
                  placeholder="Pick list (optional): one value per line"
                  onChange={(e) => {
                    const values = e.target.value.split('\n')
                    setField(i, {
                      picklist: values.some((v) => v.trim()) ? values : undefined,
                    })
                  }}
                  onBlur={() => {
                    const clean = (f.picklist ?? []).map((v) => v.trim()).filter(Boolean)
                    setField(i, { picklist: clean.length ? clean : undefined })
                  }}
                />
              )}
            </div>
          ))}
          <button
            className="btn small"
            onClick={() => {
              let n = layer.schema.length + 1
              while (layer.schema.some((f) => f.name === `Attribute ${n}`)) n++
              update({ schema: [...layer.schema, { name: `Attribute ${n}`, type: 'string' }] })
            }}
          >
            + Add attribute
          </button>
        </div>

        <div className="sheet-row">
          <span className="settings-hint">
            {featureCount} feature{featureCount === 1 ? '' : 's'}
            {layer.schema.length ? ' · attributes travel with KML/KMZ exports' : ''}
          </span>
          <button
            className="btn danger"
            onClick={() => (armed ? onDelete(layer.id) : setArmed(true))}
          >
            {armed
              ? featureCount
                ? `Tap again: delete ${featureCount} feature${featureCount === 1 ? '' : 's'}`
                : 'Tap again to delete'
              : 'Delete layer'}
          </button>
        </div>
      </div>
    </div>
  )
}
