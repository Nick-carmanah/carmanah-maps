/**
 * Pin symbols across import/export: labels, matching icon file names from
 * other apps back to our symbol keys, and PNGs to embed in a KMZ.
 *
 * Symbol keys (UserFeature.symbol): a FIRE_SYMBOLS key, an NWCG key
 * ('nwcg-…'), or 'icon-<id>' for an icon image restored from an imported KMZ.
 */
import { FIRE_SYMBOLS, renderSymbolImage } from './features'
import { NWCG_SYMBOLS, nwcgIconUrl } from './nwcg'
import { getIcon } from './store'

export const ICON_PREFIX = 'icon-'

export function isImportedIcon(symbol: string | undefined): boolean {
  return !!symbol?.startsWith(ICON_PREFIX)
}

export function symbolLabel(symbol: string | undefined): string {
  if (!symbol) return ''
  if (FIRE_SYMBOLS[symbol]) return FIRE_SYMBOLS[symbol].label
  const nwcg = NWCG_SYMBOLS.find((s) => s.key === symbol)
  if (nwcg) return nwcg.label
  return isImportedIcon(symbol) ? 'Imported icon' : symbol
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Match an icon file name or a GPX <sym> / symbol label to one of our
 * symbol keys: "files/helispot.png", "nwcg-drop-point", "Drop Point.png",
 * "Aerial Hazard" … Undefined if nothing matches. */
export function symbolKeyFromName(name: string | undefined | null): string | undefined {
  if (!name) return undefined
  const base = name.split(/[\\/]/).pop() ?? ''
  const s = slug(decodeURIComponentSafe(base))
  if (!s) return undefined
  if (FIRE_SYMBOLS[s]) return s
  for (const [key, spec] of Object.entries(FIRE_SYMBOLS)) if (slug(spec.label) === s) return key
  for (const n of NWCG_SYMBOLS) {
    if (n.key === s || slug(n.file) === s || slug(n.label) === s || `nwcg-${s}` === n.key) return n.key
  }
  return undefined
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const COLOR_WORDS: Record<string, string> = {
  red: '#e11d1d',
  orange: '#f97316',
  yellow: '#facc15',
  ylw: '#facc15',
  green: '#22c55e',
  grn: '#22c55e',
  blue: '#3b82f6',
  blu: '#3b82f6',
  ltblu: '#38bdf8',
  purple: '#a855f7',
  purple2: '#a855f7',
  pink: '#ec4899',
  white: '#ffffff',
  wht: '#ffffff',
  black: '#111111',
  grey: '#6b7280',
  gray: '#6b7280',
  brown: '#78350f',
}

/** Colour named in a remote pin icon's file name ("red_pin.png",
 * "pin-yellow-inground.png", Google's "ylw-pushpin.png"…), if any. */
export function colorFromIconName(href: string): string | undefined {
  const base = (href.split(/[?#]/)[0].split('/').pop() ?? '').toLowerCase()
  for (const word of base.split(/[^a-z0-9]+/)) {
    if (COLOR_WORDS[word]) return COLOR_WORDS[word]
  }
  return undefined
}

/** 32 px white disc with a dark ring: the KMZ icon for a plain-dot pin. KML
 * IconStyle <color> tints it to the pin's colour (white × colour = colour). */
const DOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABEklEQVR42u2XwQ2FIAyGHcGzE3h0BC9O4CKOwALmjcQI7uACjNDXEjCN0QYVUw42+ROjhX62BbECgEpT1Qdwxblpmg5lUBblUBDkwj161mUHwEn7EAASRb79YwCcpEb99gGGYYBpmmCeZy+6pnsHIDS2vgUQgi9xsrZtfbB1XeHM6Bn5kC+DWCSIpODjOIqBj0BoTArEGcCWdkrvXaOxvBxJAKHhtjd/artM9CkANtb8StqlcrCesCJAWOfemZopl9FcLAudBGCiY46351lgAEYCsHGd5za2T1gJwD3t/IQV4SSA7PU/6oOiAdRLoN6E6stQdyNS34qL+Bipf46LOJCoH8mKOJQWcSwv5sfk+zd8U39y1LLmYuBDZwAAAABJRU5ErkJggg=='

export function dotPng(): Uint8Array {
  const bin = atob(DOT_PNG_BASE64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** PNG for a pin symbol, or null for a plain dot / unknown key. Works
 * offline: built-in symbols are drawn, NWCG icons are precached app files,
 * imported icons come from IndexedDB. */
export async function symbolPng(symbol: string | undefined): Promise<Blob | null> {
  if (!symbol) return null
  if (FIRE_SYMBOLS[symbol]) {
    const img = renderSymbolImage(symbol)
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    canvas.getContext('2d')!.putImageData(img, 0, 0)
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
  }
  const nwcg = NWCG_SYMBOLS.find((s) => s.key === symbol)
  if (nwcg) {
    try {
      const res = await fetch(nwcgIconUrl(nwcg.file))
      return res.ok ? await res.blob() : null
    } catch {
      return null
    }
  }
  if (isImportedIcon(symbol)) {
    return (await getIcon(symbol.slice(ICON_PREFIX.length)))?.blob ?? null
  }
  return null
}
