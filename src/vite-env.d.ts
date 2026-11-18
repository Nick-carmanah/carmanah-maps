/// <reference types="vite/client" />

// pdf.js ships no types for its worker bundle (imported by src/lib/pdfjs-worker.ts).
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown
}
