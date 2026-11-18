/**
 * The embedded build: the map page the Carmanah crew app ships at /maps/
 * (`npm run build:embedded` → dist-embedded/). Contract: rebuild plan §0;
 * hand-over notes: docs/crew-app-handoff.md.
 *
 * Differences from the website build (vite.config.ts):
 *  - base /maps/;
 *  - no service worker, no web app manifest, no registration script: the
 *    crew app's own sw.js caches these files, from precache-manifest.json;
 *  - <script src="/capacitor.js"> (the crew app's copy of Capacitor's core
 *    script) is the first script in index.html, so window.Capacitor exists
 *    before the app starts;
 *  - website-only files from public/ are left out.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

export const EMBEDDED_MODE = 'embedded'
export const EMBEDDED_BASE = '/maps/'
export const EMBEDDED_OUT_DIR = 'dist-embedded'
export const MANIFEST_NAME = 'precache-manifest.json'
export const CAPACITOR_SCRIPT = '/capacitor.js'

/** In public/ for the website only: the PWA's home-screen icons (its web
 * manifest isn't in this build) and the demo fire for `?kml=test-fire.kml`. */
export const WEBSITE_ONLY_FILES = ['pwa-192.png', 'pwa-512.png', 'test-fire.kml']

export interface PrecacheEntry {
  /** What the page requests, percent-encoded the way browsers send it. */
  url: string
  /** Path inside the build folder (and inside the crew app's public/maps/). */
  path: string
  bytes: number
  sha256: string
}

export interface PrecacheManifest {
  /** Format of this file. */
  version: 1
  base: string
  /** package.json version of this app. */
  appVersion: string
  /** sha256 of every path and hash below (first 16 hex digits): changes
   * whenever any file does. */
  revision: string
  /** Total of every file's bytes. */
  bytes: number
  /** Every file in the build except this manifest, sorted by path. */
  files: PrecacheEntry[]
}

/** Every file under dir, as sorted `/`-separated relative paths. */
export function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  walk('')
  return out.sort()
}

export function precacheManifest(outDir: string, base: string, appVersion: string): PrecacheManifest {
  const files = listFiles(outDir)
    .filter((path) => path !== MANIFEST_NAME)
    .map((path): PrecacheEntry => {
      const bytes = readFileSync(join(outDir, path))
      return {
        url: new URL(path, `https://localhost${base}`).pathname,
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    })
  const revision = createHash('sha256')
    .update(files.map((f) => `${f.path}\0${f.sha256}\n`).join(''))
    .digest('hex')
    .slice(0, 16)
  return {
    version: 1,
    base,
    appVersion,
    revision,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    files,
  }
}

export function embeddedBuild(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'carmanah-embedded-build',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    // After Vite's own HTML work, so the address stays exactly /capacitor.js
    // (served by the crew app at its root, not under /maps/).
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'script', attrs: { src: CAPACITOR_SCRIPT }, injectTo: 'head-prepend' }],
    },
    closeBundle: {
      order: 'post',
      handler() {
        const outDir = resolve(config.root, config.build.outDir)
        for (const file of WEBSITE_ONLY_FILES) rmSync(join(outDir, file), { force: true })
        const { version } = JSON.parse(readFileSync(resolve(config.root, 'package.json'), 'utf8')) as {
          version: string
        }
        const manifest = precacheManifest(outDir, config.base, version)
        writeFileSync(join(outDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n')
        config.logger.info(
          `\n${MANIFEST_NAME}: ${manifest.files.length} files, ` +
            `${(manifest.bytes / 1024 / 1024).toFixed(2)} MB, revision ${manifest.revision}`,
        )
      },
    },
  }
}
