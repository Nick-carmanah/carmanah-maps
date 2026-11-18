import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // GitHub Pages serves the app under /carmanah-maps/; local dev stays at /.
  base: process.env.GITHUB_ACTIONS ? '/carmanah-maps/' : '/',
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
    VitePWA({
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
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,woff2}'],
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
            // Basemap tiles, fonts and icons, satellite, and terrain tiles: cache-first.
            urlPattern:
              /^https:\/\/(tiles\.openfreemap\.org|server\.arcgisonline\.com|s3\.amazonaws\.com\/elevation-tiles-prod)\/.*/,
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
})
