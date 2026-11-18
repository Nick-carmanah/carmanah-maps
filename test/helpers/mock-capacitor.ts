/**
 * A stand-in for the crew app's native side, for Node tests: an in-memory
 * Capacitor Filesystem (8.1.x behaviour as read in ion-ios-filesystem 2.0.1
 * and the plugin's definitions), `Capacitor.convertFileSrc`, and a `fetch`
 * that plays Capacitor's iOS scheme handler (WebViewAssetHandler 8.6.0:
 * `206` + `Content-Range` for a Range request, the whole file otherwise).
 *
 * `rangeMode` makes the handler misbehave on purpose:
 *  - '206'     what iOS does (the spike measured it)
 *  - '200'     ignores Range and sends the whole file
 *  - 'from0'   206 with the asked-for Content-Range, but the whole file from
 *              byte 0 (Android if the WebView didn't skip; spike §7)
 *  - 'shifted' 206 for the right length but from byte 0, and says so in Content-Range
 *  - 'lying'   206 for the right length from byte 0, Content-Range claiming
 *              the asked-for range (only reading known bytes can catch this)
 *  - 'fail'    every request fails
 */
import { vi } from 'vitest'

export type RangeMode = '206' | '200' | 'from0' | 'shifted' | 'lying' | 'fail'

const SCHEME = 'capacitor://localhost/_capacitor_file_'
const ROOT = '/sim/Library/NoCloud'

const notFound = (method: string, path: string) =>
  Object.assign(new Error(`'${method}' failed because file at '${path}' does not exist.`), {
    code: 'OS-PLUG-FILE-0008',
  })

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

export interface FetchCall {
  url: string
  range: string | null
  status: number
}

export function mockCapacitor(opts: { rangeMode?: RangeMode; how?: 'plugins' | 'registerPlugin' | 'nativePromise' } = {}) {
  /** Files by full path, e.g. `LIBRARY_NO_CLOUD/maps/u1/a.bin`. */
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const state = { rangeMode: opts.rangeMode ?? '206' }
  const calls: { method: string; options: Record<string, unknown> }[] = []
  const fetches: FetchCall[] = []
  /** 200 responses, to check that nobody read their (whole-file) body. */
  const wholeFileResponses: Response[] = []
  const fail = new Map<string, () => Error | undefined>()

  const key = (o: { directory?: unknown; path?: unknown }) => `${String(o.directory)}/${String(o.path)}`
  const parent = (k: string) => k.slice(0, k.lastIndexOf('/'))
  const mkdirs = (dir: string) => {
    for (let d = dir; d.includes('/'); d = parent(d)) dirs.add(d)
  }
  const isDir = (k: string) => dirs.has(k) || [...files.keys()].some((f) => f.startsWith(`${k}/`))

  const record = (method: string, options: Record<string, unknown>) => {
    calls.push({ method, options })
    const err = fail.get(method)?.()
    if (err) throw err
  }

  const Filesystem = {
    async writeFile(o: Record<string, unknown>) {
      record('writeFile', o)
      const k = key(o)
      if (!isDir(parent(k)) && parent(k).includes('/')) {
        if (!o.recursive) throw new Error('Missing parent directory')
        mkdirs(parent(k))
      }
      const data = String(o.data)
      files.set(k, o.encoding === 'utf8' ? new TextEncoder().encode(data) : unb64(data))
      return { uri: `file://${ROOT}/${String(o.path)}` }
    },
    async appendFile(o: Record<string, unknown>) {
      record('appendFile', o)
      const k = key(o)
      const add = unb64(String(o.data))
      const old = files.get(k)
      if (!old) {
        // iOS creates the file (ion-ios-filesystem appendData → saveFile).
        mkdirs(parent(k))
        files.set(k, add)
        return
      }
      const out = new Uint8Array(old.length + add.length)
      out.set(old)
      out.set(add, old.length)
      files.set(k, out)
    },
    async readFile(o: Record<string, unknown>) {
      record('readFile', o)
      const bytes = files.get(key(o))
      if (!bytes) throw notFound('readFile', String(o.path))
      const offset = Number(o.offset ?? 0)
      const length = Number(o.length ?? -1)
      const end = length > 0 ? offset + length : bytes.length
      return { data: b64(bytes.subarray(offset, end)) }
    },
    async stat(o: Record<string, unknown>) {
      record('stat', o)
      const k = key(o)
      const bytes = files.get(k)
      if (bytes) return { type: 'file', size: bytes.length, uri: `file://${ROOT}/${String(o.path)}` }
      if (isDir(k)) return { type: 'directory', size: 0, uri: `file://${ROOT}/${String(o.path)}` }
      throw notFound('stat', String(o.path))
    },
    async deleteFile(o: Record<string, unknown>) {
      record('deleteFile', o)
      if (!files.delete(key(o))) throw notFound('deleteFile', String(o.path))
    },
    async rmdir(o: Record<string, unknown>) {
      record('rmdir', o)
      const k = key(o)
      if (!isDir(k)) throw notFound('rmdir', String(o.path))
      const inside = [...files.keys()].filter((f) => f.startsWith(`${k}/`))
      if (inside.length && !o.recursive) throw new Error('Cannot delete directory with children')
      for (const f of inside) files.delete(f)
      for (const d of [...dirs]) if (d === k || d.startsWith(`${k}/`)) dirs.delete(d)
    },
    async rename(o: Record<string, unknown>) {
      record('rename', o)
      const from = `${String(o.directory)}/${String(o.from)}`
      const to = `${String(o.toDirectory ?? o.directory)}/${String(o.to)}`
      const bytes = files.get(from)
      if (!bytes) throw notFound('rename', String(o.from))
      // FileManager.moveItem fails when the destination exists.
      if (files.has(to)) throw new Error(`"${String(o.to)}" couldn't be moved because an item with the same name already exists.`)
      files.delete(from)
      mkdirs(parent(to))
      files.set(to, bytes)
    },
    async getUri(o: Record<string, unknown>) {
      record('getUri', o)
      return { uri: `file://${ROOT}/${String(o.path)}` }
    },
    async readdir(o: Record<string, unknown>) {
      record('readdir', o)
      const k = key(o)
      if (!isDir(k)) throw notFound('readdir', String(o.path))
      const names = new Set<string>()
      for (const f of files.keys()) if (f.startsWith(`${k}/`)) names.add(f.slice(k.length + 1).split('/')[0])
      for (const d of dirs) if (d.startsWith(`${k}/`)) names.add(d.slice(k.length + 1).split('/')[0])
      return {
        files: [...names].map((name) => ({
          name,
          type: files.has(`${k}/${name}`) ? 'file' : 'directory',
          size: files.get(`${k}/${name}`)?.length ?? 0,
        })),
      }
    },
  }

  const fileForUrl = (url: string) => {
    if (!url.startsWith(SCHEME + ROOT + '/')) return undefined
    return files.get(`LIBRARY_NO_CLOUD/${url.slice((SCHEME + ROOT + '/').length)}`)
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const range = new Headers(init?.headers).get('Range')
    const bytes = fileForUrl(url)
    if (!bytes || state.rangeMode === 'fail') {
      fetches.push({ url, range, status: 0 })
      throw new TypeError('Load failed')
    }
    if (range && state.rangeMode !== '200') {
      // Like WebViewAssetHandler: from-to as asked, to not clamped in the header.
      const m = /^bytes=(\d+)-(\d*)$/.exec(range)!
      const from = Number(m[1])
      const to = m[2] ? Number(m[2]) : bytes.length - 1
      const mode = state.rangeMode
      const start = mode === '206' ? from : 0
      const body = mode === 'from0' ? bytes.slice() : bytes.slice(start, start + (to - from + 1))
      const said = mode === 'shifted' ? `bytes 0-${to - from}/${bytes.length}` : `bytes ${from}-${to}/${bytes.length}`
      fetches.push({ url, range, status: 206 })
      return new Response(body, {
        status: 206,
        headers: { 'Content-Range': said, 'Content-Length': String(body.length) },
      })
    }
    fetches.push({ url, range, status: 200 })
    const resp = new Response(bytes.slice(), { status: 200 })
    for (const m of ['arrayBuffer', 'blob', 'text', 'json', 'bytes'] as const) {
      ;(resp as unknown as Record<string, unknown>)[m] = vi.fn(() => {
        throw new Error('read the whole file')
      })
    }
    wholeFileResponses.push(resp)
    return resp
  })

  const capacitor: Record<string, unknown> = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    convertFileSrc: (uri: string) => (uri.startsWith('file://') ? SCHEME + uri.slice('file://'.length) : uri),
    PluginHeaders: [{ name: 'Filesystem' }, { name: 'Share' }],
  }
  const how = opts.how ?? 'plugins'
  if (how === 'plugins') capacitor.Plugins = { Filesystem }
  if (how === 'registerPlugin') {
    capacitor.Plugins = {}
    capacitor.registerPlugin = vi.fn((name: string) => (name === 'Filesystem' ? Filesystem : undefined))
  }
  if (how === 'nativePromise') {
    capacitor.nativePromise = vi.fn((plugin: string, method: string, options: unknown) =>
      plugin === 'Filesystem'
        ? (Filesystem as Record<string, (o: unknown) => Promise<unknown>>)[method](options)
        : Promise.reject(new Error('no plugin')),
    )
  }

  return {
    Filesystem,
    capacitor,
    fetch: fetchMock,
    files,
    calls,
    fetches,
    wholeFileResponses,
    state,
    /** Make the next calls of one method throw. */
    failNext(method: string, err: () => Error | undefined) {
      fail.set(method, err)
    },
    install() {
      vi.stubGlobal('Capacitor', capacitor)
      vi.stubGlobal('fetch', fetchMock)
    },
    /** A file's bytes by its path under LibraryNoCloud, e.g. `maps/u1/a.bin`. */
    file(path: string) {
      return files.get(`LIBRARY_NO_CLOUD/${path}`)
    },
    paths() {
      return [...files.keys()].map((k) => k.replace(/^LIBRARY_NO_CLOUD\//, '')).sort()
    },
  }
}

/** A Map-backed localStorage for Node tests. */
export function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
  }
}
