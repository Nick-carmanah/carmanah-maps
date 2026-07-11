import { useEffect, useState } from 'react'
import { FEATURE_COLORS, featureStat, KIND_ICONS, type UserFeature } from '../lib/features'

interface FeatureSheetProps {
  feature: UserFeature
  onChange: (feature: UserFeature) => void
  onDelete: (id: string) => void
  onNavigate: (id: string) => void
  onClose: () => void
}

/** Bottom sheet for editing a pin/line/area: name, notes, color, delete. */
export default function FeatureSheet({
  feature,
  onChange,
  onDelete,
  onNavigate,
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
      <div className="sheet-stat">{featureStat(feature)}</div>
      <textarea
        className="notes-input"
        value={feature.notes}
        onChange={(e) => update({ notes: e.target.value })}
        placeholder="Notes (crew, hazards, status…)"
        rows={2}
      />
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
  )
}
