// Serve built PMTiles locally the way R2 will: HTTP Range requests (206),
// ETag, and CORS, so the app on another port can read them.
//
//   node serve.ts [folder=samples/bucket] [port=8790]
//
// Listens on 127.0.0.1 only. For testing; not a production server. Once the
// fire-packs tools land, `npm run packs:serve` serves the same folder with
// the bucket's full header rules, and this can go.

import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '../..', process.argv[2] ?? 'samples/bucket')
const port = Number(process.argv[3] ?? 8790)

const TYPES: Record<string, string> = {
  '.pmtiles': 'application/vnd.pmtiles',
  '.json': 'application/json',
}

/** Parse one "bytes=a-b" / "bytes=a-" / "bytes=-n" range; null if absent, 'bad' if unsatisfiable. */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'bad' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'bad'
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]))
  }
  return start > end || start >= size ? 'bad' : [start, end]
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-Match, If-None-Match')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, ETag, Accept-Ranges')
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  const path = resolve(root, '.' + decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403).end()
    return
  }
  let size: number
  let mtime: number
  try {
    const st = statSync(path)
    if (!st.isFile()) throw new Error('not a file')
    size = st.size
    mtime = st.mtimeMs
  } catch {
    res.writeHead(404).end()
    return
  }
  const etag = `"${size.toString(16)}-${Math.floor(mtime).toString(16)}"`
  res.setHeader('ETag', etag)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream')
  const ifMatch = req.headers['if-match']
  if (ifMatch && ifMatch !== etag) {
    res.writeHead(412).end()
    return
  }
  const range = parseRange(req.headers.range, size)
  if (range === 'bad') {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end()
    return
  }
  const [start, end] = range ?? [0, size - 1]
  res.writeHead(range ? 206 : 200, {
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(path, { start, end }).pipe(res)
  console.log(`${req.method} ${req.url} ${range ? `206 ${start}-${end}` : '200'}`)
})

if (process.argv[1] && resolve(process.argv[1]) === join(here, 'serve.ts')) {
  server.listen(port, '127.0.0.1', () => console.log(`Serving ${root} on http://127.0.0.1:${port}/`))
}
