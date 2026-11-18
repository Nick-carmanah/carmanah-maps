import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { EMBEDDED_BASE, EMBEDDED_MODE, EMBEDDED_OUT_DIR, embeddedBuild } from './build/embedded'

/** Tile hosts the service worker keeps (cache-first) for offline use. */
export const TILE_CACHE_PATTERN =
  /^https:\/\/(tiles\.openfreemap\.org|s3\.amazonaws\.com\/elevation-tiles-prod)\/.*/

// `vite build --mode embedded` (npm run build:embedded) makes the map page the
// crew app ships at /maps/, without a service worker: see build/embedded.ts.
export default defineConfig(({ mode }) => ({
  // GitHub Pages serves the app under /carmanah-maps/; local dev stays at /.
  base: mode === EMBEDDED_MODE ? EMBEDDED_BASE : process.env.GITHUB_ACTIONS ? '/carmanah-maps/' : '/',
  build: mode === EMBEDDED_MODE ? { outDir: EMBEDDED_OUT_DIR, emptyOutDir: true } : {},
  // The pdf.js worker (src/lib/pdfjs-worker.ts). If a real worker can't
  // start, pdf.js falls back to importing it on the page and reading its
  // WorkerMessageHandler export, so build it as an ES module and keep that
  // export (Vite drops worker exports by default).
  worker: {
    format: 'es',
    plugins: () => [
      {
        name: 'keep-worker-exports',
        options: (options) => ({ ...options, preserveEntrySignatures: 'strict' }),
      },
    ],
  },
  plugins: [
    react(),
    mode === EMBEDDED_MODE ? embeddedBuild() : VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Carmanah Maps',
        short_name: 'Carmanah Maps',
        description: 'Wildfire-focused offline field mapping',
        theme_color: '#1a1a1a',
        background_color: '#1a1a1a',
        display: 'standalone',
        orientation: 'any',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // The pdf.js worker (assets/pdfjs-worker-*.js) must be in here, or
        // GeoPDF import fails offline. mjs: in case a future build emits one.
        // pbf + json: the basemap's label fonts and icon sheets
        // (public/basemap/), so labels draw offline from the first visit.
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,woff2}', 'basemap/**/*.{pbf,json}'],
        runtimeCaching: [
          {
            // Basemap TileJSON: network-first so new weekly tile builds are
            // picked up; the cached copy lets the map start offline.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/planet$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'map-tiles',
              networkTimeoutSeconds: 4,
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Basemap and terrain tiles: cache-first.
            // Never satellite: Esri World Imagery (server.arcgisonline.com)
            // may not be kept offline outside Esri software, so it stays
            // online only (src/lib/satellite-signal.ts). test/satellite-
            // online-only.test.ts checks this pattern.
            urlPattern: TILE_CACHE_PATTERN,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              // Sized for saved offline areas (~3000 tiles each), not just browsing.
              expiration: {
                maxEntries: 15000,
                maxAgeSeconds: 60 * 60 * 24 * 90,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
              plugins: [
                {
                  // Same key as tileCacheKey() in src/lib/mappacks.ts: drop the
                  // weekly build version from basemap tile URLs so saved areas
                  // keep matching after it rolls over.
                  cacheKeyWillBeUsed: async ({ request }) =>
                    request.url.replace(
                      /^(https:\/\/tiles\.openfreemap\.org\/planet)\/[^/]+(\/\d+\/\d+\/\d+\.pbf)$/,
                      '$1$2',
                    ),
                },
              ],
            }
          }
        ]
      }
    })
  ]
}))
