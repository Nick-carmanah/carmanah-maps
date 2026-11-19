import type { NavSettings } from './nav-settings'

/**
 * How navigation gets your attention on arrival and approach: a message
 * (always), vibration (Android; iPhones don't let web pages vibrate), a
 * beep made on the phone with Web Audio (no sound file, works offline),
 * and a system notification when the page is in the background and
 * notifications were allowed (the geofences ask for that).
 *
 * Phones only play sound a page made after a tap, so primeAlerts() runs
 * on the tap that starts navigation. The iPhone's silent switch mutes it.
 */

export type AlertKind = 'approach' | 'arrive' | 'finish'

let audio: AudioContext | null = null

/** Call from a tap (Start, Go): unlocks sound for later alerts. */
export function primeAlerts(): void {
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    audio ??= new Ctx()
    if (audio.state === 'suspended') void audio.resume().catch(() => {})
  } catch {
    audio = null
  }
}

/** Beeps for each kind: one for a heads-up, two for a waypoint, three at the end. */
export const BEEPS: Record<AlertKind, { hz: number; count: number }> = {
  approach: { hz: 660, count: 1 },
  arrive: { hz: 880, count: 2 },
  finish: { hz: 990, count: 3 },
}

export const VIBRATIONS: Record<AlertKind, number[]> = {
  approach: [150],
  arrive: [250, 120, 250],
  finish: [400, 150, 400, 150, 400],
}

function beep(kind: AlertKind) {
  const ctx = audio
  if (!ctx) return
  try {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const { hz, count } = BEEPS[kind]
    const t0 = ctx.currentTime + 0.02
    for (let i = 0; i < count; i++) {
      const start = t0 + i * 0.28
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = hz
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.22)
    }
  } catch {
    // No sound this time; the message still shows.
  }
}

/** Sound, vibrate and notify per the settings. The caller shows the message. */
export function signalAlert(kind: AlertKind, message: string, settings: NavSettings): void {
  if (settings.vibrate) {
    try {
      navigator.vibrate?.(VIBRATIONS[kind])
    } catch {
      // Not allowed here.
    }
  }
  if (settings.sound) beep(kind)
  if (typeof document !== 'undefined' && document.hidden && 'Notification' in window) {
    try {
      if (Notification.permission === 'granted') new Notification('Carmanah Maps navigation', { body: message })
    } catch {
      // Some WebViews have Notification but refuse to construct one.
    }
  }
}

// ---- Keep the screen on while navigating ----

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener?: (t: string, f: () => void) => void }

let wakeWanted = false
let sentinel: WakeLockSentinelLike | null = null

async function acquire() {
  const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } })
    .wakeLock
  if (!wl || sentinel || !wakeWanted || document.hidden) return
  try {
    sentinel = await wl.request('screen')
    sentinel.addEventListener?.('release', () => {
      sentinel = null
    })
    if (!wakeWanted) void releaseNow()
  } catch {
    sentinel = null // refused (battery saver) or unsupported: the screen sleeps as usual
  }
}

async function releaseNow() {
  const s = sentinel
  sentinel = null
  try {
    await s?.release()
  } catch {
    // already released
  }
}

if (typeof document !== 'undefined') {
  // The browser drops the lock when the page is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && wakeWanted) void acquire()
  })
}

/** Hold the screen on (true) or let it sleep again (false). */
export function keepScreenOn(on: boolean): void {
  wakeWanted = on
  if (on) void acquire()
  else void releaseNow()
}
