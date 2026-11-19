import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Map as MlMap, MapMouseEvent } from 'maplibre-gl'
import type { Position } from 'geojson'
import NavPanel from '../components/NavPanel'
import NavSheet from '../components/NavSheet'
import RoutePanel from '../components/RoutePanel'
import ProjectSheet, { type ProjectOrigin, type ProjectedPoint } from '../components/ProjectSheet'
import { useNavSettings } from '../components/NavigationSettings'
import '../components/navigation.css'
import type { UserFeature } from '../lib/features'
import {
  navTargetPosition,
  newSession,
  nextWaypointName,
  routeLengthM,
  sanitizeSession,
  sanitizeWaypoints,
  stepSession,
  waypointPositions,
  waypointsFromLine,
  type NavEvent,
  type NavSession,
  type Waypoint,
} from '../lib/navigation'
import { lastFix } from '../lib/position'
import { requestCompass, setHeadingWanted } from '../lib/compass'
import { keepScreenOn, primeAlerts, signalAlert } from '../lib/nav-alerts'
import { getNavSettings } from '../lib/nav-settings'
import { readOwnerPref, writeOwnerPref } from '../lib/storage/prefs'
import { formatDistance } from '../lib/units'
import { drawNav, removeNav, type NavDrawing } from '../map/nav-layers'
import { useNavigation } from './useNavigation'
import type { ToolEntry } from './useGpsTools'

export interface NavToolsDeps {
  map: MlMap | null
  features: UserFeature[]
  hiddenLayerIds: Set<string>
  /** Save a placemark or line the normal way (naming, layer style, opens its sheet). */
  createFeature: (
    kind: 'pin' | 'line',
    coordinates: Position | Position[],
    notes: string,
    opts: { label: string; layer?: string },
  ) => void
  notify: (message: string, isError?: boolean) => void
  /** Leave pin/measure modes before a tool takes over. */
  onBeforeTool: () => void
  /** Close the feature sheet (its navigation buttons were used). */
  onCloseFeature: () => void
}

/** Per person, like the units: the route being navigated survives the app being closed. */
const SESSION_PREF = 'nav-session'
const DRAFT_PREF = 'nav-route-draft'
/** Map taps within this many pixels of a placemark pick the placemark (gloves). */
const TAP_SLOP_PX = 20
/** The map's placemark layers (MapView: plain dots and symbols). */
const PIN_LAYERS = ['uf-pts', 'uf-sym']

const newId = () => crypto.randomUUID()

function readJson(name: string): unknown {
  const raw = readOwnerPref(name)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Navigation, Avenza-style: go to a point, a placemark or the crosshair;
 * plan a route and follow it leg by leg (advancing on arrival); project a
 * point by bearing and distance; arrival and approach alerts. Returns the
 * Tools entry, what it renders, the "you → target" line for MapView, and
 * the hooks App wires into the feature sheet and map taps, so App only
 * lists them.
 */
export function useNavTools(deps: NavToolsDeps) {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const { map, features, hiddenLayerIds } = deps
  const settings = useNavSettings()

  const [session, setSessionState] = useState<NavSession | null>(() => sanitizeSession(readJson(SESSION_PREF)))
  const [draft, setDraftState] = useState<Waypoint[]>(() => sanitizeWaypoints(readJson(DRAFT_PREF)))
  const [open, setOpen] = useState<'hub' | 'route' | 'project' | null>(null)
  const [projectOrigin, setProjectOrigin] = useState<ProjectOrigin>({ kind: 'gps' })
  const [preview, setPreview] = useState<{ from: Position; to: Position } | null>(null)
  /** The route panel is editing the route being navigated. */
  const [editingActive, setEditingActive] = useState(false)
  const [mapBearing, setMapBearing] = useState(0)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const sessionRef = useRef(session)
  sessionRef.current = session

  const setSession = useCallback((next: NavSession | null) => {
    sessionRef.current = next
    setSessionState(next)
    writeOwnerPref(SESSION_PREF, JSON.stringify(next))
  }, [])
  const setDraft = useCallback((next: Waypoint[]) => {
    draftRef.current = next
    setDraftState(next)
    writeOwnerPref(DRAFT_PREF, JSON.stringify(next))
  }, [])

  // Resumed after the app was closed mid-route: say so once.
  useEffect(() => {
    const s = sessionRef.current
    if (s && !s.finished) depsRef.current.notify(`Still navigating to ${s.waypoints[s.index]?.name ?? 'your target'}`)
  }, [])

  const handleAdvance = useCallback(
    (next: NavSession, events: NavEvent[]) => {
      setSession(next)
      const s = getNavSettings()
      const route = next.waypoints.length > 1
      for (const e of events) {
        const message =
          e.type === 'approach'
            ? `Approaching ${e.name}: ${formatDistance(e.distanceM)}`
            : e.type === 'finish'
              ? `✓ Arrived at ${e.name}${route ? ': end of the route' : ''}`
              : e.nextName
                ? `✓ ${e.name} reached. Next: ${e.nextName}`
                : `✓ ${e.name} reached. Tap Skip for the next point.`
        depsRef.current.notify(message)
        signalAlert(e.type, message, s)
      }
    },
    [setSession],
  )

  const readout = useNavigation(
    session,
    features,
    { arrivalRadiusM: settings.arrivalRadiusM, approachM: settings.approachM, autoAdvance: settings.autoAdvance },
    handleAdvance,
    deps.notify,
  )

  const navigating = session != null && !session.finished
  useEffect(() => {
    setHeadingWanted('nav', navigating)
    return () => setHeadingWanted('nav', false)
  }, [navigating])
  useEffect(() => {
    keepScreenOn(navigating && settings.keepScreenOn)
    return () => keepScreenOn(false)
  }, [navigating, settings.keepScreenOn])

  // The arrow in the readout is drawn relative to the map's turn.
  useEffect(() => {
    if (!map) return
    const onRotate = () => setMapBearing(map.getBearing())
    onRotate()
    map.on('rotate', onRotate)
    return () => {
      map.off('rotate', onRotate)
    }
  }, [map])

  /** Start navigating (from a tap: unlocks sound and asks for the compass). */
  const start = useCallback(
    (waypoints: Waypoint[], name?: string, keepIndex = false) => {
      if (!waypoints.length) return
      primeAlerts()
      void requestCompass()
      const prev = sessionRef.current
      const s = newSession(waypoints, name)
      if (keepIndex && prev) s.index = Math.min(prev.index, waypoints.length - 1)
      setSession(s)
      setOpen(null)
      setEditingActive(false)
      depsRef.current.onBeforeTool()
      depsRef.current.notify(
        waypoints.length > 1
          ? `Route: ${waypoints.length} points, ${formatDistance(routeLengthM(waypointPositions(waypoints, depsRef.current.features)))}`
          : `Navigating to ${waypoints[0].name}`,
      )
    },
    [setSession],
  )

  const crosshair = useCallback((): Position | null => {
    const c = depsRef.current.map?.getCenter()
    return c ? [c.lng, c.lat] : null
  }, [])
  const here = (): Position | null => {
    const f = lastFix()
    return f ? [f.lng, f.lat] : null
  }

  const featureWaypoint = (f: UserFeature): Waypoint => ({
    id: newId(),
    name: f.name || 'Placemark',
    position: navTargetPosition(f),
    featureId: f.id,
  })

  const goToFeature = useCallback(
    (id: string) => {
      const f = depsRef.current.features.find((x) => x.id === id)
      if (f) start([featureWaypoint(f)])
    },
    [start],
  )

  const followLine = useCallback(
    (f: UserFeature) => {
      const wps = waypointsFromLine(f, newId)
      if (wps.length) start(wps, f.name)
    },
    [start],
  )

  const addToDraft = useCallback(
    (wp: Omit<Waypoint, 'id' | 'name'> & { name?: string }) => {
      const cur = draftRef.current
      setDraft([...cur, { id: newId(), name: wp.name || nextWaypointName(cur), position: wp.position, ...(wp.featureId ? { featureId: wp.featureId } : {}) }])
    },
    [setDraft],
  )

  // Planning a route: taps on the map add points (a placemark when one is
  // under the finger, else the spot tapped). MapView's own tap handling is
  // told to stand aside through onFeatureTap.
  useEffect(() => {
    if (!map || open !== 'route') return
    const onClick = (e: MapMouseEvent) => {
      const { x, y } = e.point
      const layers = PIN_LAYERS.filter((id) => map.getLayer(id))
      const hits = layers.length
        ? map.queryRenderedFeatures(
            [
              [x - TAP_SLOP_PX, y - TAP_SLOP_PX],
              [x + TAP_SLOP_PX, y + TAP_SLOP_PX],
            ],
            { layers },
          )
        : []
      let best: { id: string; d: number } | null = null
      for (const h of hits) {
        const id = String(h.properties?.id ?? '')
        if (!id || h.geometry.type !== 'Point') continue
        const p = map.project(h.geometry.coordinates as [number, number])
        const d = Math.hypot(p.x - x, p.y - y)
        if (!best || d < best.d) best = { id, d }
      }
      const f = best ? depsRef.current.features.find((x) => x.id === best.id) : undefined
      if (f) addToDraft({ name: f.name || 'Placemark', position: navTargetPosition(f), featureId: f.id })
      else addToDraft({ position: [e.lngLat.lng, e.lngLat.lat] })
    }
    map.on('click', onClick)
    const dbl = map.doubleClickZoom.isEnabled()
    map.doubleClickZoom.disable()
    return () => {
      map.off('click', onClick)
      if (dbl) map.doubleClickZoom.enable()
    }
  }, [map, open, addToDraft])

  const [youLng, youLat] = readout.position ?? [null, null]
  // What navigation draws: the plan while planning, else the route being
  // followed with its arrival ring; plus the projection preview.
  const drawing = useMemo((): NavDrawing | null => {
    const d: NavDrawing = {}
    if (open === 'route') {
      d.waypoints = waypointPositions(draft, features).map((position, i) => ({ position, state: 'next', label: String(i + 1) }))
      d.legs = true
    } else if (session) {
      const pts = waypointPositions(session.waypoints, features)
      const route = pts.length > 1
      d.waypoints = pts.map((position, i) => ({
        position,
        state: i < session.index || (session.finished && i === session.index) ? 'done' : i === session.index ? 'current' : 'next',
        label: route ? String(i + 1) : '',
      }))
      d.legs = route
      if (!session.finished) d.ring = { center: pts[session.index], radiusM: settings.arrivalRadiusM }
      d.you = youLng != null && youLat != null ? [youLng, youLat] : null
    }
    if (open === 'project' && preview) d.projection = preview
    return d.waypoints?.length || d.projection ? d : null
  }, [open, draft, session, features, preview, settings.arrivalRadiusM, youLng, youLat])

  useEffect(() => {
    if (!map) return
    if (drawNav(map, drawing)) return
    // Style still loading: draw once it's there.
    const retry = () => drawNav(map, drawing)
    map.once('load', retry)
    return () => {
      map.off('load', retry)
    }
  }, [map, drawing])
  useEffect(() => {
    if (!map) return
    return () => removeNav(map)
  }, [map])

  const end = useCallback(() => {
    setSession(null)
    setOpen((o) => (o === 'hub' ? null : o))
  }, [setSession])

  const openRoute = useCallback(
    (seed?: Waypoint[]) => {
      depsRef.current.onBeforeTool()
      if (seed) setDraft(seed)
      setOpen('route')
    },
    [setDraft],
  )

  const projectFrom = useCallback((origin: ProjectOrigin) => {
    depsRef.current.onBeforeTool()
    setProjectOrigin(origin)
    setPreview(null)
    setOpen('project')
  }, [])

  const tools: ToolEntry[] = [
    {
      icon: '🚩',
      label: navigating ? 'Navigate (navigating now)' : 'Navigate: go to, routes, project a point',
      action: () => {
        deps.onBeforeTool()
        setOpen('hub')
      },
    },
  ]

  /** Navigation buttons for a feature's sheet. */
  const featureActions = (feature: UserFeature): ReactNode => (
    <div className="sheet-row nav-feature-actions">
      <button
        className="btn"
        onClick={() => {
          deps.onCloseFeature()
          addToDraft({ name: feature.name || 'Placemark', position: navTargetPosition(feature), featureId: feature.id })
          openRoute()
        }}
      >
        ＋ Add to route
      </button>
      <button
        className="btn"
        onClick={() => {
          deps.onCloseFeature()
          projectFrom({ kind: 'feature', featureId: feature.id })
        }}
      >
        📐 Project from here
      </button>
      {feature.kind === 'line' && (
        <button
          className="btn"
          onClick={() => {
            deps.onCloseFeature()
            followLine(feature)
          }}
        >
          ↝ Follow line
        </button>
      )}
    </div>
  )

  const savePoint = (p: ProjectedPoint) => {
    setOpen(null)
    deps.createFeature('pin', p.position, `Projected ${p.description}`, { label: 'Projected' })
  }

  const fromForLists = here() ?? crosshair()

  const view = (
    <>
      {session && (
        <NavPanel
          session={session}
          readout={readout}
          mapBearing={mapBearing}
          arrivalRadiusM={settings.arrivalRadiusM}
          onBack={() => setSession(stepSession(session, -1))}
          onSkip={() => setSession(stepSession(session, 1))}
          onEditRoute={() => {
            setEditingActive(true)
            openRoute(session.waypoints.map((w) => ({ ...w })))
          }}
          onEnd={end}
        />
      )}
      {open === 'hub' && (
        <NavSheet
          features={features}
          hiddenLayerIds={hiddenLayerIds}
          crosshair={crosshair()}
          from={fromForLists}
          navigating={session != null}
          draftCount={draft.length}
          onGoCrosshair={() => {
            const c = crosshair()
            if (c) start([{ id: newId(), name: 'Crosshair point', position: c }])
          }}
          onGoFeature={(f) => start([featureWaypoint(f)])}
          onFollowLine={followLine}
          onPlanRoute={() => {
            setEditingActive(false)
            openRoute()
          }}
          onProject={() => projectFrom({ kind: 'gps' })}
          onEnd={end}
          onClose={() => setOpen(null)}
        />
      )}
      {open === 'route' && (
        <RoutePanel
          waypoints={draft}
          features={features}
          hiddenLayerIds={hiddenLayerIds}
          from={fromForLists}
          resuming={editingActive && session != null}
          onChange={setDraft}
          onAddCrosshair={() => {
            const c = crosshair()
            if (c) addToDraft({ position: c })
          }}
          onAddMyPosition={(p) => addToDraft({ name: 'My position', position: p })}
          onAddFeature={(f) => addToDraft({ name: f.name || 'Placemark', position: navTargetPosition(f), featureId: f.id })}
          onSaveLine={() => {
            const pts = waypointPositions(draft, features)
            setOpen(null)
            deps.createFeature('line', pts, `Route · ${pts.length} points · ${formatDistance(routeLengthM(pts))}`, {
              label: 'Route',
              layer: 'Routes',
            })
          }}
          onStart={() => start(draft.map((w) => ({ ...w })), 'Route', editingActive)}
          onClose={() => {
            setOpen(null)
            setEditingActive(false)
          }}
        />
      )}
      {open === 'project' && (
        <ProjectSheet
          map={map}
          features={features}
          hiddenLayerIds={hiddenLayerIds}
          initialOrigin={projectOrigin}
          canAddToRoute
          onPreview={setPreview}
          onSave={savePoint}
          onGo={(p) => start([{ id: newId(), name: 'Projected point', position: p.position }])}
          onAddToRoute={(p) => {
            addToDraft({ name: nextWaypointName(draftRef.current), position: p.position })
            openRoute()
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )

  const navLine: [Position, Position] | null =
    session && !session.finished && readout.position && readout.target ? [readout.position, readout.target] : null

  return {
    tools,
    view,
    navLine,
    goToFeature,
    /** True while planning a route: the map tap was a route point, not "open this feature". */
    onFeatureTap: (_id: string) => open === 'route',
    featureActions,
    /** Route planning owns map taps (gate other tap tools, e.g. long-press editing, on this). */
    ownsMapTaps: open === 'route',
  }
}
