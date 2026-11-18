import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { IMMUTABLE, objectHeaders } from '../scripts/packs/layout.ts'
import { corsHeaders, loadCorsPolicy, originMatches, preflightHeaders } from '../scripts/packs/cors.ts'
import { parseRange, startServer } from '../scripts/packs/serve-local.ts'
import { appOrigins, checkHosting } from '../scripts/packs/check-hosting.ts'

describe('bucket layout', () => {
  it('gives immutable headers to versioned files and a short cache to the catalog', () => {
    expect(objectHeaders('basemap/bc/20261115_080022_pt.pmtiles')).toEqual({
      contentType: 'application/vnd.pmtiles',
      cacheControl: IMMUTABLE,
      immutable: true,
    })
    expect(objectHeaders('packs/c40983-20261118/pack.json')?.immutable).toBe(true)
    expect(objectHeaders('packs/c40983-20261118/terrain.pmtiles')?.immutable).toBe(true)
    expect(objectHeaders('catalog.json')).toMatchObject({ immutable: false, cacheControl: 'public, max-age=300' })
    expect(objectHeaders('imagery/s2/bc/2026q3.pmtiles')?.immutable).toBe(true)
  })

  it('refuses keys outside the layout', () => {
    for (const key of ['', 'x.pmtiles', 'basemap/bc.pmtiles', 'packs/a/b/c.pmtiles', 'basemap/../catalog.json/x.pmtiles', 'packs/.hidden/pack.json']) {
      expect(objectHeaders(key), key).toBeNull()
    }
  })
})

describe('CORS policy (r2-cors.json)', () => {
  const policy = loadCorsPolicy()

  it('matches R2 origin patterns', () => {
    expect(originMatches('*', 'capacitor://localhost')).toBe(true)
    expect(originMatches('https://*.example.com', 'https://a.b.example.com')).toBe(true)
    expect(originMatches('https://*.example.com', 'https://example.com')).toBe(false)
    expect(originMatches('https://localhost', 'https://localhost:8080')).toBe(false)
  })

  it('lets the app read ranges from the website, the crew app and both native shells', () => {
    for (const origin of ['https://nick-carmanah.github.io', 'https://app.carmanahwildfire.com', 'capacitor://localhost', 'https://localhost']) {
      const pre = preflightHeaders(policy, origin, 'GET', ['range'])
      expect(pre?.['Access-Control-Allow-Origin'], origin).toBe(origin)
      expect(pre?.['Access-Control-Allow-Headers']).toBe('range')
      const get = corsHeaders(policy, origin, 'GET')
      expect(get?.['Access-Control-Expose-Headers']).toMatch(/ETag.*Content-Range/)
    }
    expect(appOrigins()).toContain('capacitor://localhost')
    expect(appOrigins().some((o) => o.startsWith('http://localhost'))).toBe(false)
  })

  it('refuses other origins, writes and unexpected headers', () => {
    expect(corsHeaders(policy, 'https://evil.example', 'GET')).toBeNull()
    expect(corsHeaders(policy, 'capacitor://localhost', 'PUT')).toBeNull()
    expect(preflightHeaders(policy, 'capacitor://localhost', 'GET', ['range', 'authorization'])).toBeNull()
  })
})

describe('parseRange (as R2 reads Range)', () => {
  it('reads single, open and suffix ranges', () => {
    expect(parseRange('bytes=0-126', 1000)).toEqual({ start: 0, end: 126 })
    expect(parseRange('bytes=990-', 1000)).toEqual({ start: 990, end: 999 })
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 })
    expect(parseRange('bytes=-10', 1000)).toEqual({ start: 990, end: 999 })
    expect(parseRange(undefined, 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange('bytes=0-1,5-6', 1000)).toBe('invalid')
  })
})

describe('check-hosting against the local stand-in', () => {
  let root: string
  let server: Server
  let base: string

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bucket-'))
    mkdirSync(join(root, 'basemap', 'test'), { recursive: true })
    const archive = new Uint8Array(4096)
    archive.set(new TextEncoder().encode('PMTiles'), 0)
    archive[7] = 3
    writeFileSync(join(root, 'basemap', 'test', 'b1.pmtiles'), archive)
    writeFileSync(
      join(root, 'catalog.json'),
      JSON.stringify({ sources: { basemap: [{ url: 'basemap/test/b1.pmtiles' }] }, packs: [] }),
    )
    server = await startServer({ root, port: 0 })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })

  afterAll(() => {
    server.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('passes when the bucket is set up as documented', async () => {
    const result = await checkHosting(base)
    expect(result.lines.join('\n')).not.toMatch(/FAIL/)
    expect(result.ok).toBe(true)
    expect(result.lines.join('\n')).toMatch(/capacitor:\/\/localhost: preflight \+ range read OK/)
  })

  it('serves exact byte ranges with an ETag, and honours If-Range', async () => {
    const url = `${base}basemap/test/b1.pmtiles`
    const res = await fetch(url, { headers: { Range: 'bytes=100-199' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 100-199/4096')
    expect((await res.arrayBuffer()).byteLength).toBe(100)
    const etag = res.headers.get('etag')!
    expect((await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': etag } })).status).toBe(206)
    const stale = await fetch(url, { headers: { Range: 'bytes=0-9', 'If-Range': '"old"' } })
    expect(stale.status).toBe(200)
    await stale.arrayBuffer()
    expect((await fetch(`${base}samples/secret.pdf`)).status).toBe(404)
  })

  it('checks a non-PMTiles key against its own cache header (first check, before any archive)', async () => {
    writeFileSync(join(root, 'LICENSE.txt'), 'Map data © OpenStreetMap contributors. '.repeat(10))
    const result = await checkHosting(base, { key: 'LICENSE.txt' })
    expect(result.ok, result.lines.join('\n')).toBe(true)
    expect(result.lines.join('\n')).toMatch(/Cache-Control "public, max-age=3600"/)
  })

  it('fails an origin the policy leaves out', async () => {
    const result = await checkHosting(base, { origins: ['https://not-allowed.example'] })
    expect(result.ok).toBe(false)
    expect(result.lines.join('\n')).toMatch(/not-allowed\.example: preflight HTTP 403/)
  })
})
