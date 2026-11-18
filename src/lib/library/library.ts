import { openOwnerDb } from '../storage/owner-db'
import { openFileStore, type FileStore } from '../storage/files'
import { GUEST_OWNER } from '../storage/owner'
import { deleteRaster, listRasters } from '../store'
import { thumbnailOf } from '../geopdf'
import type { LibraryMap } from './types'

/** Opacity new maps start at: the basemap shows through a little (as before the library). */
export const DEFAULT_OPACITY = 0.92
export const THUMB_PX = 192

const opened = new Map<string, Promise<MapsLibrary>>()

/**
 * One person's saved maps: records in `carmanah-maps.<ownerId>`, files in
 * their file store under `library/`:
 *
 *   library/originals/<importId>.pdf   the file exactly as imported (shareable)
 *   library/maps/<mapId>/…             what the map view draws
 */
export class MapsLibrary {
  private constructor(
    readonly ownerId: string,
    readonly files: FileStore,
  ) {}

  /** One library per person per page load. */
  static open(ownerId: string): Promise<MapsLibrary> {
    let library = opened.get(ownerId)
    if (!library) {
      library = (async () => {
        const lib = new MapsLibrary(ownerId, await openFileStore(ownerId))
        // Maps saved before owners existed were made on the website, where
        // everyone is a guest. They belong to the guest library, nobody else's.
        if (ownerId === GUEST_OWNER) await lib.adoptLegacyMaps().catch(() => {})
        return lib
      })()
      opened.set(ownerId, library)
      library.catch(() => opened.delete(ownerId))
    }
    return library
  }

  private db() {
    return openOwnerDb(this.ownerId)
  }

  /** Newest first. */
  async list(): Promise<LibraryMap[]> {
    const maps = await (await this.db()).getAll('maps')
    return maps.sort((a, b) => b.addedAt - a.addedAt)
  }

  async get(id: string): Promise<LibraryMap | undefined> {
    return (await this.db()).get('maps', id)
  }

  async put(map: LibraryMap): Promise<void> {
    await (await this.db()).put('maps', map)
  }

  async update(id: string, patch: Partial<Omit<LibraryMap, 'id'>>): Promise<LibraryMap | undefined> {
    const db = await this.db()
    const tx = db.transaction('maps', 'readwrite')
    const map = await tx.store.get(id)
    if (!map) return undefined
    const next = { ...map, ...patch }
    await tx.store.put(next)
    await tx.done
    return next
  }

  /** Delete a map, its files, and its original once no other map uses it. */
  async remove(id: string): Promise<void> {
    const db = await this.db()
    const map = await db.get('maps', id)
    if (!map) return
    await db.delete('maps', id)
    if (map.raster.kind === 'legacy') await deleteRaster(map.raster.rasterId)
    else await this.files.removeDir(`library/maps/${map.id}`)
    if (map.originalPath && !(await this.list()).some((m) => m.originalPath === map.originalPath)) {
      await this.files.remove(map.originalPath)
    }
  }

  /** The untouched original, named as it was imported, ready to share. */
  async readOriginal(map: LibraryMap): Promise<File | null> {
    if (!map.originalPath) return null
    const blob = await this.files.read(map.originalPath)
    if (!blob) return null
    return new File([blob], map.source?.fileName ?? `${map.name}.pdf`, { type: 'application/pdf' })
  }

  /** The single image of an image or legacy map. */
  async readImage(map: LibraryMap): Promise<Blob | null> {
    if (map.raster.kind === 'image') return this.files.read(map.raster.path)
    if (map.raster.kind === 'legacy') {
      const rasterId = map.raster.rasterId
      return (await listRasters()).find((r) => r.id === rasterId)?.image ?? null
    }
    return null
  }

  /**
   * Maps imported before the library live in the old shared database
   * (store.ts `rasters`), as a PNG and corners only. Give each a library
   * record so it shows, folds and fades like any other map. Their image stays
   * where it is; deleting the map deletes it there.
   */
  private async adoptLegacyMaps(): Promise<void> {
    const legacy = await listRasters()
    const db = await this.db()
    const known = new Set(
      (await db.getAll('maps')).flatMap((m) => (m.raster.kind === 'legacy' ? [m.raster.rasterId] : [])),
    )
    const stillThere = new Set(legacy.map((r) => r.id))
    // Drop records whose old image has gone.
    for (const m of await db.getAll('maps')) {
      if (m.raster.kind === 'legacy' && !stillThere.has(m.raster.rasterId)) await db.delete('maps', m.id)
    }
    for (const raster of legacy) {
      if (known.has(raster.id)) continue
      let thumb: Blob | undefined
      try {
        const bitmap = await createImageBitmap(raster.image)
        thumb = await thumbnailOf(bitmap, THUMB_PX)
        bitmap.close()
      } catch {
        // No thumbnail is fine.
      }
      await db.put('maps', {
        id: raster.id,
        name: raster.name,
        folder: '',
        addedAt: raster.addedAt,
        corners: raster.corners,
        visible: true,
        opacity: DEFAULT_OPACITY,
        raster: { kind: 'legacy', rasterId: raster.id },
        thumb,
        storedBytes: raster.image.size,
      })
    }
  }
}

/**
 * Hand a file to the phone's share sheet (AirDrop, Quick Share, Mail, Files,
 * "Open in Avenza Maps"…), or download it where sharing files isn't
 * supported. Call it straight from a tap, with the file already read: the
 * share sheet only opens in response to a user gesture.
 */
export async function shareOrDownloadFile(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name })
      return 'shared'
    } catch (err) {
      const name = (err as DOMException).name
      if (name === 'AbortError') return 'cancelled'
      // NotAllowedError: the tap "expired" (e.g. a slow read). Download instead.
      if (name !== 'NotAllowedError') throw err
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'downloaded'
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
