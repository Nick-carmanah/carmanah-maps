import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Two pages on purpose:
//  - index.html: the offline map. Its Content-Security-Policy allows no
//    http(s) at all, so anything it draws came from on-device storage.
//  - tools.html: downloads, pack building and scale tests. Its CSP allows
//    only the tile hosts and the Mac-side test server.
//  - storage.html: the app's own storage layer (src/lib/storage) and Maps
//    library on Filesystem, offline like index.html.
export default defineConfig({
  base: './',
  // Same worker setup as the app's vite.config.ts, for pdf.js (storage.html imports the app's GeoPDF import).
  worker: {
    format: 'es',
    plugins: () => [
      {
        name: 'keep-worker-exports',
        options: (options) => ({ ...options, preserveEntrySignatures: 'strict' }),
      },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        tools: resolve(import.meta.dirname, 'tools.html'),
        // The app's real storage code (../src/lib/storage) on the native side.
        storage: resolve(import.meta.dirname, 'storage.html'),
      },
    },
  },
})
