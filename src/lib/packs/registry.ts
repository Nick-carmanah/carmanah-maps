import type { PMTiles, RangeResponse, Source } from 'pmtiles'
import { openSharedPackFiles, type FileStore } from '../storage/files'
import { latToTileY, lonToTileX } from './area.ts'
import { parseManifest, type PackFile, type PackManifest, type PackSource } from './manifest.ts'

/**
 * The offline packs on this phone: `maps/_packs/<packId>/` in the shared
 * pack store (Filesystem in the crew app, OPFS on the website). Finished
 * packs have a `pack.json`; a download still in progress has a `job.json`
 * instead (./download.ts). The map reads tiles from here first
 * (./protocol.ts).
 */

export const JOB_FILE = 'job.json'
export const MANIFEST_FILE = 'pack.json'

/** What download.ts keeps in job.json; the registry only needs to show it. */
export interface JobSummary {
  id: string
  name: string
  fireNumber?: string
  bytesTotal: number
  state: 'running' | 'paused' | 'failed'
  error?: string
}

class FileStoreSource implements Source {
  constructor(
    private files: FileStore,
    private path: string,
  ) {}

  getKey() {
    return this.path
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: await this.files.readRange(this.path, offset, length) }
  }
}

interface TileBox {
  z: number
  x0: number
  x1: number
  y0: number
  y1: number
}

type Listener = () => void

export class PackRegistry {
  packs: PackManifest[] = []
  jobs: JobSummary[] = []
  /** Bytes on disk per pack id (finished and partial). */
  sizes = new Map<string, number>()
  private files: FileStore | null = null
  private loading: Promise<void> | null = null
  private loadedOnce = false
  private readers = new Map<string, Promise<PMTiles>>()
  private boxes = new Map<string, TileBox>()
  private listeners = new Set<Listener>()
  private warned = new Set<string>()

  constructor(private open: () => Promise<FileStore | null> = openSharedPackFiles) {}

  /** True once the pack list has been read (even if it's empty). */
  get ready(): boolean {
    return this.loadedOnce
  }

  /** The pack store, or null where this browser can't keep packs. */
  async store(): Promise<FileStore | null> {
    await this.load()
    return this.files
  }

  /** Read the pack list (once; refresh() reads it again). */
  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.read().catch((err) => {
        console.warn('Offline packs unavailable:', err)
        this.files = null
      })
    }
    return this.loading
  }

  async refresh(): Promise<void> {
    this.loading = null
    this.readers.clear()
    this.boxes.clear()
    await this.load()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  notify(): void {
    for (const fn of this.listeners) fn()
  }

  private async read(): Promise<void> {
    this.files ??= await this.open()
    const packs: PackManifest[] = []
    const jobs: JobSummary[] = []
    const sizes = new Map<string, number>()
    if (this.files) {
      for (const id of await this.files.list('')) {
        if (id.startsWith('.') || id.startsWith('_')) continue
        const manifest = await this.readJson(`${id}/${MANIFEST_FILE}`)
        if (manifest) {
          try {
            const m = parseManifest(manifest)
            if (m.id === id) {
              packs.push(m)
              sizes.set(id, m.bytes)
              continue
            }
          } catch (err) {
            this.warnOnce(id, `pack ${id} skipped: ${(err as Error).message}`)
          }
        }
        const job = (await this.readJson(`${id}/${JOB_FILE}`)) as JobSummary | null
        if (job && job.id === id) {
          jobs.push({ ...job, state: job.state === 'running' ? 'paused' : job.state })
          let onDisk = 0
          for (const name of await this.files.list(id)) onDisk += (await this.files.size(`${id}/${name}`)) ?? 0
          sizes.set(id, onDisk)
        }
      }
    }
    // Newest first: where two packs overlap, the newer one's tiles are drawn.
    this.packs = packs.sort((a, b) => b.created.localeCompare(a.created))
    this.jobs = jobs
    this.sizes = sizes
    this.loadedOnce = true
    this.notify()
  }

  private async readJson(path: string): Promise<unknown> {
    try {
      const blob = await this.files!.read(path)
      return blob ? JSON.parse(await blob.text()) : null
    } catch {
      return null
    }
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.warn(message)
  }

  private box(pack: PackManifest, z: number): TileBox {
    const key = `${pack.id}/${z}`
    let b = this.boxes.get(key)
    if (!b) {
      const [w, s, e, n] = pack.bbox
      b = {
        z,
        x0: Math.floor(lonToTileX(w, z)),
        x1: Math.floor(lonToTileX(e, z) - 1e-9),
        y0: Math.floor(latToTileY(n, z)),
        y1: Math.floor(latToTileY(s, z) - 1e-9),
      }
      this.boxes.set(key, b)
    }
    return b
  }

  /** Pack files that might hold this tile (by zoom range and bounding box), newest pack first. */
  candidates(source: PackSource, z: number, x: number, y: number): { pack: PackManifest; file: PackFile }[] {
    const out: { pack: PackManifest; file: PackFile }[] = []
    for (const pack of this.packs) {
      const file = pack.files.find((f) => f.source === source && z >= f.minzoom && z <= f.maxzoom)
      if (!file) continue
      const b = this.box(pack, z)
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) out.push({ pack, file })
    }
    return out
  }

  private reader(pack: PackManifest, file: PackFile): Promise<PMTiles> {
    const key = `${pack.id}/${file.name}`
    let r = this.readers.get(key)
    if (!r) {
      const files = this.files!
      r = import('pmtiles').then(({ PMTiles }) => new PMTiles(new FileStoreSource(files, key)))
      this.readers.set(key, r)
    }
    return r
  }

  /** A tile's bytes (decompressed) from the newest pack that has it, or null. */
  async tile(source: PackSource, z: number, x: number, y: number): Promise<ArrayBuffer | null> {
    await this.load()
    for (const { pack, file } of this.candidates(source, z, x, y)) {
      try {
        const t = await (await this.reader(pack, file)).getZxy(z, x, y)
        if (t?.data && t.data.byteLength) return t.data
      } catch (err) {
        this.warnOnce(`${pack.id}/${file.name}`, `pack ${pack.id} ${file.name} unreadable: ${(err as Error).message}`)
      }
    }
    return null
  }

  /** Forget a pack's readers (before deleting or replacing it). */
  forget(id: string): void {
    for (const key of [...this.readers.keys()]) if (key.startsWith(`${id}/`)) this.readers.delete(key)
    for (const key of [...this.boxes.keys()]) if (key.startsWith(`${id}/`)) this.boxes.delete(key)
  }

  /** Delete a pack (or a partial download) from the phone. */
  async remove(id: string): Promise<void> {
    const files = await this.store()
    if (!files) return
    this.forget(id)
    await files.removeDir(id)
    await this.refresh()
  }
}

/** The phone's packs. One per page: packs are shared, not per person. */
export const packRegistry = new PackRegistry()
