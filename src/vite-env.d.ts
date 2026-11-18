/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Our Sentinel-2 satellite PMTiles file (src/map/satellite-source.ts). */
  readonly VITE_SATELLITE_PMTILES_URL?: string
}

// pdf.js ships no types for its worker bundle (imported by src/lib/pdfjs-worker.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown
}
