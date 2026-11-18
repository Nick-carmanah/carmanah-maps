// A local stand-in for the R2 tile bucket, for testing on this Mac (and the
// iOS simulator, which shares its network). It serves a folder laid out like
// the bucket with what R2 sends: byte ranges (206 + Content-Range), ETag,
// If-Range, the upload headers from layout.ts, and CORS from r2-cors.json.
//
//   node scripts/packs/serve-local.ts [--root <dir>] [--port 8787] [--throttle-kbps 500]
//
// --throttle-kbps slows every response down, so a download is slow enough
// to interrupt and resume by hand.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { objectHeaders } from './layout.ts'
import { corsHeaders, loadCorsPolicy, preflightHeaders, type CorsRule } from './cors.ts'

export interface ServeOptions {
  root: string
  port?: number
  host?: string
  /** Kilobytes per second per response; 0 = full speed. */
  throttleKBps?: number
  policy?: CorsRule[]
  log?: (line: string) => void
}

/** Parse one `bytes=` range the way R2 does (single range; suffix ranges allowed). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return 'invalid'
  if (!m[1]) {
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}

function throttle(kBps: number): Transform {
  const perTick = Math.max(1, Math.round((kBps * 1024) / 10))
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      let at = 0
      const push = () => {
        if (at >= chunk.length) return done()
        this.push(chunk.subarray(at, at + perTick))
        at += perTick
        setTimeout(push, 100)
      }
      push()
    },
  })
}

function handle(opts: ServeOptions, policy: CorsRule[], req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local')
  const key = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const origin = req.headers.origin
  const method = (req.method ?? 'GET').toUpperCase()
  const log = (status: number, note = '') =>
    opts.log?.(`${new Date().toISOString().slice(11, 19)} ${status} ${method} /${key} ${req.headers.range ?? ''} ${note}`.trim())

  if (method === 'OPTIONS') {
    const asked = String(req.headers['access-control-request-headers'] ?? '').split(',')
    const cors = origin ? preflightHeaders(policy, origin, String(req.headers['access-control-request-method'] ?? ''), asked) : null
    res.writeHead(cors ? 200 : 403, cors ?? {}).end()
    return log(cors ? 200 : 403, 'preflight')
  }
  const cors = origin ? corsHeaders(policy, origin, method) : null
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, cors ?? {}).end()
    return log(405)
  }
  const headers = objectHeaders(key)
  let size: number
  let mtime: number
  try {
    if (!headers) throw new Error('not in layout')
    const st = statSync(join(opts.root, ...key.split('/')))
    if (!st.isFile()) throw new Error('not a file')
    size = st.size
    mtime = st.mtimeMs
  } catch {
    res.writeHead(404, { ...(cors ?? {}), 'Content-Type': 'text/plain' }).end('NoSuchKey')
    return log(404)
  }
  const etag = `"${size.toString(16)}-${Math.round(mtime).toString(16)}"`
  const base: Record<string, string | number> = {
    ...(cors ?? {}),
    'Content-Type': headers!.contentType,
    'Cache-Control': headers!.cacheControl,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(mtime).toUTCString(),
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, base).end()
    return log(304)
  }
  const ifRange = req.headers['if-range']
  let range = parseRange(req.headers.range, size)
  if (ifRange && ifRange !== etag) range = null
  if (range === 'invalid') {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` }).end()
    return log(416)
  }
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const status = range ? 206 : 200
  res.writeHead(status, {
    ...base,
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  })
  log(status)
  if (method === 'HEAD' || size === 0) return res.end()
  const stream = createReadStream(join(opts.root, ...key.split('/')), { start, end })
  const out = opts.throttleKBps ? stream.pipe(throttle(opts.throttleKBps)) : stream
  out.pipe(res)
  res.on('close', () => stream.destroy())
}

export function startServer(opts: ServeOptions): Promise<Server> {
  const policy = opts.policy ?? loadCorsPolicy()
  const server = createServer((req, res) => handle(opts, policy, req, res))
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(opts.port ?? 8787, opts.host ?? '127.0.0.1', () => ok(server))
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const arg = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const root = resolve(arg('--root') ?? 'samples/bucket')
  const port = Number(arg('--port') ?? 8787)
  const throttleKBps = Number(arg('--throttle-kbps') ?? 0)
  await startServer({ root, port, throttleKBps, log: (line) => console.log(line) })
  console.log(`Serving ${root} as the tile bucket on http://localhost:${port}/` + (throttleKBps ? ` (${throttleKBps} kB/s)` : ''))
}
