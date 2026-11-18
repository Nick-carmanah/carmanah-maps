import type { FileStore } from '../storage/files'
import type { PackArea } from './area.ts'
import { packIdFor, type PackManifest } from './manifest.ts'
import { packRegistry, type PackRegistry } from './registry'
import {
  defaultDeps,
  downloadSmallArea,
  readJob,
  runJob,
  saveJob,
  type AreaRequest,
  type Deps,
  type PackJob,
  type PlannedDownload,
  type Progress,
} from './download'

/**
 * Downloads in progress, for the offline-maps sheet. A download keeps going
 * while the sheet is closed; it pauses when the app is closed or the phone
 * suspends it, and carries on from where it stopped next time (by itself if
 * it was running, or with Resume).
 */

export interface ActiveDownload {
  id: string
  name: string
  progress: Progress
  controller: AbortController
}

type Listener = () => void

export interface SmallSources {
  tileJsonUrl: string
  terrainUrl: (z: number, x: number, y: number) => string
}

export class PackDownloads {
  active = new Map<string, ActiveDownload>()
  private listeners = new Set<Listener>()
  private resumed = false

  constructor(
    private registry: PackRegistry = packRegistry,
    private deps: () => Deps = defaultDeps,
    private onDone: (m: PackManifest) => void = () => {},
    private onFail: (name: string, message: string) => void = () => {},
  ) {}

  /** Toasts from the app: set once by the UI. */
  setNotifier(onDone: (m: PackManifest) => void, onFail: (name: string, message: string) => void) {
    this.onDone = onDone
    this.onFail = onFail
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    for (const fn of this.listeners) fn()
  }

  private async store(): Promise<FileStore> {
    const store = await this.registry.store()
    if (!store) throw new Error('This browser can’t keep offline maps. Use the Carmanah app, or Chrome, Firefox or Safari 26+.')
    return store
  }

  /** A pack id not already on the phone: `c40983-20261118`, then `-2`, `-3`… */
  async freeId(label: string): Promise<string> {
    const store = await this.store()
    const base = packIdFor(label, new Date())
    const taken = new Set(await store.list(''))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  private async run(id: string, name: string, job: PackJob | null, work: (signal: AbortSignal, onProgress: (p: Progress) => void) => Promise<PackManifest>) {
    if (this.active.has(id)) return
    const controller = new AbortController()
    const entry: ActiveDownload = { id, name, controller, progress: { done: 0, total: job?.bytesTotal ?? 0, waiting: false } }
    this.active.set(id, entry)
    this.notify()
    void requestPersistence()
    try {
      const manifest = await work(controller.signal, (p) => {
        entry.progress = p
        this.notify()
      })
      this.onDone(manifest)
    } catch (err) {
      const paused = (err as Error)?.name === 'AbortError'
      const store = await this.registry.store()
      const saved = store ? await readJob(store, id) : null
      if (store && saved) {
        saved.state = paused ? 'paused' : 'failed'
        saved.wasRunning = false
        if (!paused) saved.error = (err as Error).message
        await saveJob(store, saved).catch(() => {})
      }
      if (!paused) this.onFail(name, (err as Error).message)
    } finally {
      this.active.delete(id)
      await this.registry.refresh()
      this.notify()
    }
  }

  /** Start a planned cut or ready-made pack download. */
  async start(planned: PlannedDownload): Promise<void> {
    const store = await this.store()
    await this.run(planned.job.id, planned.job.name, planned.job, (signal, onProgress) =>
      runJob(planned.job, { store, signal, onProgress, plans: planned.plans, deps: this.deps() }),
    )
  }

  /** Start a small area straight from OpenFreeMap and AWS. */
  async startSmall(req: AreaRequest, sources: SmallSources): Promise<void> {
    const store = await this.store()
    await this.run(req.id, req.name, null, (signal, onProgress) =>
      downloadSmallArea(req, { store, signal, onProgress, deps: this.deps(), ...sources }),
    )
  }

  /** Carry on with a paused, failed or interrupted download. */
  async resume(id: string, small?: SmallSources): Promise<void> {
    const store = await this.store()
    const job = await readJob(store, id)
    if (!job) return
    if (job.kind === 'small') {
      if (!small || !job.area) return
      // Small areas aren't resumable: start again from the area.
      await store.removeDir(id)
      const area: PackArea = { rings: job.area.rings, bufferM: job.area.bufferM }
      return this.startSmall({ id, name: job.name, fireNumber: job.fireNumber, area }, small)
    }
    await this.run(id, job.name, job, (signal, onProgress) => runJob(job, { store, signal, onProgress, deps: this.deps() }))
  }

  pause(id: string): void {
    this.active.get(id)?.controller.abort()
  }

  /** Delete a pack or a partial download. */
  async remove(id: string): Promise<void> {
    const running = this.active.get(id)
    if (running) {
      running.controller.abort()
      await new Promise<void>((resolve) => {
        const stop = this.subscribe(() => {
          if (!this.active.has(id)) {
            stop()
            resolve()
          }
        })
      })
    }
    await this.registry.remove(id)
  }

  /** On start: carry on with downloads the app was in the middle of when it closed. */
  async resumeInterrupted(small?: SmallSources): Promise<void> {
    if (this.resumed) return
    this.resumed = true
    await this.registry.load()
    const store = await this.registry.store()
    if (!store) return
    for (const summary of this.registry.jobs) {
      const job = await readJob(store, summary.id)
      if (job?.wasRunning && job.state !== 'failed') void this.resume(job.id, small)
    }
  }
}

/** Ask the browser not to clear website storage under pressure (no-op in the app). */
async function requestPersistence() {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist()
    }
  } catch {
    // Best-effort.
  }
}

export const packDownloads = new PackDownloads()
