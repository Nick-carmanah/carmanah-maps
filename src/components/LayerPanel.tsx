import type { ReactNode } from 'react'
import { formatAge } from '../lib/livefires'

interface LayerPanelProps {
  /** The map that's open (a custom map or the base map), with a way back to My Maps. */
  currentMap: ReactNode
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
  /** False when satellite has no signal (it's online only). */
  satelliteOk: boolean
  onSetBasemap: (b: 'streets' | 'satellite') => void
  onClose: () => void
  /** My Data: the editable layer tree (drawn and imported features). */
  myData: ReactNode
  hasMyData: boolean
}

export default function LayerPanel({
  currentMap,
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
  satelliteOk,
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
      {currentMap}
      <div className="layer-row">
        <span className="name">
          Basemap
          {basemap === 'satellite' && !satelliteOk && (
            <div className="meta">No signal: showing streets</div>
          )}
        </span>
        <span className="basemap-choice">
          {(['streets', 'satellite'] as const).map((b) => (
            <button
              key={b}
              className={basemap === b ? 'selected' : ''}
              onClick={() => onSetBasemap(b)}
            >
              {b === 'streets' ? '🗺 Streets' : '🛰 Satellite'}
              {b === 'satellite' && !satelliteOk && <small>needs signal</small>}
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
      {!collapsed && !hasMyData && (
        <div className="empty">Scan a fire QR code or import a KML, KMZ, GPX, CSV or GeoPDF to get started.</div>
      )}
    </div>
  )
}
