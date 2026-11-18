// Mac-side test server for the scale test: serves native-harness/.scratch/
// on http://localhost:8787 with Range support, the way a hosted region-pack
// file would be served. The iOS simulator shares the Mac's network, so the
// app reaches it at localhost.
//
//   npm run serve-pack
//
// Run scripts/make-scale-pack.ts first to create scale.pmtiles and
// scale-plan.json.

import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const root = join(import.meta.dirname, '..', '.scratch')
const port = 8787

createServer((req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
  if (rel.includes('..')) { res.writeHead(400).end(); return }
  const file = join(root, rel)
  let size
  try { size = statSync(file).size } catch { res.writeHead(404).end(); return }
  const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream'
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (m) {
    const start = +m[1]
    const end = m[2] ? Math.min(+m[2], size - 1) : size - 1
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
    createReadStream(file, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size })
    createReadStream(file).pipe(res)
  }
  console.log(new Date().toISOString().slice(11, 19), req.method, req.url, req.headers.range ?? '')
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://localhost:${port}`))
