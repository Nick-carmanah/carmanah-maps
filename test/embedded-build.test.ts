/**
 * The embedded build (build/embedded.ts): the map page the Carmanah crew app
 * ships at /maps/. The crew app's service worker caches exactly the files in
 * precache-manifest.json, so the manifest must list every file the build
 * writes, with the right sizes and hashes, and nothing else. Also checks the
 * rest of the integration contract (rebuild plan §0): no service worker of
 * our own, /capacitor.js first, nothing loaded from outside, label fonts and
 * icons in the bundle.
 *
 * Runs a real `vite build --mode embedded` into a temporary folder.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CAPACITOR_SCRIPT,
  EMBEDDED_BASE,
  EMBEDDED_MODE,
  MANIFEST_NAME,
  WEBSITE_ONLY_FILES,
  type PrecacheManifest,
} from '../build/embedded'
import { GLYPH_RANGES, MAP_FONTSTACKS, MAP_STYLE } from '../src/map/basemap'

const ROOT = resolve(import.meta.dirname, '..')
const SPRITE_FILES = ['ofm.json', 'ofm.png', 'ofm@2x.json', 'ofm@2x.png']

/** Every file under dir, as `/`-separated relative paths (written separately
 * from build/embedded.ts's listFiles on purpose). */
function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name
    return statSync(join(dir, path)).isDirectory() ? walk(dir, path) : [path]
  })
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

let out: string
let manifest: PrecacheManifest
let files: string[]
let html: string
let scripts: string

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'carmanah-embedded-'))
  await build({
    root: ROOT,
    configFile: resolve(ROOT, 'vite.config.ts'),
    mode: EMBEDDED_MODE,
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true },
  })
  manifest = JSON.parse(readFileSync(join(out, MANIFEST_NAME), 'utf8'))
  files = walk(out)
  html = readFileSync(join(out, 'index.html'), 'utf8')
  scripts = files
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(out, f), 'utf8'))
    .join('\n')
}, 180_000)

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true })
})

describe('precache-manifest.json', () => {
  it('lists every file in the build exactly once, and nothing else', () => {
    const listed = manifest.files.map((f) => f.path)
    expect(new Set(listed).size).toBe(listed.length)
    expect([...listed].sort()).toEqual(files.filter((f) => f !== MANIFEST_NAME).sort())
    expect(listed).toEqual([...listed].sort())
  })

  it('has each file’s size and sha256', () => {
    for (const entry of manifest.files) {
      const bytes = readFileSync(join(out, entry.path))
      expect(entry.bytes, entry.path).toBe(bytes.length)
      expect(entry.sha256, entry.path).toBe(sha256(bytes))
    }
    expect(manifest.bytes).toBe(manifest.files.reduce((n, f) => n + f.bytes, 0))
  })

  it('gives each file its address under /maps/, encoded the way browsers request it', () => {
    expect(manifest.base).toBe(EMBEDDED_BASE)
    for (const entry of manifest.files) {
      expect(decodeURIComponent(entry.url), entry.path).toBe(EMBEDDED_BASE + entry.path)
      expect(new URL(entry.url, 'https://localhost').pathname).toBe(entry.url)
      expect(new URL(EMBEDDED_BASE + entry.path, 'https://localhost').pathname).toBe(entry.url)
    }
  })

  it('has a revision that follows the files', () => {
    expect(manifest.version).toBe(1)
    expect(manifest.revision).toMatch(/^[0-9a-f]{16}$/)
    const expected = createHash('sha256')
      .update(manifest.files.map((f) => `${f.path}\0${f.sha256}\n`).join(''))
      .digest('hex')
      .slice(0, 16)
    expect(manifest.revision).toBe(expected)
  })

  it('uses only file names the crew app can list and serve', () => {
    for (const entry of manifest.files) expect(entry.path).toMatch(/^[A-Za-z0-9 ._@/-]+$/)
  })
})

describe('the embedded page', () => {
  it('has no service worker, web app manifest or registration script', () => {
    for (const f of files) expect(f).not.toMatch(/(^|\/)(sw\.js|registerSW\.js|workbox-[^/]*\.js|manifest\.webmanifest)$/)
    expect(html).not.toMatch(/registerSW|manifest\.webmanifest|rel="manifest"/)
    expect(scripts).not.toContain('serviceWorker')
  })

  it('loads /capacitor.js first, then only its own files under /maps/', () => {
    const tags = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(tags[0]).toBe(`<script src="${CAPACITOR_SCRIPT}">`)
    expect(html).toContain(`<script src="${CAPACITOR_SCRIPT}"></script>`)
    const urls = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    expect(urls.length).toBeGreaterThan(2)
    for (const url of urls.filter((u) => u !== CAPACITOR_SCRIPT)) {
      expect(url, url).toMatch(/^\/maps\/assets\/[\w.-]+-[\w-]{8}\.(js|css)$/)
    }
  })

  it('leaves out the website-only files', () => {
    for (const f of WEBSITE_ONLY_FILES) expect(files).not.toContain(f)
  })

  it('ships the basemap’s label fonts and icons, and asks nobody else for them', () => {
    for (const font of MAP_FONTSTACKS) {
      for (const range of GLYPH_RANGES) expect(files).toContain(`basemap/fonts/${font}/${range}.pbf`)
    }
    for (const sprite of SPRITE_FILES) expect(files).toContain(`basemap/sprites/${sprite}`)
    expect(scripts).not.toMatch(/openfreemap\.org\/(fonts|sprites)/)
  })
})

describe('basemap style', () => {
  it('draws labels and icons from the files in public/basemap/', () => {
    expect(MAP_STYLE.glyphs).toBe('/basemap/fonts/{fontstack}/{range}.pbf')
    expect(MAP_STYLE.sprite).toBe('/basemap/sprites/ofm')
    for (const font of MAP_FONTSTACKS) {
      for (const range of GLYPH_RANGES) {
        expect(existsSync(join(ROOT, 'public/basemap/fonts', font, `${range}.pbf`)), `${font} ${range}`).toBe(true)
      }
    }
    for (const sprite of SPRITE_FILES) expect(existsSync(join(ROOT, 'public/basemap/sprites', sprite))).toBe(true)
    expect(existsSync(join(ROOT, 'public/basemap/fonts/OFL.txt'))).toBe(true)
  })
})
