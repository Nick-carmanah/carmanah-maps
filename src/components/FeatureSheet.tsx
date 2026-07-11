import { useEffect, useRef, useState } from 'react'
import {
  FEATURE_COLORS,
  FIRE_SYMBOLS,
  featureLayer,
  featureStat,
  KIND_ICONS,
  type UserFeature,
} from '../lib/features'
import { DEFAULT_FENCE_RADIUS_M } from '../lib/fences'
import { buildConventionName, TRACK_TYPES } from '../lib/naming'
import { NWCG_SYMBOLS, nwcgIconUrl } from '../lib/nwcg'

export interface PhotoThumb {
  id: string
  url: string
}

interface FeatureSheetProps {
  feature: UserFeature
  /** Existing layer names, for the layer picker suggestions. */
  layerNames: string[]
  photos: PhotoThumb[]
  onChange: (feature: UserFeature) => void
  onDelete: (id: string) => void
  onNavigate: (id: string) => void
  onAddPhotos: (files: FileList) => void
  onDeletePhoto: (id: string) => void
  onClose: () => void
}

/** Bottom sheet for editing a pin/line/area: name, notes, color, symbol,
 * custom attribute fields, photos, navigate, delete. */
export default function FeatureSheet({
  feature,
  layerNames,
  photos,
  onChange,
  onDelete,
  onNavigate,
  onAddPhotos,
  onDeletePhoto,
  onClose,
}: FeatureSheetProps) {
  const update = (patch: Partial<UserFeature>) =>
    onChange({ ...feature, ...patch, updatedAt: Date.now() })

  // Two-tap delete (native confirm dialogs are unreliable in embedded views).
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  useEffect(() => setArmed(false), [feature.id])

  const [viewPhoto, setViewPhoto] = useState<string | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [nwcgOpen, setNwcgOpen] = useState(false)
  const [symbolSearch, setSymbolSearch] = useState('')
  const nwcgMatches = NWCG_SYMBOLS.filter((s) =>
    s.label.toLowerCase().includes(symbolSearch.toLowerCase()),
  )

  const attributes = feature.attributes ?? []
  const setAttr = (i: number, patch: Partial<{ k: string; v: string }>) =>
    update({ attributes: attributes.map((a, j) => (j === i ? { ...a, ...patch } : a)) })

  return (
    <div className="feature-sheet">
      <div className="sheet-header">
        <span className="kind-icon" style={{ color: feature.color }}>
          {KIND_ICONS[feature.kind]}
        </span>
        <input
          className="name-input"
          value={feature.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Name"
        />
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
      <div className="sheet-scroll">
        <div className="sheet-stat">{featureStat(feature)}</div>
        <textarea
          className="notes-input"
          value={feature.notes}
          onChange={(e) => update({ notes: e.target.value })}
          placeholder="Notes (crew, hazards, status…)"
          rows={2}
        />

        {feature.kind === 'line' && (
          <div className="track-type-row">
            {TRACK_TYPES.map((t) => (
              <button
                key={t.what}
                className="btn small"
                onClick={() =>
                  update({ color: t.color, name: buildConventionName(t.what), layer: t.layer })
                }
                title={`${t.label} — sets color, name, and layer`}
              >
                <span className="type-dot" style={{ background: t.color }} />
                {t.label}
              </button>
            ))}
          </div>
        )}

        {feature.kind === 'pin' && (
          <div className="symbol-row">
            <button
              className={`symbol-btn${!feature.symbol ? ' selected' : ''}`}
              onClick={() => update({ symbol: '' })}
              title="Plain pin"
            >
              ●
            </button>
            {Object.entries(FIRE_SYMBOLS).map(([key, s]) => (
              <button
                key={key}
                className={`symbol-btn${feature.symbol === key ? ' selected' : ''}`}
                style={{
                  background: s.color,
                  borderRadius:
                    s.shape === 'triangle' ? '4px' : s.shape === 'square' ? '8px' : '50%',
                }}
                onClick={() => update({ symbol: key, layer: s.layer })}
                title={`${s.label} → ${s.layer} layer`}
              >
                {s.text}
              </button>
            ))}
            <button
              className={`btn small${nwcgOpen ? ' active' : ''}`}
              onClick={() => setNwcgOpen((o) => !o)}
            >
              {nwcgOpen ? '▴ NWCG' : `▾ NWCG (${NWCG_SYMBOLS.length})`}
            </button>
          </div>
        )}

        {feature.kind === 'pin' && nwcgOpen && (
          <div className="nwcg-picker">
            <input
              value={symbolSearch}
              onChange={(e) => setSymbolSearch(e.target.value)}
              placeholder="Search NWCG GeoOps symbols…"
            />
            <div className="nwcg-grid">
              {nwcgMatches.map((s) => (
                <button
                  key={s.key}
                  className={`nwcg-btn${feature.symbol === s.key ? ' selected' : ''}`}
                  onClick={() => update({ symbol: s.key, layer: s.layer })}
                  title={`${s.label} → ${s.layer} layer`}
                >
                  <img src={nwcgIconUrl(s.file)} alt="" />
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="layer-field">
          <span>Layer</span>
          <input
            list="layer-names"
            value={featureLayer(feature)}
            onChange={(e) => update({ layer: e.target.value })}
            placeholder="e.g. Danger trees"
          />
          <datalist id="layer-names">
            {layerNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>

        <div className="fence-row">
          <label>
            <input
              type="checkbox"
              checked={feature.geofence?.enabled ?? false}
              onChange={(e) =>
                update({
                  geofence: {
                    radiusM: feature.geofence?.radiusM ?? DEFAULT_FENCE_RADIUS_M,
                    enabled: e.target.checked,
                  },
                })
              }
            />
            Geofence alerts (entry/exit)
          </label>
          {feature.kind !== 'area' && feature.geofence?.enabled && (
            <span className="fence-radius">
              <input
                type="number"
                min={50}
                step={50}
                value={feature.geofence?.radiusM ?? DEFAULT_FENCE_RADIUS_M}
                onChange={(e) =>
                  update({
                    geofence: { enabled: true, radiusM: Math.max(50, Number(e.target.value)) },
                  })
                }
              />
              m radius
            </span>
          )}
        </div>

        <div className="attr-section">
          {attributes.map((a, i) => (
            <div className="attr-row" key={i}>
              <input
                value={a.k}
                placeholder="Field"
                onChange={(e) => setAttr(i, { k: e.target.value })}
              />
              <input
                value={a.v}
                placeholder="Value"
                onChange={(e) => setAttr(i, { v: e.target.value })}
              />
              <button
                onClick={() =>
                  update({ attributes: attributes.filter((_, j) => j !== i) })
                }
                title="Remove field"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn small"
            onClick={() => update({ attributes: [...attributes, { k: '', v: '' }] })}
          >
            + Add field
          </button>
        </div>

        <div className="photo-strip">
          {photos.map((p) => (
            <span className="photo-thumb" key={p.id}>
              <img src={p.url} alt="" onClick={() => setViewPhoto(p.url)} />
              <button onClick={() => onDeletePhoto(p.id)} title="Delete photo">
                ✕
              </button>
            </span>
          ))}
          <button className="btn small" onClick={() => photoInputRef.current?.click()}>
            📷 Add photo
          </button>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) onAddPhotos(e.target.files)
              e.target.value = ''
            }}
          />
        </div>

        <div className="sheet-row">
          <div className="color-swatches">
            {FEATURE_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch${feature.color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => update({ color: c })}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
          <span className="sheet-actions">
            <button className="btn" onClick={() => onNavigate(feature.id)}>
              🧭 Navigate
            </button>
            <button
              className="btn danger"
              onClick={() => (armed ? onDelete(feature.id) : setArmed(true))}
            >
              {armed ? 'Tap again to delete' : 'Delete'}
            </button>
          </span>
        </div>
      </div>

      {viewPhoto && (
        <div className="photo-viewer" onClick={() => setViewPhoto(null)}>
          <img src={viewPhoto} alt="" />
        </div>
      )}
    </div>
  )
}
