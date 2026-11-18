// Thin helpers over @capacitor/filesystem for binary data.
//
// Everything lives under Directory.LibraryNoCloud: on iOS that is
// Library/NoCloud inside the app container (not backed up to iCloud, not shown
// in the Files app, never purged by the OS). Packs are re-downloadable, which
// is exactly what Apple's storage guidelines say must stay out of backups.

import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'

export const DIR = Directory.LibraryNoCloud
export const PACKS = 'maps/_packs'
export const HARNESS = 'maps/_harness'

type B64Ctor = { fromBase64?: (s: string) => Uint8Array }
type B64Proto = { toBase64?: () => string }

export function b64ToBytes(b64: string): Uint8Array {
  const native = (Uint8Array as unknown as B64Ctor).fromBase64
  if (native) return native(b64)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64(bytes: Uint8Array): string {
  const native = (bytes as unknown as B64Proto).toBase64
  if (native) return native.call(bytes)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export const hasNativeBase64 = typeof (Uint8Array as unknown as B64Ctor).fromBase64 === 'function'

export async function readBytes(path: string, offset?: number, length?: number): Promise<Uint8Array> {
  const r = await Filesystem.readFile({ path, directory: DIR, offset, length })
  if (typeof r.data !== 'string') return new Uint8Array(await r.data.arrayBuffer())
  return b64ToBytes(r.data)
}

export async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await Filesystem.writeFile({ path, directory: DIR, data: bytesToB64(bytes), recursive: true })
}

export async function appendBytes(path: string, bytes: Uint8Array): Promise<void> {
  await Filesystem.appendFile({ path, directory: DIR, data: bytesToB64(bytes) })
}

export async function readText(path: string): Promise<string> {
  const r = await Filesystem.readFile({ path, directory: DIR, encoding: Encoding.UTF8 })
  return typeof r.data === 'string' ? r.data : await r.data.text()
}

export async function writeText(path: string, text: string): Promise<void> {
  await Filesystem.writeFile({ path, directory: DIR, data: text, encoding: Encoding.UTF8, recursive: true })
}

export async function exists(path: string): Promise<boolean> {
  try { await Filesystem.stat({ path, directory: DIR }); return true } catch { return false }
}

export async function remove(path: string): Promise<void> {
  try {
    const st = await Filesystem.stat({ path, directory: DIR })
    if (st.type === 'directory') await Filesystem.rmdir({ path, directory: DIR, recursive: true })
    else await Filesystem.deleteFile({ path, directory: DIR })
  } catch { /* not there */ }
}

const uriCache = new Map<string, string>()
/** capacitor://localhost/_capacitor_file_/… URL for a file, served by Capacitor's scheme handler. */
export async function webUrl(path: string): Promise<string> {
  const hit = uriCache.get(path)
  if (hit) return hit
  const { uri } = await Filesystem.getUri({ path, directory: DIR })
  const url = Capacitor.convertFileSrc(uri)
  uriCache.set(path, url)
  return url
}

export async function listPacks(): Promise<string[]> {
  try {
    const r = await Filesystem.readdir({ path: PACKS, directory: DIR })
    return r.files.filter((f) => f.type === 'directory').map((f) => f.name).sort()
  } catch { return [] }
}

// ---- measurement helpers ----

export const now = () => performance.now()

export function summarize(ms: number[]) {
  if (!ms.length) return { n: 0 }
  const s = [...ms].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  const sum = s.reduce((a, b) => a + b, 0)
  const r = (v: number) => Math.round(v * 100) / 100
  return { n: s.length, mean: r(sum / s.length), p50: r(q(0.5)), p90: r(q(0.9)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s[s.length - 1]), totalMs: r(sum) }
}

/** Run tasks with at most `limit` in flight. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

export function shuffle<T>(arr: T[], seed = 42): T[] {
  const a = [...arr]
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function fmtBytes(n: number): string {
  if (n > 1e9) return (n / 1e9).toFixed(2) + ' GB'
  if (n > 1e6) return (n / 1e6).toFixed(1) + ' MB'
  if (n > 1e3) return (n / 1e3).toFixed(1) + ' kB'
  return n + ' B'
}

// ---- results + host-driven commands ----
//
// The Mac drives benchmark runs by writing maps/_harness/command.json into the
// simulator's app container and relaunching; the app runs it and writes
// maps/_harness/results/<name>.json, which the Mac reads back. Buttons in the
// UI run the same functions.

// page "maps" opens the embedded maps build (npm run sync:maps puts it at
// maps/, with Capacitor's core script at /capacitor.js as the crew app does).
// That page doesn't read commands, so it's marked done before going there.
// args.mapsContext stands in for the crew app's hand-off: an object is
// written to carmanah.mapsContext.v1 (same origin as the maps page), null
// removes it. args.localStorage sets other keys (same origin too).
export interface Command { page: 'index' | 'tools' | 'storage' | 'maps'; action: string; args?: Record<string, unknown> }

export async function takeCommand(page: Command['page']): Promise<Command | null> {
  const p = `${HARNESS}/command.json`
  if (!(await exists(p))) return null
  let cmd: Command
  try { cmd = JSON.parse(await readText(p)) } catch { await remove(p); return null }
  if (cmd.page === 'maps') {
    await remove(p)
    const handOff = cmd.args?.mapsContext
    if (handOff === null) localStorage.removeItem('carmanah.mapsContext.v1')
    else if (handOff !== undefined) localStorage.setItem('carmanah.mapsContext.v1', JSON.stringify(handOff))
    // args.localStorage: other keys to set first, e.g. {"carmanah-live-enabled":"1"} for live fires.
    for (const [k, v] of Object.entries((cmd.args?.localStorage ?? {}) as Record<string, string>)) localStorage.setItem(k, v)
    await saveResult('done', { opened: 'maps' })
    // args.offline: the CSP-locked copy (maps/offline.html) that can't reach any http(s) host.
    location.href = cmd.args?.offline ? './maps/offline.html' : './maps/index.html'
    return null
  }
  if (cmd.page !== page) {
    location.href = `./${cmd.page}.html`
    return null
  }
  await remove(p)
  return cmd
}

export async function saveResult(name: string, data: unknown): Promise<void> {
  const body = JSON.stringify({ name, at: new Date().toISOString(), userAgent: navigator.userAgent, data }, null, 2)
  await writeText(`${HARNESS}/results/${name}.json`, body)
  console.log(`[harness] result ${name}`, body.length > 4000 ? body.slice(0, 4000) + '…' : body)
}
