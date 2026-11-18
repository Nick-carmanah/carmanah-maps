/**
 * The bits of Capacitor the map page uses, reached through `window.Capacitor`
 * (rebuild plan §0: the crew app injects `/capacitor.js`; this bundle has no
 * Capacitor npm packages). Only what the storage layer and sharing
 * (src/lib/export.ts) need is typed here.
 *
 * A plugin may be reachable three ways, depending on what the host page
 * loaded: already registered (`Capacitor.Plugins.<Name>`), registrable
 * (`Capacitor.registerPlugin`, from capacitor.js), or only through the
 * native bridge (`Capacitor.nativePromise`, which every Capacitor web view
 * has). All three end in the same native calls.
 */

/** `Directory.LibraryNoCloud`: iOS Library/NoCloud (no iCloud backup, not in Files, never purged). */
export const LIBRARY_NO_CLOUD = 'LIBRARY_NO_CLOUD'

export interface FsPathOptions {
  path: string
  directory: string
}

export interface FilesystemPlugin {
  /** `data` is base64 unless `encoding` is given. */
  writeFile(o: FsPathOptions & { data: string; encoding?: 'utf8'; recursive?: boolean }): Promise<{ uri: string }>
  appendFile(o: FsPathOptions & { data: string; encoding?: 'utf8' }): Promise<void>
  /** `offset`/`length` need Filesystem ≥ 8.1.0. A `length` ≤ 0 reads to the end of the file. */
  readFile(o: FsPathOptions & { offset?: number; length?: number }): Promise<{ data: string | Blob }>
  stat(o: FsPathOptions): Promise<{ type: 'file' | 'directory'; size: number; uri: string }>
  deleteFile(o: FsPathOptions): Promise<void>
  rmdir(o: FsPathOptions & { recursive?: boolean }): Promise<void>
  rename(o: { from: string; to: string; directory: string; toDirectory?: string }): Promise<void>
  getUri(o: FsPathOptions): Promise<{ uri: string }>
  readdir(o: FsPathOptions): Promise<{ files: { name: string; type: 'file' | 'directory'; size: number }[] }>
}

export interface SharePlugin {
  /** Resolves when the share sheet closes after a share; rejects with "Share canceled" when dismissed. */
  share(o: { title?: string; text?: string; files?: string[] }): Promise<unknown>
}

export interface CapacitorGlobal {
  isNativePlatform?(): boolean
  getPlatform?(): string
  convertFileSrc(fileUri: string): string
  Plugins?: Record<string, unknown>
  registerPlugin?(name: string): unknown
  nativePromise?(plugin: string, method: string, options?: unknown): Promise<unknown>
  PluginHeaders?: { name: string }[]
}

const FS_METHODS = ['writeFile', 'appendFile', 'readFile', 'stat', 'deleteFile', 'rmdir', 'rename', 'getUri', 'readdir'] as const

/** `window.Capacitor` when this page runs inside the native app, else null. */
export function nativeCapacitor(): CapacitorGlobal | null {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor
  try {
    return cap?.isNativePlatform?.() === true && typeof cap.convertFileSrc === 'function' ? cap : null
  } catch {
    return null
  }
}

/** A plugin by name, or null if this app wasn't built with it. `methods[0]`
 * tells a registered plugin from something else under that name. */
function pluginByName<T>(cap: CapacitorGlobal, name: string, methods: readonly string[]): T | null {
  const registered = cap.Plugins?.[name] as Record<string, unknown> | undefined
  if (registered && typeof registered[methods[0]] === 'function') return registered as T
  const headers = cap.PluginHeaders
  if (headers && !headers.some((h) => h.name === name)) return null
  if (typeof cap.registerPlugin === 'function') {
    const plugin = cap.registerPlugin(name) as T | undefined
    if (plugin) return plugin
  }
  const call = cap.nativePromise
  if (typeof call === 'function' && headers) {
    return Object.fromEntries(
      methods.map((m) => [m, (options: unknown) => call.call(cap, name, m, options)]),
    ) as T
  }
  return null
}

/** The Filesystem plugin, or null if this app wasn't built with it. */
export function filesystemPlugin(cap: CapacitorGlobal): FilesystemPlugin | null {
  return pluginByName<FilesystemPlugin>(cap, 'Filesystem', FS_METHODS)
}

/** The Share plugin, or null if this app wasn't built with it. */
export function sharePlugin(cap: CapacitorGlobal): SharePlugin | null {
  return pluginByName<SharePlugin>(cap, 'Share', ['share'])
}

/** Not-found errors from the plugin (iOS/Android code OS-PLUG-FILE-0008, or the message). */
export function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  if (e?.code === 'OS-PLUG-FILE-0008') return true
  return typeof e?.message === 'string' && /does not exist|not found|no such file/i.test(e.message)
}

type B64Ctor = { fromBase64?: (s: string) => Uint8Array }
type B64Proto = { toBase64?: () => string }

/** Native base64 where WebKit has it (iOS 18.2+), else a loop (iOS 15+). */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as B64Proto).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as B64Ctor).fromBase64
  if (typeof native === 'function') return native(b64)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
