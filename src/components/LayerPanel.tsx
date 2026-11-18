import type { ReactNode } from 'react'
import type { RasterOverlay } from '../lib/store'
import { formatAge } from '../lib/livefires'

interface LayerPanelProps {
  rasterOverlays: RasterOverlay[]
  hiddenIds: Set<string>
  onToggle: (id: string) => void
  onRemoveRaster: (id: string) => void
  onFocus: (id: string) => void
  liveEnabled: boolean
  liveFetchedAt: number | null
  liveRefreshing: boolean
  onToggleLive: () => void
  onRefreshLive: () => void
  livePerimetersEnabled: boolean
  onToggleLivePerimeters: () => void
  gridOn: boolean
  onToggleGrid: () => void
  basemap: 'streets' | 'satellite'
  onSetBasemap: (b: 'streets' | 'satellite') => void
  onClose: () => void
  /** My Data: the editable layer tree (drawn and imported features). */
  myData: ReactNode
  hasMyData: boolean
}

export default function LayerPanel({
  rasterOverlays,
  hiddenIds,
  onToggle,
  onRemoveRaster,
  onFocus,
  liveEnabled,
  liveFetchedAt,
  liveRefreshing,
  onToggleLive,
  onRefreshLive,
  livePerimetersEnabled,
  onToggleLivePerimeters,
  gridOn,
  onToggleGrid,
  basemap,
  onSetBasemap,
  onClose,
  myData,
  hasMyData,
}: LayerPanelProps) {
  const collapsed = false

  return (
    <div className="layer-panel">
      <div className="panel-header">
        <span>Layers</span>
        <button className="panel-close" onClick={onClose} aria-label="Close layers">
          ✕
        </button>
      </div>
      <div className="layer-row">
        <span className="name">Basemap</span>
        <span className="basemap-choice">
          {(['streets', 'satellite'] as const).map((b) => (
            <button
              key={b}
              className={basemap === b ? 'selected' : ''}
              onClick={() => onSetBasemap(b)}
            >
              {b === 'streets' ? '🗺 Streets' : '🛰 Satellite'}
            </button>
          ))}
        </span>
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
      {!collapsed && liveEnabled && (
        <div className="layer-row sub-row">
          <input
            type="checkbox"
            checked={livePerimetersEnabled}
            onChange={onToggleLivePerimeters}
            title="Show/hide fire perimeters"
          />
          <span className="name">Fire perimeters</span>
        </div>
      )}
      {!collapsed && (
        <div className="layer-row">
          <input
            type="checkbox"
            checked={gridOn}
            onChange={onToggleGrid}
            title="Show/hide UTM grid"
          />
          <span className="name">
            UTM grid
            <div className="meta">1 km cells · MGRS refs</div>
          </span>
        </div>
      )}
      {!collapsed && myData}
      {!collapsed &&
        rasterOverlays.map((raster) => (
          <div className="layer-row" key={raster.id}>
            <input
              type="checkbox"
              checked={!hiddenIds.has(raster.id)}
              onChange={() => onToggle(raster.id)}
              title="Show/hide"
            />
            <span
              className="name"
              onClick={() => onFocus(raster.id)}
              title="Zoom to layer"
              style={{ cursor: 'pointer' }}
            >
              🗺 {raster.name}
              <div className="meta">
                GeoPDF · {new Date(raster.addedAt).toLocaleDateString()}
              </div>
            </span>
            <button
              onClick={() => {
                if (confirm(`Remove "${raster.name}" from your device?`)) {
                  onRemoveRaster(raster.id)
                }
              }}
              title="Delete layer"
            >
              ✕
            </button>
          </div>
        ))}
      {!collapsed && !hasMyData && rasterOverlays.length === 0 && (
        <div className="empty">Scan a fire QR code or import a KML, KMZ, GPX, CSV or GeoPDF to get started.</div>
      )}
    </div>
  )
}
