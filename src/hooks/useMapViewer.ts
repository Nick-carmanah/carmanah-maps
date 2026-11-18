import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LngLatBoundsLike } from 'maplibre-gl'
import { boundsOfPositions } from '../lib/geo'
import type { LibraryMap } from '../lib/library/types'
import {
  BASE_MAP,
  readBasemapAround,
  readLastMap,
  sameChoice,
  saveBasemapAround,
  saveLastMap,
  startupChoice,
  type MapChoice,
} from '../lib/library/viewer'
import { mapLayerOf, type MapLayer } from './useMapsLibrary'

/** What the hook needs from the Maps library. */
interface Library {
  ownerId: string
  ready: boolean
  maps: LibraryMap[]
  readImage(map: LibraryMap): Promise<Blob | null>
}

/** Fit the map view to a map's extent (instant: it's a new map, not a pan). */
export type FitMap = (bounds: LngLatBoundsLike, maxZoom: number) => void

/**
 * Avenza's model: My Maps lists the base map and the person's maps; picking
 * one opens a view of only that map. The last map opened is reopened at
 * launch (per person); with none, the app opens on My Maps.
 */
export function useMapViewer(library: Library, fit: FitMap, notify: (message: string, isError?: boolean) => void) {
  const { ownerId } = library
  const [initial] = useState(() => startupChoice(readLastMap(ownerId), null))
  const [screen, setScreen] = useState<'list' | 'map'>(initial ? 'map' : 'list')
  const [choice, setChoice] = useState<MapChoice>(initial ?? BASE_MAP)
  const [basemapAround, setBasemapAroundState] = useState(() => readBasemapAround(ownerId))
  const fitRef = useRef(fit)
  fitRef.current = fit
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const readImageRef = useRef(library.readImage)
  readImageRef.current = library.readImage
  // A reopened map is fitted once the library has loaded it.
  const pendingFit = useRef(initial?.kind === 'map')

  const current = choice.kind === 'map' ? (library.maps.find((m) => m.id === choice.id) ?? null) : null

  const fitTo = useCallback((map: LibraryMap) => {
    const bounds = boundsOfPositions(map.corners)
    const maxZoom = map.raster.kind === 'tiles' ? map.raster.maxzoom : 18
    if (bounds) fitRef.current(bounds, maxZoom)
  }, [])

  // Once the maps have loaded: drop a remembered map that's gone, fit a reopened one.
  useEffect(() => {
    if (!library.ready || choice.kind !== 'map') return
    if (!current) {
      setChoice(BASE_MAP)
      setScreen('list')
      saveLastMap(ownerId, null)
      return
    }
    if (pendingFit.current) {
      pendingFit.current = false
      fitTo(current)
    }
  }, [library.ready, choice, current, ownerId, fitTo])

  /**
   * Open the base map or a map. A different map is shown whole; the same one
   * stays where it was. `known` is the map itself when it was only just added.
   */
  const open = useCallback(
    (next: MapChoice, known?: LibraryMap) => {
      const changed = !sameChoice(next, choice)
      setChoice(next)
      setScreen('map')
      saveLastMap(ownerId, next)
      if (changed && next.kind === 'map') {
        const map = known?.id === next.id ? known : library.maps.find((m) => m.id === next.id)
        if (map) fitTo(map)
      }
    },
    [choice, ownerId, library.maps, fitTo],
  )

  const showList = useCallback(() => setScreen('list'), [])
  /** Back to the open map without choosing (e.g. after an import made from the map). */
  const showMap = useCallback(() => setScreen('map'), [])

  const setBasemapAround = useCallback(
    (on: boolean) => {
      setBasemapAroundState(on)
      saveBasemapAround(ownerId, on)
    },
    [ownerId],
  )

  // A single-image map's image, read when it's opened and let go when another is.
  const [image, setImage] = useState<{ id: string; url: string } | null>(null)
  const imageKey =
    current && current.raster.kind !== 'tiles'
      ? `${current.id}|${current.raster.kind === 'image' ? current.raster.path : current.raster.rasterId}`
      : ''
  useEffect(() => {
    if (!imageKey || !current) {
      setImage(null)
      return
    }
    let live = true
    let url: string | null = null
    const map = current
    readImageRef
      .current(map)
      .then((blob) => {
        if (!live) return
        if (!blob) throw new Error('its image is missing from this device')
        url = URL.createObjectURL(blob)
        setImage({ id: map.id, url })
      })
      .catch((err) => live && notifyRef.current(`"${map.name}" can't be shown: ${(err as Error).message}`, true))
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey, library.ready])

  /** Only the open map is drawn. */
  const layers = useMemo<MapLayer[]>(() => {
    if (!current) return []
    if (current.raster.kind === 'tiles') return [mapLayerOf(current)]
    return image?.id === current.id ? [mapLayerOf(current, image.url)] : []
  }, [current, image])

  return {
    screen,
    choice,
    current,
    title: current?.name ?? 'Base map',
    open,
    showList,
    showMap,
    layers,
    basemapAround,
    setBasemapAround,
    /** The base map shows on its own, or around a custom map when chosen. */
    basemapShown: choice.kind === 'base' || basemapAround,
  }
}
