/**
 * True in the build the Carmanah crew app ships (`npm run build:embedded`,
 * build/embedded.ts), false on the website and in dev.
 */
export const EMBEDDED = import.meta.env.MODE === 'embedded'
