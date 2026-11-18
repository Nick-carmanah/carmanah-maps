import {
  checkSentinelFile,
  ESRI_IMAGERY_TILE_URL,
  initialSatelliteKind,
  type SatelliteKind,
} from '../map/satellite-source'

/**
 * Satellite imagery needs signal. Esri's terms for World Imagery don't allow
 * keeping its tiles on the phone (docs/satellite-imagery-options.md), so the
 * service worker doesn't cache them and Save offline doesn't download them.
 * Our own Sentinel-2 file (src/map/satellite-source.ts) is read over the
 * network too until satellite is added to saved areas. Without signal the
 * map shows streets instead of blank tiles, and the layers sheet says
 * satellite needs signal.
 *
 * "No signal" is either the phone saying it's offline, or several satellite
 * tiles failing in a row: Wi-Fi with no internet behind it (a camp hotspot,
 * a dead satellite link) still says it's online.
 */

/** Failed satellite tiles in a row, with none loading, that mean no signal. */
export const FAILURES_FOR_NO_SIGNAL = 3
/** While tiles failed but the phone says it's online: how often to try one
 * tile to see whether signal is back. */
export const RECHECK_MS = 30_000

export interface SignalDeps {
  /** What the phone says (navigator.onLine). */
  isOnline(): boolean
  /** Try to load one satellite tile; true if it loaded. */
  probe(): Promise<boolean>
}

export class SatelliteSignal {
  private failures = 0
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: SignalDeps) {}

  /** Can satellite tiles load right now? */
  ok(): boolean {
    return this.deps.isOnline() && this.failures < FAILURES_FOR_NO_SIGNAL
  }

  /** Did tiles fail while the phone says it's online? Then only a recheck
   * (or the phone going offline and back) brings satellite back, because the
   * map stops asking for satellite tiles while it shows streets. */
  needsRecheck(): boolean {
    return this.deps.isOnline() && this.failures >= FAILURES_FOR_NO_SIGNAL
  }

  tileLoaded(): void {
    this.setFailures(0)
  }

  tileFailed(): void {
    this.setFailures(this.failures + 1)
  }

  /** The imagery source itself couldn't load (no answer at all): no signal. */
  sourceFailed(): void {
    this.setFailures(Math.max(this.failures, FAILURES_FOR_NO_SIGNAL))
  }

  /** The phone went online or offline: start afresh. */
  networkChanged(): void {
    this.failures = 0
    this.emit()
  }

  /** Try one tile; signal is back if it loads. */
  async recheck(): Promise<void> {
    if (!this.needsRecheck()) return
    if (await this.deps.probe()) this.setFailures(0)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setFailures(failures: number): void {
    const before = this.ok()
    this.failures = failures
    if (this.ok() !== before) this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

let kind: SatelliteKind = initialSatelliteKind()

/** Which imagery the map is using (MapView switches to Esri if our
 * Sentinel-2 file isn't uploaded yet), so a recheck probes the right one. */
export function setSatelliteKind(next: SatelliteKind): void {
  kind = next
}

async function probeSatellite(): Promise<boolean> {
  if (kind === 'sentinel') return (await checkSentinelFile()) === 'ok'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const url = ESRI_IMAGERY_TILE_URL.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0')
    return (await fetch(url, { cache: 'no-store', signal: controller.signal })).ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** The app's one satellite signal. */
export const satelliteSignal = new SatelliteSignal({
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  probe: probeSatellite,
})

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => satelliteSignal.networkChanged())
  window.addEventListener('offline', () => satelliteSignal.networkChanged())
}
