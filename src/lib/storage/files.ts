import { openOwnerDb } from './owner-db'
import { isOwnerId } from './owner'
import {
  base64ToBytes,
  bytesToBase64,
  filesystemPlugin,
  isNotFound,
  LIBRARY_NO_CLOUD,
  nativeCapacitor,
  type CapacitorGlobal,
  type FilesystemPlugin,
} from './capacitor'

/**
 * Where the map page keeps file bytes: original PDFs, rendered maps, and
 * later tile packs and photos. One interface, several homes, chosen per
 * person (openFileStore below):
 *
 *  - `native`: in the crew app, Capacitor Filesystem in
 *    `Directory.LibraryNoCloud` (iOS Library/NoCloud: not backed up, not in
 *    the Files app, never purged), under `maps/<ownerId>/`. Reached through
 *    `window.Capacitor` (./capacitor.ts). Reads ranges with
 *    `fetch(convertFileSrc(uri))` and a Range header, checking for `206`,
 *    else `Filesystem.readFile({ offset, length })`
 *    (docs/native-storage-spike.md §5).
 *  - `opfs`: the browser's Origin Private File System, under `maps/<ownerId>/`.
 *    Real files: written in a stream, read back by byte range without
 *    loading the whole file. Used where the browser can write OPFS files
 *    from the page (Chrome/Android, Firefox, Safari 26+).
 *  - `idb`: IndexedDB Blobs in `carmanah-maps.<ownerId>`, for browsers
 *    without that (Safari before 26).
 *
 * Paths are relative to the owner's folder and use `/` between parts, e.g.
 * `library/originals/<id>.pdf`. Website storage is best-effort: the browser
 * may clear it under storage pressure, so the UI says so. `maps/_packs/`
 * holds the shared basemap packs: no owner id can start with `_`, so no
 * owner's folder is ever that one.
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
  /** Add bytes to the end of a file, creating it if needed. Returns the new size. */
  append(path: string, bytes: Uint8Array): Promise<number>
  /** Rename a file within the store, replacing any file at `to`. */
  rename(from: string, to: string): Promise<void>
  /** Names in a folder ('' = the store's own folder), files and folders alike; [] if there's no such folder. */
  list(dir: string): Promise<string[]>
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

/** The folder every app file lives under: `maps/<ownerId>/` per person, `maps/_packs/` shared. */
export const FILES_ROOT = 'maps'
export const SHARED_PACKS_DIR = '_packs'

export class MissingFileError extends Error {
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
    const maps = await top.getDirectoryHandle(FILES_ROOT, { create: true })
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

  async append(path: string, bytes: Uint8Array): Promise<number> {
    const segments = pathSegments(path)
    this.snapshots.delete(path)
    const dir = (await this.dir(segments.slice(0, -1), true))!
    const handle = await dir.getFileHandle(segments.at(-1)!, { create: true })
    const size = (await handle.getFile()).size
    // keepExistingData copies the file first in some browsers; callers append
    // in megabyte-sized pieces, so that stays cheap for pack-sized files.
    const stream = await handle.createWritable({ keepExistingData: true })
    try {
      await stream.seek(size)
      await stream.write(bytes as FileSystemWriteChunkType)
      await stream.close()
    } catch (err) {
      await stream.abort().catch(() => {})
      throw err
    }
    return size + bytes.length
  }

  async rename(from: string, to: string): Promise<void> {
    const src = pathSegments(from)
    const dest = pathSegments(to)
    this.snapshots.delete(from)
    this.snapshots.delete(to)
    const fromDir = await this.dir(src.slice(0, -1), false)
    if (!fromDir) throw new MissingFileError(from)
    const handle = await fromDir.getFileHandle(src.at(-1)!).catch(() => null)
    if (!handle) throw new MissingFileError(from)
    const toDir = (await this.dir(dest.slice(0, -1), true))!
    await toDir.removeEntry(dest.at(-1)!).catch(() => {})
    const move = (handle as unknown as { move?: (dir: FileSystemDirectoryHandle, name: string) => Promise<void> }).move
    if (typeof move === 'function') {
      await move.call(handle, toDir, dest.at(-1)!)
      return
    }
    await this.write(to, [await handle.getFile()])
    await this.remove(from)
  }

  async list(dir: string): Promise<string[]> {
    const handle = dir ? await this.dir(pathSegments(dir), false) : this.root
    if (!handle) return []
    const names: string[] = []
    for await (const name of (handle as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name)
    return names.sort()
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

  async append(path: string, bytes: Uint8Array): Promise<number> {
    const old = await this.read(path)
    return this.write(path, old ? [old, bytes as BlobPart] : [bytes as BlobPart])
  }

  async rename(from: string, to: string): Promise<void> {
    const blob = await this.read(from)
    if (!blob) throw new MissingFileError(from)
    await this.write(to, [blob])
    await this.remove(from)
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir ? `${pathSegments(dir).join('/')}/` : ''
    const keys = (await (await this.db()).getAllKeys('files', prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined)) as string[]
    return [...new Set(keys.map((k) => k.slice(prefix.length).split('/')[0]))].sort()
  }
}


// ---------- Native (Capacitor Filesystem) ----------

/** Bytes per writeFile/appendFile call (base64 over the bridge; the spike used 4 MB). */
const WRITE_CHUNK = 4 * 1024 * 1024
/**
 * Bytes per range request when reading a whole file. Capacitor's iOS scheme
 * handler reads on the main thread, so keep each request small.
 */
const READ_CHUNK = 1024 * 1024

/** Cut parts into chunks of at most `size` bytes, in order, reading Blobs a slice at a time. */
async function* chunksOf(parts: BlobPart[], size: number): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  const flush = () => {
    const out = new Uint8Array(pendingBytes)
    let at = 0
    for (const p of pending) {
      out.set(p, at)
      at += p.length
    }
    pending = []
    pendingBytes = 0
    return out
  }
  async function* add(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
    let rest = bytes
    while (rest.length) {
      const take = Math.min(rest.length, size - pendingBytes)
      pending.push(rest.subarray(0, take))
      pendingBytes += take
      rest = rest.subarray(take)
      if (pendingBytes === size) yield flush()
    }
  }
  for (const part of parts) {
    if (part instanceof Blob) {
      for (let at = 0; at < part.size; at += size) {
        yield* add(new Uint8Array(await part.slice(at, at + size).arrayBuffer()))
      }
    } else if (typeof part === 'string') {
      yield* add(new TextEncoder().encode(part))
    } else if (part instanceof ArrayBuffer) {
      yield* add(new Uint8Array(part))
    } else {
      yield* add(new Uint8Array(part.buffer, part.byteOffset, part.byteLength))
    }
  }
  if (pendingBytes) yield flush()
}

/**
 * Does a range response hold exactly the bytes asked for? Capacitor's iOS
 * handler answers `206` with `Content-Range: bytes a-b/total`, where `b` may
 * overstate past the end of the file (the bytes are right). Checking the
 * start and the length also catches a server that answers 206 but sends the
 * file from byte 0 (unverified on Android, spike §7).
 */
export function rangeIsExact(contentRange: string | null, offset: number, length: number, got: number): boolean {
  if (got > length) return false
  const m = contentRange ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange.trim()) : null
  if (!m) return contentRange === null && got === length
  if (Number(m[1]) !== offset) return false
  if (m[3] === '*') return got === length
  return got === Math.max(0, Math.min(length, Number(m[3]) - offset))
}

class NativeFileStore implements FileStore {
  readonly backend = 'native' as const
  /** False once the scheme handler is seen to ignore or botch Range: then read by offset. */
  rangeReads = true
  private urls = new Map<string, Promise<string>>()
  private sizes = new Map<string, number>()

  constructor(
    private fs: FilesystemPlugin,
    private cap: CapacitorGlobal,
    /** `maps/<ownerId>` */
    readonly root: string,
  ) {}

  static async open(cap: CapacitorGlobal, fs: FilesystemPlugin, folder: string): Promise<NativeFileStore> {
    const store = new NativeFileStore(fs, cap, `${FILES_ROOT}/${folder}`)
    await store.checkRangeReads()
    return store
  }

  private full(path: string): string {
    return `${this.root}/${pathSegments(path).join('/')}`
  }

  private opts(full: string) {
    return { path: full, directory: LIBRARY_NO_CLOUD }
  }

  private forget(path: string) {
    this.urls.delete(path)
    this.sizes.delete(path)
  }

  /**
   * Find out once, on a tiny file, whether range requests come back right, so
   * a platform that ignored Range never gets to load a whole pack.
   */
  private async checkRangeReads(): Promise<void> {
    const probe = '.probe-range'
    await this.fs.writeFile({ ...this.opts(this.full(probe)), data: bytesToBase64(new Uint8Array([10, 11, 12, 13, 14, 15])), recursive: true })
    try {
      const got = await this.rangeFetch(probe, 2, 3)
      this.rangeReads = !!got && new Uint8Array(got).join() === '12,13,14'
    } catch {
      this.rangeReads = false
    } finally {
      this.forget(probe)
      await this.fs.deleteFile(this.opts(this.full(probe))).catch(() => {})
    }
  }

  async write(path: string, parts: BlobPart[]): Promise<number> {
    const target = this.full(path)
    // Written beside the old file, then swapped in: a crash or a full disk
    // mid-write leaves the previous file (or none), never half of one.
    // `.writing`, not `.part`: `.part` is a resumable pack download's
    // partial file (src/lib/packs/download.ts), which this must never touch.
    const temp = `${target}.writing`
    this.forget(path)
    let size = 0
    try {
      for await (const chunk of chunksOf(parts, WRITE_CHUNK)) {
        const data = bytesToBase64(chunk)
        if (size === 0) await this.fs.writeFile({ ...this.opts(temp), data, recursive: true })
        else await this.fs.appendFile({ ...this.opts(temp), data })
        size += chunk.length
      }
      if (size === 0) await this.fs.writeFile({ ...this.opts(temp), data: '', encoding: 'utf8', recursive: true })
      const written = await this.fs.stat(this.opts(temp))
      if (written.size !== size) throw new Error(`wrote ${written.size} of ${size} bytes`)
      await this.fs.deleteFile(this.opts(target)).catch((err) => {
        if (!isNotFound(err)) throw err
      })
      await this.fs.rename({ from: temp, to: target, directory: LIBRARY_NO_CLOUD })
    } catch (err) {
      await this.fs.deleteFile(this.opts(temp)).catch(() => {})
      throw err
    }
    this.sizes.set(path, size)
    return size
  }

  /** The whole file, read by range a megabyte at a time (never one unranged fetch). */
  async read(path: string): Promise<Blob | null> {
    const size = await this.size(path)
    if (size === null) return null
    const chunks: ArrayBuffer[] = []
    for (let at = 0; at < size; at += READ_CHUNK) {
      chunks.push(await this.readRange(path, at, Math.min(READ_CHUNK, size - at)))
    }
    return new Blob(chunks)
  }

  async readRange(path: string, offset: number, length: number): Promise<ArrayBuffer> {
    const full = this.full(path)
    if (length <= 0) return new ArrayBuffer(0)
    if (this.rangeReads) {
      const got = await this.rangeFetch(path, offset, length)
      if (got) return got
    }
    return this.offsetRead(path, full, offset, length)
  }

  private url(path: string): Promise<string> {
    let url = this.urls.get(path)
    if (!url) {
      url = this.fs.getUri(this.opts(this.full(path))).then(({ uri }) => this.cap.convertFileSrc(uri))
      this.urls.set(path, url)
      url.catch(() => this.urls.delete(path))
    }
    return url
  }

  /** The bytes through Capacitor's scheme handler, or null to use the fallback. */
  private async rangeFetch(path: string, offset: number, length: number): Promise<ArrayBuffer | null> {
    let resp: Response
    try {
      resp = await fetch(await this.url(path), {
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        cache: 'no-store',
      })
    } catch {
      // iOS fails the request when the file isn't there.
      if ((await this.size(path)) === null) throw new MissingFileError(path)
      return null
    }
    if (resp.status === 206) {
      // A body bigger than asked for (a whole file from byte 0) isn't read at all.
      if (Number(resp.headers.get('Content-Length') ?? 0) > length) {
        void resp.body?.cancel().catch(() => {})
        this.stopRangeReads(`a range response was ${resp.headers.get('Content-Length')} bytes for ${length}`)
        return null
      }
      const data = await resp.arrayBuffer()
      if (rangeIsExact(resp.headers.get('Content-Range'), offset, length, data.byteLength)) return data
      this.stopRangeReads(`a range response had the wrong bytes (${resp.headers.get('Content-Range')})`)
      return null
    }
    // Anything else: don't read the body (a 200 is the whole file).
    void resp.body?.cancel().catch(() => {})
    if (resp.status === 404 && (await this.size(path)) === null) throw new MissingFileError(path)
    if (resp.status === 200) this.stopRangeReads('the scheme handler ignored Range')
    return null
  }

  private stopRangeReads(why: string) {
    if (!this.rangeReads) return
    this.rangeReads = false
    console.warn(`File reads switch to Filesystem.readFile: ${why}`)
  }

  private async offsetRead(path: string, full: string, offset: number, length: number): Promise<ArrayBuffer> {
    const size = await this.size(path)
    if (size === null) throw new MissingFileError(path)
    const len = Math.min(length, size - offset)
    // Never ask for length 0: the plugin reads to the end of the file then.
    if (len <= 0) return new ArrayBuffer(0)
    const { data } = await this.fs.readFile({ ...this.opts(full), offset, length: len })
    let bytes = typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer())
    // Filesystem before 8.1 ignores offset/length and returns the whole file.
    if (bytes.length > len) bytes = bytes.slice(offset, offset + len)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  async size(path: string): Promise<number | null> {
    const known = this.sizes.get(path)
    if (known !== undefined) return known
    try {
      const st = await this.fs.stat(this.opts(this.full(path)))
      if (st.type === 'directory') return null
      this.sizes.set(path, st.size)
      return st.size
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  async remove(path: string): Promise<void> {
    const full = this.full(path)
    this.forget(path)
    await this.fs.deleteFile(this.opts(full)).catch((err) => {
      if (!isNotFound(err)) throw err
    })
  }

  async removeDir(path: string): Promise<void> {
    const full = this.full(path)
    for (const key of [...this.urls.keys(), ...this.sizes.keys()]) if (key.startsWith(`${path}/`)) this.forget(key)
    await this.fs.rmdir({ ...this.opts(full), recursive: true }).catch((err) => {
      if (!isNotFound(err)) throw err
    })
  }

  async append(path: string, bytes: Uint8Array): Promise<number> {
    const full = this.full(path)
    const before = await this.size(path)
    this.forget(path)
    if (before === null) {
      await this.fs.writeFile({ ...this.opts(full), data: bytesToBase64(bytes), recursive: true })
    } else {
      for (let at = 0; at < bytes.length; at += WRITE_CHUNK) {
        await this.fs.appendFile({ ...this.opts(full), data: bytesToBase64(bytes.subarray(at, at + WRITE_CHUNK)) })
      }
    }
    const size = (before ?? 0) + bytes.length
    this.sizes.set(path, size)
    return size
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.full(from)
    const dest = this.full(to)
    this.forget(from)
    this.forget(to)
    await this.fs.deleteFile(this.opts(dest)).catch((err) => {
      if (!isNotFound(err)) throw err
    })
    await this.fs.rename({ from: src, to: dest, directory: LIBRARY_NO_CLOUD })
  }

  async list(dir: string): Promise<string[]> {
    const full = dir ? this.full(dir) : this.root
    try {
      const { files } = await this.fs.readdir(this.opts(full))
      return files.map((f) => f.name).sort()
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
  }
}

// ---------- Choosing one ----------

const stores = new Map<string, Promise<FileStore>>()

/**
 * The file store for one person. In the crew app that's always the native
 * one. On the web the choice is remembered per person, so files never seem
 * to vanish when a browser update adds OPFS support (a phone moving to
 * Safari 26 keeps reading its IndexedDB files).
 */
export function openFileStore(ownerId: string): Promise<FileStore> {
  if (!isOwnerId(ownerId)) return Promise.reject(new Error(`bad owner id: ${ownerId}`))
  let store = stores.get(ownerId)
  if (!store) {
    store = (async () => {
      const db = await openOwnerDb(ownerId)
      const remembered = await db.get('meta', 'fileBackend')
      const cap = nativeCapacitor()
      const fs = cap && filesystemPlugin(cap)
      if (cap && fs && (remembered === undefined || remembered === 'native')) {
        if (remembered === undefined) await db.put('meta', 'native', 'fileBackend')
        return NativeFileStore.open(cap, fs, ownerId)
      }
      let backend = remembered
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
    store.catch(() => stores.delete(ownerId))
  }
  return store
}

let sharedPacks: Promise<FileStore | null> | undefined

/**
 * The shared pack store, `maps/_packs/`: offline basemap packs, which belong
 * to nobody (rebuild plan §0). Native Filesystem in the crew app, OPFS on
 * the website; null where neither works (Safari before 26 on the website),
 * because a pack is tens of megabytes written a piece at a time, which the
 * IndexedDB fallback can't do well.
 */
export function openSharedPackFiles(): Promise<FileStore | null> {
  if (!sharedPacks) {
    sharedPacks = (async () => {
      const cap = nativeCapacitor()
      const fs = cap && filesystemPlugin(cap)
      if (cap && fs) return NativeFileStore.open(cap, fs, SHARED_PACKS_DIR)
      if (await opfsWorks(SHARED_PACKS_DIR)) return OpfsFileStore.open(SHARED_PACKS_DIR)
      return null
    })()
    sharedPacks.catch(() => (sharedPacks = undefined))
  }
  return sharedPacks
}

/**
 * Delete one person's file folder, `maps/<ownerId>/`, wherever this page can
 * see one: the native app's and the website's (OPFS). Their IndexedDB files
 * go with their database. `maps/_packs/` and other people's folders stay.
 */
export async function removeOwnerFiles(ownerId: string): Promise<void> {
  if (!isOwnerId(ownerId)) throw new Error(`bad owner id: ${ownerId}`)
  stores.delete(ownerId)
  const dir = `${FILES_ROOT}/${ownerId}`
  const cap = nativeCapacitor()
  const fs = cap && filesystemPlugin(cap)
  if (fs) {
    await fs.rmdir({ path: dir, directory: LIBRARY_NO_CLOUD, recursive: true }).catch((err) => {
      if (!isNotFound(err)) throw err
    })
  }
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
    let maps: FileSystemDirectoryHandle | null = null
    try {
      maps = await (await navigator.storage.getDirectory()).getDirectoryHandle(FILES_ROOT)
    } catch {
      // No OPFS here, or no maps folder in it.
    }
    await maps?.removeEntry(ownerId, { recursive: true }).catch((err: DOMException) => {
      if (err.name !== 'NotFoundError') throw err
    })
  }
}
