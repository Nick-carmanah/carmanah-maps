import { useEffect, useRef, useState } from 'react'
import type { Position } from 'geojson'
import {
  FEATURE_COLORS,
  FIRE_SYMBOLS,
  featureDetails,
  KIND_ICONS,
  type UserFeature,
} from '../lib/features'
import { elevationAt } from '../lib/elevation'
import { DEFAULT_FENCE_RADIUS_M } from '../lib/fences'
import {
  attrValueValid,
  isAutoLayer,
  layerTree,
  normalizeAttrValue,
  type AttrField,
  type Layer,
} from '../lib/layers'
import { formatAltitude, inputDistanceUnit } from '../lib/units'
import { useUnitSettings } from '../hooks/useUnitSettings'
import { buildConventionName, TRACK_TYPES } from '../lib/naming'
import { NWCG_SYMBOLS, nwcgIconUrl } from '../lib/nwcg'
import { getIcon } from '../lib/store'
import { ICON_PREFIX, isImportedIcon } from '../lib/symbols'
import { navTargetPosition } from '../hooks/useNavigation'
import GoogleMapsButton from './GoogleMapsButton'

export interface PhotoThumb {
  id: string
  url: string
}

interface FeatureSheetProps {
  feature: UserFeature
  layers: Layer[]
  /** Id of the top-level layer with this name, created if needed. */
  onEnsureLayer: (name: string) => string
  photos: PhotoThumb[]
  onChange: (feature: UserFeature) => void
  onDelete: (id: string) => void
  onNavigate: (id: string) => void
  onAddPhotos: (files: FileList) => void
  onDeletePhoto: (id: string) => void
  onClose: () => void
}

/** Bottom sheet for editing a pin/line/area: name, notes, color, symbol,
 * layer, attributes (the layer's typed schema, then per-feature fields),
 * photos, navigate, delete. */
export default function FeatureSheet({
  feature,
  layers,
  onEnsureLayer,
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
  const [newLayerName, setNewLayerName] = useState<string | null>(null)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  useEffect(() => {
    setArmed(false)
    setNewLayerName(null)
  }, [feature.id])

  const [viewPhoto, setViewPhoto] = useState<string | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [nwcgOpen, setNwcgOpen] = useState(false)
  const [symbolSearch, setSymbolSearch] = useState('')
  const nwcgMatches = NWCG_SYMBOLS.filter((s) =>
    s.label.toLowerCase().includes(symbolSearch.toLowerCase()),
  )

  const layer = layers.find((l) => l.id === feature.layerId)
  const schema = layer?.schema ?? []
  const schemaNames = new Set(schema.map((f) => f.name))
  const attributes = feature.attributes ?? []

  // Numbers follow the unit settings; re-render when they change.
  useUnitSettings()
  const radiusUnit = inputDistanceUnit()
  const radiusM = feature.geofence?.radiusM ?? DEFAULT_FENCE_RADIUS_M
  const radiusStep = radiusUnit.label === 'm' ? 50 : radiusUnit.label === 'ft' ? 100 : 1

  // Pin elevation from the terrain tiles (works offline in a saved area).
  const pinKey = feature.kind === 'pin' ? (feature.coordinates as Position).join(',') : ''
  const [elevation, setElevation] = useState<number | null>(null)
  useEffect(() => {
    setElevation(null)
    if (!pinKey) return
    let live = true
    elevationAt(pinKey.split(',').map(Number)).then((m) => live && setElevation(m))
    return () => {
      live = false
    }
  }, [pinKey])
  const setAttr = (i: number, patch: Partial<{ k: string; v: string }>) =>
    update({ attributes: attributes.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
  const schemaValue = (name: string) => attributes.find((a) => a.k === name)?.v ?? ''
  const setSchemaValue = (field: AttrField, raw: string) => {
    const v = field.type === 'boolean' ? normalizeAttrValue('boolean', raw) : raw
    const rest = attributes.filter((a) => a.k !== field.name)
    if (v === '') return update({ attributes: rest })
    const at = attributes.findIndex((a) => a.k === field.name)
    const next = [...rest]
    next.splice(at >= 0 ? at : next.length, 0, { k: field.name, v })
    update({ attributes: next })
  }
  // Picking a symbol or track type files the feature into that type's layer,
  // but only while it sits in one of the automatic layers.
  const autoLayer = (name: string) => (isAutoLayer(layer) ? { layerId: onEnsureLayer(name) } : {})

  const iconUrl = useImportedIconUrl(feature.symbol)

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
        <div className="sheet-stat">
          {[
            ...featureDetails(feature),
            elevation != null ? `elev ${formatAltitude(elevation)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
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
                  update({ color: t.color, name: buildConventionName(t.what), ...autoLayer(t.layer) })
                }
                title={`${t.label} — sets color and name${isAutoLayer(layer) ? ', and files it in ' + t.layer : ''}`}
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
            {isImportedIcon(feature.symbol) && (
              <button className="symbol-btn selected" title="Icon from the imported file">
                {iconUrl ? <img src={iconUrl} alt="" className="imported-icon" /> : '?'}
              </button>
            )}
            {Object.entries(FIRE_SYMBOLS).map(([key, s]) => (
              <button
                key={key}
                className={`symbol-btn${feature.symbol === key ? ' selected' : ''}`}
                style={{
                  background: s.color,
                  borderRadius:
                    s.shape === 'triangle' ? '4px' : s.shape === 'square' ? '8px' : '50%',
                }}
                onClick={() => update({ symbol: key, iconHref: undefined, ...autoLayer(s.layer) })}
                title={`${s.label}${isAutoLayer(layer) ? ` → ${s.layer} layer` : ''}`}
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
                  onClick={() => update({ symbol: s.key, iconHref: undefined, ...autoLayer(s.layer) })}
                  title={`${s.label}${isAutoLayer(layer) ? ` → ${s.layer} layer` : ''}`}
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
          {newLayerName === null ? (
            <select
              value={feature.layerId}
              onChange={(e) => {
                if (e.target.value === '__new') setNewLayerName('')
                else update({ layerId: e.target.value })
              }}
            >
              {layerTree(layers).map(({ layer: l, depth }) => (
                <option key={l.id} value={l.id}>
                  {'\u00a0\u00a0'.repeat(depth)}
                  {l.name}
                </option>
              ))}
              <option value="__new">New layer…</option>
            </select>
          ) : (
            <>
              <input
                autoFocus
                value={newLayerName}
                onChange={(e) => setNewLayerName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newLayerName.trim()) {
                    update({ layerId: onEnsureLayer(newLayerName.trim()) })
                    setNewLayerName(null)
                  }
                  if (e.key === 'Escape') setNewLayerName(null)
                }}
                placeholder="e.g. Danger trees"
              />
              <button
                className="btn small"
                disabled={!newLayerName.trim()}
                onClick={() => {
                  update({ layerId: onEnsureLayer(newLayerName.trim()) })
                  setNewLayerName(null)
                }}
              >
                Add
              </button>
            </>
          )}
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
                min={Math.ceil(50 / radiusUnit.meters)}
                step={radiusStep}
                value={Math.round(radiusM / radiusUnit.meters)}
                onChange={(e) =>
                  update({
                    geofence: {
                      enabled: true,
                      radiusM: Math.max(50, Number(e.target.value) * radiusUnit.meters),
                    },
                  })
                }
              />
              {radiusUnit.label} radius
            </span>
          )}
        </div>

        <div className="attr-section">
          {schema.map((field) => {
            const v = schemaValue(field.name)
            const listId = `pick-${feature.id}-${field.name}`
            return (
              <div className="attr-row" key={`s-${field.name}`}>
                <span className="attr-label" title={field.name}>
                  {field.name}
                </span>
                {field.type === 'boolean' ? (
                  <select value={v} onChange={(e) => setSchemaValue(field, e.target.value)}>
                    <option value="">—</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                    {v !== '' && v !== 'true' && v !== 'false' && <option value={v}>{v}</option>}
                  </select>
                ) : (
                  <input
                    value={v}
                    list={field.picklist?.length ? listId : undefined}
                    inputMode={
                      field.type === 'integer' ? 'numeric' : field.type === 'real' ? 'decimal' : undefined
                    }
                    className={attrValueValid(field.type, v) ? '' : 'invalid'}
                    placeholder={field.picklist?.length ? 'Pick or type…' : field.type === 'string' ? '' : '0'}
                    onChange={(e) => setSchemaValue(field, e.target.value)}
                  />
                )}
                {field.picklist?.length ? (
                  <datalist id={listId}>
                    {field.picklist.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                ) : null}
              </div>
            )
          })}
          {attributes.map((a, i) => schemaNames.has(a.k) ? null : (
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

        <div className="feature-links">
          <GoogleMapsButton position={navTargetPosition(feature)} />
        </div>

        <div className="sheet-row">
          <div className="color-swatches">
            {FEATURE_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch${feature.color === c ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => update({ color: c, iconHref: undefined })}
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

/** Object URL for an icon restored from an imported KMZ. */
function useImportedIconUrl(symbol: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!isImportedIcon(symbol)) return
    let objectUrl: string | null = null
    let cancelled = false
    getIcon(symbol!.slice(ICON_PREFIX.length)).then((asset) => {
      if (!asset || cancelled) return
      objectUrl = URL.createObjectURL(asset.blob)
      setUrl(objectUrl)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [symbol])
  return url
}
