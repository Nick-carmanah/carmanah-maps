import type { Overlay } from '../lib/store'
import { formatAge } from '../lib/livefires'
import { featureLayer, featureStat, KIND_ICONS, type UserFeature } from '../lib/features'

export type ExportFormat = 'kml' | 'kmz' | 'gpx' | 'csv'

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
  livePerimetersEnabled: boolean
  onToggleLivePerimeters: () => void
  gridOn: boolean
  onToggleGrid: () => void
  basemap: 'streets' | 'satellite'
  onSetBasemap: (b: 'streets' | 'satellite') => void
  onClose: () => void
  userFeatures: UserFeature[]
  hiddenLayers: Set<string>
  onToggleLayer: (name: string) => void
  onEditFeature: (id: string) => void
  onFocusFeature: (id: string) => void
  onExport: (format: ExportFormat, layer?: string) => void
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
  livePerimetersEnabled,
  onToggleLivePerimeters,
  gridOn,
  onToggleGrid,
  basemap,
  onSetBasemap,
  onClose,
  userFeatures,
  hiddenLayers,
  onToggleLayer,
  onEditFeature,
  onFocusFeature,
  onExport,
}: LayerPanelProps) {
  const collapsed = false

  const layers = new Map<string, UserFeature[]>()
  for (const f of userFeatures) {
    const name = featureLayer(f)
    if (!layers.has(name)) layers.set(name, [])
    layers.get(name)!.push(f)
  }

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
      {!collapsed && userFeatures.length > 0 && (
        <>
          <div className="section-header">
            <span>My Data ({userFeatures.length})</span>
            <span className="export-btns">
              {(['kmz', 'kml', 'gpx', 'csv'] as const).map((fmt) => (
                <button key={fmt} onClick={() => onExport(fmt)} title={`Export all as ${fmt.toUpperCase()}`}>
                  {fmt.toUpperCase()}
                </button>
              ))}
            </span>
          </div>
          {[...layers.entries()].map(([layerName, features]) => (
            <div key={layerName}>
              <div className="layer-row layer-group">
                <input
                  type="checkbox"
                  checked={!hiddenLayers.has(layerName)}
                  onChange={() => onToggleLayer(layerName)}
                  title="Show/hide layer"
                />
                <span className="name group-name">
                  {layerName}
                  <span className="meta"> · {features.length}</span>
                </span>
                <span className="export-btns">
                  <button
                    onClick={() => onExport('kmz', layerName)}
                    title={`Share only "${layerName}" (KMZ with photos)`}
                  >
                    Share
                  </button>
                </span>
              </div>
              {features.map((f) => (
                <div className="layer-row sub-row" key={f.id}>
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
          ))}
        </>
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
