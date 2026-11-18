// Surface reflectance to 8-bit colour for a natural-looking true-colour map.
//
// Sentinel-2 reflectance over BC forest is dark (red band ~0.02–0.05), so a
// straight linear stretch makes forest near-black. A gamma curve lifts the
// darks (forest, burns, cutblocks) while bright rock and snow still clip
// late. Same curve for all three bands, so colours stay neutral.

export interface Stretch {
  /** Reflectance that maps to 255. */
  maxReflectance: number
  /** > 1 brightens dark areas. */
  gamma: number
}

export const TRUE_COLOUR: Stretch = { maxReflectance: 0.3, gamma: 1.7 }

export function reflectanceToByte(reflectance: number, stretch: Stretch = TRUE_COLOUR): number {
  if (!(reflectance > 0)) return 0
  const v = Math.min(1, reflectance / stretch.maxReflectance)
  return Math.round(255 * v ** (1 / stretch.gamma))
}

/** How a source stores reflectance: reflectance = dn × scale + offset. */
export interface DnEncoding {
  scale: number
  offset: number
  /** int16 (CDSE mosaics) or uint16 (Sentinel-2 L2A). */
  signed: boolean
  nodata: number
}

/** Index into a DN lookup table for a raw sample. */
export function lutIndex(dn: number, signed: boolean): number {
  return signed ? dn + 32768 : dn
}

/** Byte for every possible 16-bit DN (65,536 entries). */
export function dnLookup(encoding: DnEncoding, stretch: Stretch = TRUE_COLOUR): Uint8Array {
  const lut = new Uint8Array(65536)
  for (let i = 0; i < 65536; i++) {
    const dn = encoding.signed ? i - 32768 : i
    lut[i] = reflectanceToByte(dn * encoding.scale + encoding.offset, stretch)
  }
  return lut
}
