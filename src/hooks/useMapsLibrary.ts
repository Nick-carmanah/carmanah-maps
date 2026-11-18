import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapsLibrary, shareOrDownloadFile } from '../lib/library/library'
import { importGeoPdf, sharpenMap, type ImportProgress, type PagePickRequest } from '../lib/library/import'
import { forgetMapTiles, mapTileUrl, registerMapTileProtocol } from '../lib/library/tile-protocol'
import type { GeoPdfRegion } from '../lib/geopdf'
import type { Corners, LibraryMap } from '../lib/library/types'
import { pageOwnerId, readMapsContext } from '../lib/storage/owner'
import { getProfile } from '../lib/naming'

/** What the map view needs to draw one library map. */
export interface MapLayer {
  id: string
  corners: Corners
  opacity: number
  visible: boolean
  /** Tiled maps: a raster tile source read through the map-tile protocol. */
  tiles?: { url: string; minzoom: number; maxzoom: number; bounds: [number, number, number, number] }
  /** Single-image maps: object URL of the image, once read from storage. */
  imageUrl?: string
}

export interface PendingPick {
  request: PagePickRequest
  resolve(regions: GeoPdfRegion[] | null): void
}

export interface ImportStatus extends ImportProgress {
  fileName: string
  cancel(): void
}

type Notify = (message: string, isError?: boolean) => void

/** The Maps library, for the person signed in (or `guest`). */
export function useMapsLibrary(notify: Notify) {
  // The same owner as every other store on this page (it reloads if that changes).
  const [context] = useState(() => ({ ...readMapsContext(), ownerId: pageOwnerId() }))
  const [library, setLibrary] = useState<MapsLibrary | null>(null)
  const [maps, setMaps] = useState<LibraryMap[]>([])
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null)
  const pendingPickRef = useRef<PendingPick | null>(null)
  pendingPickRef.current = pendingPick
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
  const [imageUrls, setImageUrls] = useState<Map<string, string>>(new Map())
  const loadingUrls = useRef(new Set<string>())
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  // Tiles are read straight from this person's file store.
  const mapsRef = useRef(maps)
  mapsRef.current = maps
  useEffect(() => {
    if (!library) return
    registerMapTileProtocol((id) => {
      const map = mapsRef.current.find((m) => m.id === id)
      return map?.raster.kind === 'tiles' ? { files: library.files, path: map.raster.path } : null
    })
  }, [library])

  useEffect(() => {
    let live = true
    MapsLibrary.open(context.ownerId)
      .then(async (lib) => {
        const stored = await lib.list()
        if (!live) return
        setLibrary(lib)
        setMaps(stored)
      })
      .catch((err) => notifyRef.current(`Couldn't open your saved maps: ${(err as Error).message}`, true))
    return () => {
      live = false
    }
  }, [context.ownerId])

  /** New maps go in the fire's folder: the crew app's fire, else the profile's, else Unsorted. */
  const defaultFolder = context.fireNumber || getProfile().fireNumber || ''

  // Read each visible map's image once; keep the URL while the map exists.
  useEffect(() => {
    if (!library) return
    for (const map of maps) {
      if (map.raster.kind === 'tiles') continue
      if (!map.visible || imageUrls.has(map.id) || loadingUrls.current.has(map.id)) continue
      loadingUrls.current.add(map.id)
      library
        .readImage(map)
        .then((blob) => {
          if (!blob) throw new Error('its image is missing from this device')
          const url = URL.createObjectURL(blob)
          setImageUrls((prev) => new Map(prev).set(map.id, url))
        })
        .catch((err) => notifyRef.current(`"${map.name}" can't be shown: ${(err as Error).message}`, true))
        .finally(() => loadingUrls.current.delete(map.id))
    }
    const ids = new Set(maps.map((m) => m.id))
    const gone = [...imageUrls.keys()].filter((id) => !ids.has(id))
    if (gone.length) {
      gone.forEach((id) => URL.revokeObjectURL(imageUrls.get(id)!))
      setImageUrls((prev) => {
        const next = new Map(prev)
        gone.forEach((id) => next.delete(id))
        return next
      })
    }
  }, [library, maps, imageUrls])

  // (The app never unmounts this hook; its URLs go with the page.)

  /** Oldest first, so newer maps draw on top. */
  const layers = useMemo<MapLayer[]>(
    () =>
      [...maps]
        .sort((a, b) => a.addedAt - b.addedAt)
        .map((m) => ({
          id: m.id,
          corners: m.corners,
          opacity: m.opacity,
          visible: m.visible,
          tiles:
            m.raster.kind === 'tiles'
              ? { url: mapTileUrl(m.id), minzoom: m.raster.minzoom, maxzoom: m.raster.maxzoom, bounds: m.raster.bounds }
              : undefined,
          imageUrl: imageUrls.get(m.id),
        })),
    [maps, imageUrls],
  )

  /** Update in memory now; save in the background. */
  const updateMap = useCallback(
    (id: string, patch: Partial<Omit<LibraryMap, 'id'>>, persist = true) => {
      setMaps((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)))
      if (persist && library) {
        library.update(id, patch).catch((err) => notifyRef.current(`Couldn't save: ${(err as Error).message}`, true))
      }
    },
    [library],
  )

  const removeMap = useCallback(
    async (id: string) => {
      if (!library) return
      await library.remove(id)
      forgetMapTiles(id)
      setMaps((prev) => prev.filter((m) => m.id !== id))
    },
    [library],
  )

  const readOriginal = useCallback(
    (map: LibraryMap) => library?.readOriginal(map) ?? Promise.resolve(null),
    [library],
  )

  const shareFile = useCallback(async (file: File) => {
    try {
      const how = await shareOrDownloadFile(file)
      if (how === 'downloaded') notifyRef.current(`Downloaded ${file.name}`)
    } catch (err) {
      notifyRef.current(`Couldn't share ${file.name}: ${(err as Error).message}`, true)
    }
  }, [])

  /** Import a GeoPDF. Resolves with the maps it saved (empty if cancelled). */
  const importPdf = useCallback(
    async (file: File): Promise<LibraryMap[]> => {
      // A file dropped while the library is still opening waits for it.
      const lib = library ?? (await MapsLibrary.open(context.ownerId))
      const abort = new AbortController()
      const cancel = () => {
        abort.abort()
        pendingPickRef.current?.resolve(null)
      }
      setImportStatus({ fileName: file.name, label: 'Reading the file', fraction: 0, cancel })
      try {
        const result = await importGeoPdf(lib, file, {
          folder: defaultFolder,
          signal: abort.signal,
          onProgress: (p) => setImportStatus({ fileName: file.name, ...p, cancel }),
          pickRegions: (request) =>
            new Promise((resolve) =>
              setPendingPick({
                request,
                resolve: (regions) => {
                  setPendingPick(null)
                  resolve(regions)
                },
              }),
            ),
        })
        if (result.maps.length) setMaps((prev) => [...result.maps, ...prev])
        const saved = result.maps.length
        if (result.cancelled) {
          notifyRef.current(saved ? `Import stopped — ${saved} map${saved > 1 ? 's' : ''} saved` : 'Import cancelled')
        } else if (result.failed.length) {
          notifyRef.current(
            `${file.name}: ${result.failed.length} map${result.failed.length > 1 ? 's' : ''} not saved (${result.failed[0].error})`,
            true,
          )
        } else if (result.drawErrors.length) {
          console.warn(`${file.name}: pdf.js skipped errors while drawing`, result.drawErrors)
          notifyRef.current(
            `${file.name}: saved, but part of the map didn't draw (${result.drawErrors[0]}). Text or layers may be missing. Update the phone's software, or report this map.`,
            true,
          )
        } else if (saved) {
          notifyRef.current(
            saved > 1 ? `Added ${saved} maps from ${file.name} — saved for offline use` : `Added "${result.maps[0].name}" — saved for offline use`,
          )
        }
        return result.maps
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') {
          notifyRef.current('Import cancelled')
          return []
        }
        throw err
      } finally {
        setImportStatus(null)
      }
    },
    [library, context.ownerId, defaultFolder],
  )

  /** Re-draw an older single-image map from its kept original, as sharp tiles. */
  const sharpen = useCallback(
    async (map: LibraryMap) => {
      if (!library) return
      const abort = new AbortController()
      const cancel = () => abort.abort()
      const fileName = map.name
      setImportStatus({ fileName, label: 'Reading the original', fraction: 0, cancel })
      try {
        const next = await sharpenMap(library, map, {
          signal: abort.signal,
          onProgress: (p) => setImportStatus({ fileName, ...p, cancel }),
        })
        forgetMapTiles(map.id)
        const url = imageUrls.get(map.id)
        if (url) {
          URL.revokeObjectURL(url)
          setImageUrls((prev) => {
            const nextUrls = new Map(prev)
            nextUrls.delete(map.id)
            return nextUrls
          })
        }
        setMaps((prev) => prev.map((m) => (m.id === map.id ? next : m)))
        notifyRef.current(`"${map.name}" is now sharp to about ${next.raster.kind === 'tiles' ? next.raster.dpi : 300} DPI`)
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') notifyRef.current('Stopped — the map is unchanged')
        else notifyRef.current(`Couldn't sharpen "${map.name}": ${(err as Error).message}`, true)
      } finally {
        setImportStatus(null)
      }
    },
    [library, imageUrls],
  )

  return {
    ownerId: context.ownerId,
    sharpen,
    ready: library !== null,
    storageBackend: library?.files.backend ?? null,
    maps,
    layers,
    defaultFolder,
    updateMap,
    removeMap,
    readOriginal,
    shareFile,
    importPdf,
    importStatus,
    pendingPick,
  }
}
