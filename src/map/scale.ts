import type { IControl, Map as MlMap } from 'maplibre-gl'
import { M_PER_CHAIN, M_PER_FT, M_PER_MI, M_PER_NM, type DistanceUnit } from '../lib/units'

/** Largest 1, 2, 3 or 5 × 10ⁿ that fits in `x`. */
function niceFloor(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x))
  const d = x / p
  const nice = d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1
  return Number((nice * p).toPrecision(6))
}

/**
 * The round distance to label a scale bar with, given how many metres fit
 * in its maximum width. `ratio` (0–1] is the share of that width to draw.
 * Same unit switching as formatDistance in lib/units.ts.
 */
export function scaleBarFor(
  maxMeters: number,
  unit: DistanceUnit,
): { label: string; ratio: number } {
  let perUnit: number
  let label: string
  switch (unit) {
    case 'imperial':
      ;[perUnit, label] = maxMeters / M_PER_FT > 5280 ? [M_PER_MI, 'mi'] : [M_PER_FT, 'ft']
      break
    case 'nautical':
      ;[perUnit, label] = maxMeters / M_PER_NM >= 0.1 ? [M_PER_NM, 'NM'] : [M_PER_FT, 'ft']
      break
    case 'chains':
      ;[perUnit, label] = [M_PER_CHAIN, 'ch']
      break
    default:
      ;[perUnit, label] = maxMeters >= 1000 ? [1000, 'km'] : [1, 'm']
  }
  const max = maxMeters / perUnit
  const value = niceFloor(max)
  return { label: `${value} ${label}`, ratio: value / max }
}

/**
 * Scale bar in the chosen distance units. Replaces maplibregl.ScaleControl,
 * which has no chains; draws the same way and reuses its CSS class.
 */
export class UnitScaleControl implements IControl {
  private map: MlMap | null = null
  private container: HTMLDivElement | null = null
  private unit: DistanceUnit
  private readonly maxWidth = 100

  constructor(unit: DistanceUnit) {
    this.unit = unit
  }

  onAdd(map: MlMap): HTMLElement {
    this.map = map
    this.container = document.createElement('div')
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-scale'
    map.on('move', this.update)
    this.update()
    return this.container
  }

  onRemove(): void {
    this.map?.off('move', this.update)
    this.container?.remove()
    this.map = null
    this.container = null
  }

  setUnit(unit: DistanceUnit): void {
    this.unit = unit
    this.update()
  }

  private update = (): void => {
    const map = this.map
    const container = this.container
    if (!map || !container) return
    // Measure across the middle of the map, like MapLibre's own control.
    const y = map.getContainer().clientHeight / 2
    const left = map.unproject([0, y])
    const right = map.unproject([this.maxWidth, y])
    const maxMeters = left.distanceTo(right)
    if (!(maxMeters > 0)) return
    const { label, ratio } = scaleBarFor(maxMeters, this.unit)
    container.style.width = `${this.maxWidth * ratio}px`
    container.textContent = label
  }
}
