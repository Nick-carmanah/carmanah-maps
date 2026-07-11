import { useEffect, useRef, useState } from 'react'
import {
  FEATURE_COLORS,
  FIRE_SYMBOLS,
  featureStat,
  KIND_ICONS,
  type UserFeature,
} from '../lib/features'

export interface PhotoThumb {
  id: string
  url: string
}

interface FeatureSheetProps {
  feature: UserFeature
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
                  borderRadius: s.shape === 'triangle' ? '4px' : '50%',
                }}
                onClick={() => update({ symbol: key })}
                title={s.label}
              >
                {s.text}
              </button>
            ))}
          </div>
        )}

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
