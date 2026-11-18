// Byte sources for the pack builder: a remote PMTiles file read by HTTP
// Range requests (OpenFreeMap's planet, or our own bucket), or a local file.

import { open } from 'node:fs/promises'
import type { ReadRange } from '../../src/lib/packs/archive.ts'

export interface ByteSource {
  read: ReadRange
  size: number
  /** ETag (remote) or size+mtime (local): a different value means a different file. */
  version: string
  url: string
}

export const USER_AGENT = 'CarmanahMaps-PackBuilder/1 (+https://github.com/Nick-carmanah/carmanah-maps)'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A remote file read by Range. Every answer must be a 206 with exactly the
 * bytes asked for and the same ETag as the first one, so a file replaced
 * mid-build can't mix two versions. Retries with backoff on network errors
 * and 5xx answers.
 */
export async function httpSource(url: string, opts: { retries?: number; log?: (s: string) => void } = {}): Promise<ByteSource> {
  const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } })
  if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`)
  const size = Number(head.headers.get('content-length'))
  const etag = head.headers.get('etag') ?? ''
  if (!size) throw new Error(`${url}: no Content-Length`)
  const retries = opts.retries ?? 6
  const read: ReadRange = async (offset, length) => {
    const end = Math.min(offset + length, size) - 1
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { Range: `bytes=${offset}-${end}`, 'User-Agent': USER_AGENT, ...(etag ? { 'If-Range': etag } : {}) },
        })
        if (res.status !== 206) {
          await res.body?.cancel()
          if (res.status === 200) throw Object.assign(new Error(`${url} changed while building (no longer ${etag})`), { fatal: true })
          throw new Error(`HTTP ${res.status}`)
        }
        const got = res.headers.get('etag')
        if (etag && got && got !== etag) throw Object.assign(new Error(`${url} changed while building`), { fatal: true })
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (bytes.length !== end - offset + 1) throw new Error(`short read ${bytes.length}/${end - offset + 1}`)
        return bytes
      } catch (err) {
        if ((err as { fatal?: boolean }).fatal || attempt >= retries) throw err
        opts.log?.(`  retry ${attempt + 1} for bytes ${offset}-${end}: ${(err as Error).message}`)
        await sleep(Math.min(30_000, 1000 * 2 ** attempt))
      }
    }
  }
  return { read, size, version: etag, url }
}

export async function fileSource(path: string): Promise<ByteSource> {
  const fh = await open(path, 'r')
  const st = await fh.stat()
  const read: ReadRange = async (offset, length) => {
    const len = Math.max(0, Math.min(length, st.size - offset))
    const buf = Buffer.alloc(len)
    let at = 0
    while (at < len) {
      const { bytesRead } = await fh.read(buf, at, len - at, offset + at)
      if (!bytesRead) break
      at += bytesRead
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, at)
  }
  return { read, size: st.size, version: `${st.size}-${Math.round(st.mtimeMs)}`, url: path }
}

export const isUrl = (s: string) => /^https?:\/\//.test(s)

export function openSource(pathOrUrl: string, log?: (s: string) => void): Promise<ByteSource> {
  return isUrl(pathOrUrl) ? httpSource(pathOrUrl, { log }) : fileSource(pathOrUrl)
}

// ---------- OpenFreeMap planet builds ----------

export const OFM_FILES = 'https://btrfs.openfreemap.com/files.txt'
export const ofmPlanetUrl = (build: string) => `https://btrfs.openfreemap.com/areas/planet/${build}/tiles.pmtiles`

/** The newest finished planet build (a folder with both `done` and `tiles.pmtiles`). */
export async function latestPlanetBuild(): Promise<string> {
  const res = await fetch(OFM_FILES, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`${OFM_FILES}: HTTP ${res.status}`)
  const lines = (await res.text()).split('\n')
  const has = (build: string, file: string) => lines.includes(`areas/planet/${build}/${file}`)
  const builds = [...new Set(lines.map((l) => /^areas\/planet\/([^/]+)\//.exec(l)?.[1]).filter(Boolean) as string[])]
  const ready = builds.filter((b) => has(b, 'done') && has(b, 'tiles.pmtiles')).sort()
  if (!ready.length) throw new Error('no finished OpenFreeMap planet build listed')
  return ready[ready.length - 1]
}
