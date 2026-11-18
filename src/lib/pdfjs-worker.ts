// The pdf.js worker the app actually runs (geopdf.ts imports it with
// `?worker&url`, so Vite builds it as its own file, loaded only on import).
// Module order matters: the setup module must run before pdf.js's worker code.
import './pdfjs-worker-setup'
// Re-exported so pdf.js's fallback (running the worker on the page if a real
// worker can't start) still finds it.
export { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs'
