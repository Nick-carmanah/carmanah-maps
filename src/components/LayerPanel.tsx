import { useState } from 'react'
import type { Overlay } from '../lib/store'
import { formatAge } from '../lib/livefires'

interface LayerPanelProps {
  overlays: Overlay[]
  hiddenIds: Set<string>
  onToggle: (id: string) => void
  onRemove: (id: string) => void
  onFocus: (id: string) => void
  liveEnabled: boolean
  liveFetchedAt: number | null
  liveRefreshing: boolean
  onToggleLive: () => void
  onRefreshLive: () => void
}

export default function LayerPanel({
  overlays,
  hiddenIds,
  onToggle,
  onRemove,
  onFocus,
  liveEnabled,
  liveFetchedAt,
  liveRefreshing,
  onToggleLive,
  onRefreshLive,
}: LayerPanelProps) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="layer-panel">
      <div className="panel-header" onClick={() => setCollapsed((c) => !c)}>
        <span>Layers ({overlays.length})</span>
        <span>{collapsed ? '▸' : '▾'}</span>
      </div>
      {!collapsed && (
        <div className="layer-row">
          <input
            type="checkbox"
            checked={liveEnabled}
            onChange={onToggleLive}
            title="Show/hide live fires"
          />
          <span className="name">
            Live BC fires
            <div className="meta">
              {liveRefreshing
                ? 'updating…'
                : liveFetchedAt
                  ? `updated ${formatAge(liveFetchedAt)}`
                  : 'not loaded yet'}
            </div>
          </span>
          <button onClick={onRefreshLive} disabled={liveRefreshing} title="Refresh live fires">
            ↻
          </button>
        </div>
      )}
      {!collapsed &&
        (overlays.length === 0 ? (
          <div className="empty">Scan a fire QR code or import a KML to get started.</div>
        ) : (
          overlays.map((overlay) => (
            <div className="layer-row" key={overlay.id}>
              <input
                type="checkbox"
                checked={!hiddenIds.has(overlay.id)}
                onChange={() => onToggle(overlay.id)}
                title="Show/hide"
              />
              <span
                className="name"
                onClick={() => onFocus(overlay.id)}
                title="Zoom to layer"
                style={{ cursor: 'pointer' }}
              >
                {overlay.name}
                <div className="meta">
                  {overlay.geojson.features.length} features ·{' '}
                  {new Date(overlay.addedAt).toLocaleDateString()}
                </div>
              </span>
              <button
                onClick={() => {
                  if (confirm(`Remove "${overlay.name}" from your device?`)) {
                    onRemove(overlay.id)
                  }
                }}
                title="Delete layer"
              >
                ✕
              </button>
            </div>
          ))
        ))}
    </div>
  )
}
