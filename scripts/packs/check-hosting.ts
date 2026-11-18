// Check that the tile bucket answers the way the app needs, from outside,
// with no credentials: the catalog, byte ranges, ETags, cache headers, and
// CORS for every origin the map page runs on.
//
//   node scripts/packs/check-hosting.ts https://tiles.example.com/ [--key basemap/bc/<build>.pmtiles]
//
// Exit code 0 when everything passes.

import { pathToFileURL } from 'node:url'
import { loadCorsPolicy } from './cors.ts'
import { objectHeaders } from './layout.ts'

export interface CheckResult {
  ok: boolean
  lines: string[]
}

/** The origins the map page runs on (dev servers aren't checked). */
export function appOrigins(): string[] {
  return loadCorsPolicy()
    .flatMap((r) => r.AllowedOrigins)
    .filter((o) => o !== '*' && !/^http:\/\/localhost/.test(o))
}

interface CatalogLike {
  sources?: Record<string, { url?: string }[] | undefined>
  packs?: { url?: string }[]
}

export async function checkHosting(
  baseUrl: string,
  opts: { key?: string; origins?: string[]; fetch?: typeof fetch } = {},
): Promise<CheckResult> {
  const get = opts.fetch ?? fetch
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const lines: string[] = []
  let ok = true
  const pass = (msg: string) => lines.push(`  ok    ${msg}`)
  const fail = (msg: string) => {
    ok = false
    lines.push(`  FAIL  ${msg}`)
  }
  const note = (msg: string) => lines.push(`  note  ${msg}`)

  // 1. The catalog.
  let key = opts.key
  const cat = await get(`${base}catalog.json`).catch((err: Error) => err)
  if (cat instanceof Error) {
    fail(`catalog.json: can't reach ${base} (${cat.message})`)
    return { ok, lines }
  }
  if (cat.status === 404) {
    note('catalog.json: not uploaded yet (the app needs it before it can download fire packs)')
  } else if (!cat.ok) {
    fail(`catalog.json: HTTP ${cat.status}`)
  } else {
    try {
      const catalog = (await cat.json()) as CatalogLike
      pass('catalog.json: readable JSON')
      const cc = cat.headers.get('cache-control') ?? ''
      if (/max-age=\d+/.test(cc) && !/immutable/.test(cc)) pass(`catalog.json: Cache-Control "${cc}"`)
      else fail(`catalog.json: Cache-Control should be short and not immutable, got "${cc}"`)
      key ??= Object.values(catalog.sources ?? {}).flat().find((s) => s?.url)?.url
      key ??= catalog.packs?.find((p) => p.url)?.url?.replace(/pack\.json$/, 'basemap.pmtiles')
    } catch {
      fail('catalog.json: not valid JSON')
    }
  }
  if (!key) {
    note('no .pmtiles file to test ranges on yet (pass --key <path>)')
    return { ok, lines }
  }
  const fileUrl = new URL(key, base).href

  // 2. Ranges, ETag and cache headers, with no Origin (like the Mac builder).
  const head = await get(fileUrl, { method: 'HEAD' }).catch((err: Error) => err)
  if (head instanceof Error || !head.ok) {
    fail(`${key}: HEAD ${head instanceof Error ? head.message : `HTTP ${head.status}`}`)
    return { ok, lines }
  }
  const size = Number(head.headers.get('content-length'))
  pass(`${key}: ${(size / 1e6).toFixed(1)} MB`)
  const etag = head.headers.get('etag')
  if (etag) pass(`${key}: ETag ${etag}`)
  else fail(`${key}: no ETag (the app needs it to resume safely)`)
  const cc = head.headers.get('cache-control') ?? ''
  const expected = objectHeaders(key)?.cacheControl
  if (!expected) note(`${key}: not a key in the bucket layout (docs/hosting-r2.md §2)`)
  else if (cc === expected) pass(`${key}: Cache-Control "${cc}"`)
  else fail(`${key}: Cache-Control should be "${expected}", got "${cc}"`)
  const isPmtiles = key.endsWith('.pmtiles')
  const last = Math.min(127, size) - 1

  // 3. CORS from every origin the map page runs on.
  for (const origin of opts.origins ?? appOrigins()) {
    const pre = await get(fileUrl, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
    }).catch((err: Error) => err)
    if (pre instanceof Error || !pre.ok) {
      fail(`${origin}: preflight ${pre instanceof Error ? pre.message : `HTTP ${pre.status}`}`)
      continue
    }
    if (pre.headers.get('access-control-allow-origin') !== origin && pre.headers.get('access-control-allow-origin') !== '*') {
      fail(`${origin}: preflight doesn't allow this origin`)
      continue
    }
    if (!/\brange\b/i.test(pre.headers.get('access-control-allow-headers') ?? '')) {
      fail(`${origin}: preflight doesn't allow the Range header`)
      continue
    }
    const res = await get(fileUrl, { headers: { Origin: origin, Range: `bytes=0-${last}` } }).catch((err: Error) => err)
    if (res instanceof Error) {
      fail(`${origin}: range GET ${res.message}`)
      continue
    }
    const body = new Uint8Array(await res.arrayBuffer())
    const problems: string[] = []
    if (res.status !== 206) problems.push(`status ${res.status}, not 206`)
    if (res.headers.get('content-range') !== `bytes 0-${last}/${size}`) problems.push(`Content-Range "${res.headers.get('content-range')}"`)
    if (body.length !== last + 1) problems.push(`${body.length} bytes, not ${last + 1}`)
    if (isPmtiles && (new TextDecoder().decode(body.subarray(0, 7)) !== 'PMTiles' || body[7] !== 3)) problems.push('not a PMTiles v3 file')
    const acao = res.headers.get('access-control-allow-origin')
    if (acao !== origin && acao !== '*') problems.push('no Access-Control-Allow-Origin')
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase()
    for (const h of ['etag', 'content-range']) if (!exposed.includes(h)) problems.push(`${h} not exposed`)
    if (problems.length) fail(`${origin}: ${problems.join('; ')}`)
    else pass(`${origin}: preflight + range read OK`)
  }
  return { ok, lines }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const base = args.find((a) => /^https?:\/\//.test(a))
  const k = args.indexOf('--key')
  if (!base) {
    console.error('usage: node scripts/packs/check-hosting.ts <public bucket URL> [--key <path in bucket>]')
    process.exit(2)
  }
  const result = await checkHosting(base, { key: k >= 0 ? args[k + 1] : undefined })
  console.log(`Checking ${base}`)
  console.log(result.lines.join('\n'))
  console.log(result.ok ? 'All checks passed.' : 'Some checks failed: see docs/hosting-r2.md.')
  process.exit(result.ok ? 0 : 1)
}
