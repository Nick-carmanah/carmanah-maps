import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Two pages on purpose:
//  - index.html: the offline map. Its Content-Security-Policy allows no
//    http(s) at all, so anything it draws came from on-device storage.
//  - tools.html: downloads, pack building and scale tests. Its CSP allows
//    only the tile hosts and the Mac-side test server.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        tools: resolve(import.meta.dirname, 'tools.html'),
      },
    },
  },
})
