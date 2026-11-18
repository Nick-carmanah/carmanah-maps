import { openOwnerDb } from './owner-db'

/**
 * Where the map page keeps file bytes: original PDFs, rendered maps, and
 * later tile packs and photos. One interface, several homes:
 *
 *  - `opfs`: the browser's Origin Private File System, under `maps/<ownerId>/`.
 *    Real files: written in a stream, read back by byte range without
 *    loading the whole file. Used where the browser can write OPFS files
 *    from the page (Chrome/Android, Firefox, Safari 26+).
 *  - `idb`: IndexedDB Blobs in `carmanah-maps.<ownerId>`, for browsers
 *    without that (Safari before 26).
 *  - `native` (not built yet, rebuild plan Phase 0.3): Capacitor Filesystem,
 *    `Directory.LibraryNoCloud` + `maps/<ownerId>/`, reached through
 *    `window.Capacitor`. It reads ranges with `fetch(convertFileSrc(uri))` and
 *    a Range header (docs/native-storage-spike.md §5). Its `read` should
 *    avoid loading big files whole; sharing would pass the file's native URI
 *    to the Share plugin instead.
 *
 * Paths are relative to the owner's folder and use `/` between parts, e.g.
 * `library/originals/<id>.pdf`. Website storage is best-effort: the browser
 * may clear it under storage pressure, so the UI says so.
 */
export interface FileStore {
  readonly backend: 'opfs' | 'idb' | 'native'
  /** Write a whole file from parts, in order, replacing any file there. Returns its size. */
  write(path: string, parts: BlobPart[]): Promise<number>
  /** The whole file, or null if there isn't one. Disk-backed on the web, so cheap to get. */
  read(path: string): Promise<Blob | null>
  /** `length` bytes from `offset`. Never loads the whole file. */
  readRange(path: string, offset: number, length: number): Promise<ArrayBuffer>
  /** Size in bytes, or null if there's no such file. */
  size(path: string): Promise<number | null>
  /** Delete a file. Not an error if it's already gone. */
  remove(path: string): Promise<void>
  /** Delete a folder and everything in it. Not an error if it's already gone. */
  removeDir(path: string): Promise<void>
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/

/** Split and check a relative path, so nothing can escape the owner's folder. */
export function pathSegments(path: string): string[] {
  const parts = path.split('/')
  if (!parts.length || parts.some((p) => !SEGMENT_RE.test(p) || p === '.' || p === '..')) {
    throw new Error(`bad storage path: ${path}`)
  }
  return parts
}

class MissingFileError extends Error {
  constructor(path: string) {
    super(`file not found: ${path}`)
  }
}

// ---------- OPFS ----------

class OpfsFileStore implements FileStore {
  readonly backend = 'opfs' as const
  /** File snapshots for range reads. Our files are written once, then only read. */
  private snapshots = new Map<string, Promise<File | null>>()

  constructor(private root: FileSystemDirectoryHandle) {}

  static async open(ownerId: string): Promise<OpfsFileStore> {
    const top = await navigator.storage.getDirectory()
    const maps = await top.getDirectoryHandle('maps', { create: true })
    return new OpfsFileStore(await maps.getDirectoryHandle(ownerId, { create: true }))
  }

  private async dir(segments: string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let dir = this.root
    for (const name of segments) {
      try {
        dir = await dir.getDirectoryHandle(name, { create })
      } catch (err) {
        if ((err as DOMException).name === 'NotFoundError') return null
        throw err
      }
    }
    return dir
  }

  private async file(path: string): Promise<File | null> {
    const segments = pathSegments(path)
    const dir = await this.dir(segments.slice(0, -1), false)
    if (!dir) return null
    try {
      return await (await dir.getFileHandle(segments.at(-1)!)).getFile()
    } catch (err) {
      if ((err as DOMException).name === 'NotFoundError') return null
      throw err
    }
  }

  async write(path: string, parts: BlobPart[]): Promise<number> {
    const segments = pathSegments(path)
    this.snapshots.delete(path)
    const dir = (await this.dir(segments.slice(0, -1), true))!
    const handle = await dir.getFileHandle(segments.at(-1)!, { create: true })
    const stream = await handle.createWritable()
    let size = 0
    try {
      for (const part of parts) {
        await stream.write(part as FileSystemWriteChunkType)
        size += part instanceof Blob ? part.size : typeof part === 'string' ? new Blob([part]).size : part.byteLength
      }
      await stream.close()
    } catch (err) {
      await stream.abort().catch(() => {})
      throw err
    }
    return size
  }

  async read(path: string): Promise<Blob | null> {
    return this.file(path)
  }

  async readRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    let snapshot = this.snapshots.get(path)
    if (!snapshot) {
      snapshot = this.file(path)
      this.snapshots.set(path, snapshot)
    }
    const file = await snapshot
    if (!file) {
      this.snapshots.delete(path)
      throw new MissingFileError(path)
    }
    return file.slice(offset, offset + length).arrayBuffer()
  }

  async size(path: string): Promise<number | null> {
    return (await this.file(path))?.size ?? null
  }

  async remove(path: string): Promise<void> {
    const segments = pathSegments(path)
    this.snapshots.delete(path)
    const dir = await this.dir(segments.slice(0, -1), false)
    await dir?.removeEntry(segments.at(-1)!).catch((err: DOMException) => {
      if (err.name !== 'NotFoundError') throw err
    })
  }

  async removeDir(path: string): Promise<void> {
    const segments = pathSegments(path)
    for (const key of this.snapshots.keys()) if (key.startsWith(`${path}/`)) this.snapshots.delete(key)
    const parent = await this.dir(segments.slice(0, -1), false)
    await parent?.removeEntry(segments.at(-1)!, { recursive: true }).catch((err: DOMException) => {
      if (err.name !== 'NotFoundError') throw err
    })
  }
}

/** Can this browser write OPFS files from the page? Checked once per owner. */
async function opfsWorks(ownerId: string): Promise<boolean> {
  if (typeof navigator.storage?.getDirectory !== 'function') return false
  if (typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) {
    return false
  }
  try {
    const store = await OpfsFileStore.open(ownerId)
    const probe = new Uint8Array([1, 2, 3])
    await store.write('.probe', [probe])
    const back = new Uint8Array(await store.readRange('.probe', 1, 2))
    await store.remove('.probe')
    return back.length === 2 && back[0] === 2 && back[1] === 3
  } catch {
    return false
  }
}

// ---------- IndexedDB ----------

class IdbFileStore implements FileStore {
  readonly backend = 'idb' as const
  private blobs = new Map<string, Blob>()

  constructor(private ownerId: string) {}

  private db() {
    return openOwnerDb(this.ownerId)
  }

  async write(path: string, parts: BlobPart[]): Promise<number> {
    pathSegments(path)
    const blob = new Blob(parts)
    this.blobs.delete(path)
    await (await this.db()).put('files', { blob, size: blob.size }, path)
    return blob.size
  }

  async read(path: string): Promise<Blob | null> {
    pathSegments(path)
    return (await (await this.db()).get('files', path))?.blob ?? null
  }

  async readRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    let blob = this.blobs.get(path)
    if (!blob) {
      blob = (await this.read(path)) ?? undefined
      if (!blob) throw new MissingFileError(path)
      this.blobs.set(path, blob)
    }
    return blob.slice(offset, offset + length).arrayBuffer()
  }

  async size(path: string): Promise<number | null> {
    pathSegments(path)
    return (await (await this.db()).get('files', path))?.size ?? null
  }

  async remove(path: string): Promise<void> {
    pathSegments(path)
    this.blobs.delete(path)
    await (await this.db()).delete('files', path)
  }

  async removeDir(path: string): Promise<void> {
    pathSegments(path)
    const prefix = `${path}/`
    for (const key of this.blobs.keys()) if (key.startsWith(prefix)) this.blobs.delete(key)
    await (await this.db()).delete('files', IDBKeyRange.bound(prefix, `${prefix}￿`))
  }
}

// ---------- Choosing one ----------

const stores = new Map<string, Promise<FileStore>>()

/**
 * The file store for one person. The choice of backend is remembered per
 * person, so files never seem to vanish when a browser update adds OPFS
 * support (a phone moving to Safari 26 keeps reading its IndexedDB files).
 */
export function openFileStore(ownerId: string): Promise<FileStore> {
  let store = stores.get(ownerId)
  if (!store) {
    store = (async () => {
      const db = await openOwnerDb(ownerId)
      let backend = await db.get('meta', 'fileBackend')
      if (backend !== 'opfs' && backend !== 'idb') {
        backend = (await opfsWorks(ownerId)) ? 'opfs' : 'idb'
        await db.put('meta', backend, 'fileBackend')
      }
      if (backend === 'opfs') {
        try {
          return await OpfsFileStore.open(ownerId)
        } catch {
          // OPFS became unavailable (e.g. site data partly cleared). Keep working.
        }
      }
      return new IdbFileStore(ownerId)
    })()
    stores.set(ownerId, store)
  }
  return store
}
