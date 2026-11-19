import type { GeolocateControl, IControl, Map as MlMap } from 'maplibre-gl'
import {
  getHeading,
  getMapOrientation,
  headingWanted,
  requestCompass,
  setDeclinationFallback,
  setMapOrientation,
  subscribeHeading,
  subscribeHeadingWanted,
  subscribeMapOrientation,
  type HeadingState,
} from '../lib/compass'
import { angleDelta, coneHalfAngle, compassTap } from '../lib/heading'

/**
 * The map's compass button, in place of MapLibre's: the needle always
 * points to north on screen, and a tap switches north-up ↔ course-up
 * (heading-up), like Avenza's compass button. A turned or tilted map is
 * straightened first. Course-up turns the map so the way you face (the
 * compass, else your GPS course while moving) is up, and switches on the
 * location dot if it's off.
 *
 * It also draws the heading cone on MapLibre's location dot while the
 * dot shows, in course-up, or while navigating (compass.ts
 * setHeadingWanted). Button: 48 px, for gloves.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Map rotation in course-up: at most this often, ms, and only for turns bigger than this. */
const ROTATE_EVERY_MS = 80
const ROTATE_MIN_DEG = 1

type Notify = (message: string, isError?: boolean) => void

export class CompassControl implements IControl {
  private map: MlMap | null = null
  private container: HTMLDivElement | null = null
  private button: HTMLButtonElement | null = null
  private needle: SVGGElement | null = null
  private cone: HTMLDivElement | null = null
  private conePath: SVGPathElement | null = null
  private unsubs: (() => void)[] = []
  private stopHeading: (() => void) | null = null
  private heading: HeadingState = getHeading()
  /** Location dot showing (MapLibre's GeolocateControl is on). */
  private dotOn = false
  private tracking = false
  private lastRotate = 0
  private frame = 0
  private explained = false

  constructor(
    private readonly geolocate: GeolocateControl | null,
    private readonly notify: Notify,
  ) {}

  onAdd(map: MlMap): HTMLElement {
    this.map = map
    const container = document.createElement('div')
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group compass-ctrl'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'compass-btn'
    button.appendChild(this.buildRose())
    const label = document.createElement('span')
    label.className = 'compass-mode'
    button.appendChild(label)
    button.addEventListener('click', this.onClick)
    container.appendChild(button)
    this.container = container
    this.button = button

    map.on('rotate', this.onRotate)
    map.on('pitch', this.onRotate)
    map.on('moveend', this.onMoveEnd)
    this.unsubs.push(subscribeMapOrientation(this.sync), subscribeHeadingWanted(this.sync))
    if (this.geolocate) {
      this.geolocate.on('geolocate', this.onGeolocate)
      this.geolocate.on('trackuserlocationstart', this.onTrackStart)
      this.geolocate.on('trackuserlocationend', this.onTrackEnd)
      this.geolocate.on('error', this.onTrackEnd)
    }
    this.onMoveEnd()
    this.sync()
    this.onRotate()
    return container
  }

  onRemove(): void {
    const map = this.map
    if (map) {
      map.off('rotate', this.onRotate)
      map.off('pitch', this.onRotate)
      map.off('moveend', this.onMoveEnd)
    }
    if (this.geolocate) {
      this.geolocate.off('geolocate', this.onGeolocate)
      this.geolocate.off('trackuserlocationstart', this.onTrackStart)
      this.geolocate.off('trackuserlocationend', this.onTrackEnd)
      this.geolocate.off('error', this.onTrackEnd)
    }
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.stopHeading?.()
    this.stopHeading = null
    cancelAnimationFrame(this.frame)
    this.cone?.remove()
    this.container?.remove()
    this.allowRotateGestures(true)
    this.map = null
  }

  private buildRose(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '-24 -24 48 48')
    svg.setAttribute('aria-hidden', 'true')
    const g = document.createElementNS(SVG_NS, 'g')
    g.innerHTML =
      '<circle r="21" class="compass-ring"/>' +
      '<path d="M0 -17 L6 0 L-6 0 Z" class="compass-north"/>' +
      '<path d="M0 17 L6 0 L-6 0 Z" class="compass-south"/>' +
      '<text y="-10.5" class="compass-n">N</text>'
    svg.appendChild(g)
    this.needle = g
    return svg
  }

  private onClick = () => {
    const map = this.map
    if (!map) return
    const { mode, resetNorth } = compassTap(getMapOrientation(), map.getBearing(), map.getPitch())
    if (mode === 'course') {
      // Straight from the tap, so iOS shows its prompt.
      void requestCompass().then((ok) => {
        if (!ok && !this.explained) {
          this.explained = true
          this.notify('No compass access: course-up follows your direction of travel (GPS) while you move.')
        }
      })
      if (!this.dotOn && !this.tracking) this.geolocate?.trigger()
      setMapOrientation('course')
      return
    }
    setMapOrientation('north')
    if (resetNorth) map.easeTo({ bearing: 0, pitch: 0, duration: 300 })
  }

  /** Mode or wanted-ness changed: subscribe, gestures, button look. */
  private sync = () => {
    const course = getMapOrientation() === 'course'
    const want = course || this.dotOn || headingWanted()
    if (want && !this.stopHeading) {
      this.stopHeading = subscribeHeading((h) => {
        this.heading = h
        this.schedule()
      })
    } else if (!want && this.stopHeading) {
      this.stopHeading()
      this.stopHeading = null
      this.heading = getHeading()
    }
    this.allowRotateGestures(!course)
    if (this.button) {
      this.button.classList.toggle('course-up', course)
      this.button.setAttribute('aria-pressed', String(course))
      const title = course ? 'Course up: tap for north up' : 'North up: tap for course up'
      this.button.title = title
      this.button.setAttribute('aria-label', title)
      const label = this.button.querySelector('.compass-mode')
      if (label) label.textContent = course ? 'C↑' : ''
    }
    this.schedule()
  }

  /** In course-up your own turns would fight the compass, so they're off. */
  private allowRotateGestures(on: boolean) {
    const map = this.map
    if (!map) return
    if (on) {
      map.dragRotate.enable()
      map.touchZoomRotate.enableRotation()
      map.keyboard.enableRotation()
    } else {
      map.dragRotate.disable()
      map.touchZoomRotate.disableRotation()
      map.keyboard.disableRotation()
    }
  }

  private schedule() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.update()
    })
  }

  private update() {
    const map = this.map
    if (!map) return
    const h = this.heading.heading
    if (getMapOrientation() === 'course' && h != null) {
      // Ease the camera round (half the gap at a time, the last degree or
      // two at once); wait while something else moves the map (your pan,
      // the location dot's follow). Stops once within a degree.
      const now = performance.now()
      const off = angleDelta(map.getBearing(), h)
      if (Math.abs(off) >= ROTATE_MIN_DEG) {
        if (!map.isMoving() && now - this.lastRotate >= ROTATE_EVERY_MS) {
          this.lastRotate = now
          const step = Math.abs(off) > 2 * ROTATE_MIN_DEG ? off / 2 : off
          // Marked as the location control's own move, so it keeps following.
          map.jumpTo({ bearing: map.getBearing() + step }, { geolocateSource: true })
        }
        this.schedule()
      }
    }
    this.drawCone()
  }

  private onRotate = () => {
    const map = this.map
    if (!map || !this.needle) return
    this.needle.setAttribute('transform', `rotate(${-map.getBearing()})`)
    this.button?.classList.toggle('turned', Math.abs(angleDelta(0, map.getBearing())) > 0.5 || map.getPitch() > 0.5)
    this.drawCone()
  }

  private onMoveEnd = () => {
    const c = this.map?.getCenter()
    if (c) setDeclinationFallback([c.lng, c.lat])
  }

  private onGeolocate = () => {
    if (!this.dotOn) {
      this.dotOn = true
      this.sync()
    }
    this.drawCone()
  }

  private onTrackStart = () => {
    this.tracking = true
  }

  private onTrackEnd = () => {
    this.tracking = false
    // The dot goes when the control is switched off (after this event).
    setTimeout(() => {
      const on = !!this.dotElement()
      if (on !== this.dotOn) {
        this.dotOn = on
        if (!on) this.cone?.remove()
        this.sync()
      }
    }, 0)
  }

  private dotElement(): HTMLElement | null {
    return this.map?.getContainer().querySelector<HTMLElement>('.maplibregl-user-location-dot') ?? null
  }

  /** The cone lives inside MapLibre's dot, so it sits exactly on it. */
  private drawCone() {
    const map = this.map
    const h = this.heading.heading
    const dot = this.dotElement()
    const wanted = !!this.stopHeading
    if (!map || !dot || h == null || !wanted) {
      if (this.cone) this.cone.style.display = 'none'
      return
    }
    if (!this.cone) this.cone = this.buildCone()
    if (this.cone.parentElement !== dot) dot.appendChild(this.cone)
    this.cone.style.display = ''
    this.cone.dataset.source = this.heading.source ?? ''
    this.cone.style.transform = `rotate(${h - map.getBearing()}deg)`
    const half = coneHalfAngle(this.heading.accuracy, this.heading.source ?? 'compass')
    this.conePath?.setAttribute('d', sectorPath(half))
  }

  private buildCone(): HTMLDivElement {
    const div = document.createElement('div')
    div.className = 'heading-cone'
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '-50 -50 100 100')
    svg.innerHTML =
      '<defs><radialGradient id="heading-cone-fill" cx="0" cy="0" r="50" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="#1da1f2" stop-opacity="0.75"/>' +
      '<stop offset="1" stop-color="#1da1f2" stop-opacity="0"/></radialGradient></defs>' +
      '<path fill="url(#heading-cone-fill)"/>'
    this.conePath = svg.querySelector('path')
    div.appendChild(svg)
    return div
  }
}

/** A pie slice pointing up, half-angle `half` degrees, radius 50. */
function sectorPath(half: number): string {
  const r = 50
  const a = (half * Math.PI) / 180
  const x = (r * Math.sin(a)).toFixed(2)
  const y = (-r * Math.cos(a)).toFixed(2)
  return `M0 0 L-${x} ${y} A${r} ${r} 0 0 1 ${x} ${y} Z`
}
