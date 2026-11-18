// Runs inside the pdf.js worker before pdf.js itself (pdfjs-worker.ts imports
// it first), so keep it free of imports from pdf.js.
import { installArrayBufferTransfer } from './arraybuffer-transfer'

/** Sent from the worker to the page for each pdf.js warning. */
export interface PdfjsWarningMessage {
  pdfjsWarning: string
}

installArrayBufferTransfer()

// pdf.js "ignores" many drawing errors: it logs a warning in the worker and
// carries on, so a map can come out with its text or layers missing and
// nothing on the page knows. Forward its warnings so the import can say so.
// pdf.js's own message handler ignores messages it didn't address to itself.
// (Only in a real worker: if pdf.js falls back to running this file on the
// page, there's no port to post to.)
if ('WorkerGlobalScope' in globalThis) {
  const warn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    warn(...args)
    const [text] = args
    if (typeof text === 'string' && text.startsWith('Warning: ')) {
      const message: PdfjsWarningMessage = { pdfjsWarning: text.slice('Warning: '.length) }
      self.postMessage(message)
    }
  }
}
