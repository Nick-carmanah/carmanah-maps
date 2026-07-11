import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        runtimeCaching: [
          {
            // Basemap, satellite, and terrain tiles: cache-first.
            urlPattern:
              /^https:\/\/(tile\.openstreetmap\.org|server\.arcgisonline\.com|s3\.amazonaws\.com\/elevation-tiles-prod)\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-tiles',
              // Sized for saved offline areas (~3000 tiles each), not just browsing.
              expiration: {
                maxEntries: 15000,
                maxAgeSeconds: 60 * 60 * 24 * 90,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ]
})
