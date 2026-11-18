import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { Map as MlMap } from 'maplibre-gl'
import type { Position } from 'geojson'
import GpsAverageSheet, { type AveragedPlacemark } from '../components/GpsAverageSheet'
import GpsInfoPanel from '../components/GpsInfoPanel'
import { DEFAULT_LAYER_COLOR, type Layer } from '../lib/layers'
import type { UserFeature } from '../lib/features'
import { openInGoogleMaps } from '../lib/google-maps'
import type { PhotoPlot } from '../lib/plot-photos'
import { formatCoord } from '../lib/coords'
import { getUnitSettings } from '../lib/units'
import { writeBatch } from '../lib/store'

export interface ToolEntry {
  icon: string
  label: string
  action: () => void
}

export interface GpsToolsDeps {
  map: MlMap | null
  layers: Layer[]
  features: UserFeature[]
  /** Id of the user's top-level layer with this name, created if needed. */
  ensureLayer: (name: string) => string
  /** Save a placemark the normal way (naming, layer style, opens its sheet). */
  createPin: (
    position: Position,
    notes: string,
    opts: { label: string; layerId: string | null; attributes: { k: string; v: string }[] },
  ) => void
  /** Features already saved to storage: show them. */
  onPlotted: (features: UserFeature[]) => void
  notify: (message: string, isError?: boolean) => void
  /** Leave pin/measure modes before a tool takes over. */
  onBeforeTool: () => void
}

/**
 * The GPS tools in the Tools list that live outside the map: Plot GPS
 * average, GPS info, View in Google Maps (crosshair) and Plot photos.
 * Returns the Tools entries and what they render, so App only lists them.
 */
export function useGpsTools(deps: GpsToolsDeps): { tools: ToolEntry[]; view: ReactNode } {
  const [open, setOpen] = useState<'average' | 'info' | null>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const depsRef = useRef(deps)
  depsRef.current = deps

  const handlePhotos = useCallback(async (files: File[]) => {
    const d = depsRef.current
    if (!files.length) return
    d.notify(`Reading ${files.length} photo${files.length === 1 ? '' : 's'}…`)
    try {
      // The EXIF reader loads on first use (it is precached, so offline too).
      const { PHOTO_LAYER, plotPhotos, plotSummary } = await import('../lib/plot-photos')
      // The layer is only created once there is something to put in it.
      const existing = d.layers.find((l) => !l.parentId && !l.source && l.name === PHOTO_LAYER)
      const color = existing?.style.color ?? DEFAULT_LAYER_COLOR
      const plot: PhotoPlot = await plotPhotos(files, existing?.id ?? '', color, d.features)
      if (plot.features.length) {
        const layerId = existing?.id ?? depsRef.current.ensureLayer(PHOTO_LAYER)
        for (const f of plot.features) f.layerId = layerId
        await writeBatch({ features: plot.features, photos: plot.photos })
        depsRef.current.onPlotted(plot.features)
      }
      const { message, isError } = plotSummary(plot)
      depsRef.current.notify(message, isError)
    } catch (err) {
      depsRef.current.notify(`Could not plot photos: ${(err as Error).message}`, true)
    }
  }, [])

  const tools: ToolEntry[] = [
    {
      icon: '🎯',
      label: 'Plot GPS average',
      action: () => {
        deps.onBeforeTool()
        setOpen('average')
      },
    },
    {
      icon: '📡',
      label: 'GPS info',
      action: () => setOpen('info'),
    },
    {
      icon: '🌐',
      label: 'View crosshair in Google Maps',
      action: () => {
        const c = deps.map?.getCenter()
        if (!c) return
        const at: Position = [c.lng, c.lat]
        if (openInGoogleMaps(at) === 'offline') {
          deps.notify(
            `Google Maps needs signal. Crosshair: ${formatCoord(at, getUnitSettings().coords)}`,
            true,
          )
        }
      },
    },
    {
      icon: '🖼',
      label: 'Plot photos',
      action: () => photoInputRef.current?.click(),
    },
  ]

  const view = (
    <>
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          handlePhotos(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      {open === 'average' && (
        <GpsAverageSheet
          map={deps.map}
          layers={deps.layers}
          onClose={() => setOpen(null)}
          onSave={(p: AveragedPlacemark) => {
            setOpen(null)
            deps.createPin(p.position, p.notes, {
              label: 'GPS average',
              layerId: p.layerId,
              attributes: p.attributes,
            })
          }}
        />
      )}
      {open === 'info' && <GpsInfoPanel onClose={() => setOpen(null)} onNotify={deps.notify} />}
    </>
  )

  return { tools, view }
}
