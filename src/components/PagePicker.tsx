import { useEffect, useMemo, useState } from 'react'
import type { GeoPdfRegion } from '../lib/geopdf'
import type { PagePickRequest } from '../lib/library/import'
import type { ImportStatus } from '../hooks/useMapsLibrary'
import './MapsLibrary.css'

/** List page numbers compactly: "2, 4–9, 12". */
function pageList(pages: number[]): string {
  const out: string[] = []
  for (let i = 0; i < pages.length; i++) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++
    out.push(j > i ? `${pages[i]}–${pages[j]}` : `${pages[i]}`)
    i = j
  }
  return out.join(', ')
}

/**
 * Choose which maps to import from a PDF with more than one (a map book, or a
 * page with an inset). Avenza asks the same on import.
 */
export function PagePicker({
  request,
  onDone,
}: {
  request: PagePickRequest
  onDone: (regions: GeoPdfRegion[] | null) => void
}) {
  const { regions, pageCount, fileName } = request
  const [chosen, setChosen] = useState<Set<GeoPdfRegion>>(() => new Set(regions))
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map())

  const pages = useMemo(() => {
    const byPage = new Map<number, GeoPdfRegion[]>()
    for (const r of regions) byPage.set(r.pageIndex, [...(byPage.get(r.pageIndex) ?? []), r])
    return [...byPage.entries()].sort(([a], [b]) => a - b)
  }, [regions])

  const plainPages = useMemo(() => {
    const geo = new Set(regions.map((r) => r.pageIndex))
    const out: number[] = []
    for (let p = 0; p < pageCount; p++) if (!geo.has(p)) out.push(p + 1)
    return out
  }, [regions, pageCount])

  // Draw page thumbnails one at a time, in page order; stop when closed.
  useEffect(() => {
    let live = true
    const urls: string[] = []
    ;(async () => {
      for (const [pageIndex] of pages) {
        if (!live) return
        try {
          const blob = await request.pageThumbnail(pageIndex)
          if (!live) return
          const url = URL.createObjectURL(blob)
          urls.push(url)
          setThumbs((prev) => new Map(prev).set(pageIndex, url))
        } catch {
          // No thumbnail for this page; the list still works.
        }
      }
    })()
    return () => {
      live = false
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [pages, request])

  const toggle = (r: GeoPdfRegion) =>
    setChosen((prev) => {
      const next = new Set(prev)
      if (next.has(r)) next.delete(r)
      else next.add(r)
      return next
    })

  const allChosen = chosen.size === regions.length
  return (
    <div className="sheet-wrap">
      <div className="sheet-backdrop" onClick={() => onDone(null)} />
      <div className="layer-panel page-picker" role="dialog" aria-label="Choose maps to import">
        <div className="panel-header">
          <span>Choose maps to import</span>
          <button className="panel-close" onClick={() => onDone(null)} aria-label="Cancel import">
            ✕
          </button>
        </div>
        <div className="maps-note">
          {fileName} has {regions.length} maps on {pages.length} of its {pageCount} pages.
        </div>
        <div className="page-grid">
          {pages.map(([pageIndex, frames]) =>
            frames.map((r, i) => (
              <label key={`${pageIndex}-${i}`} className={`page-card${chosen.has(r) ? ' chosen' : ''}`}>
                <input type="checkbox" checked={chosen.has(r)} onChange={() => toggle(r)} />
                <span className="page-thumb">
                  {thumbs.get(pageIndex) ? <img src={thumbs.get(pageIndex)} alt="" /> : <span className="page-wait" />}
                </span>
                <span className="page-label">
                  Page {pageIndex + 1}
                  {frames.length > 1 && ` · map ${i + 1} of ${frames.length}`}
                </span>
              </label>
            )),
          )}
        </div>
        {plainPages.length > 0 && (
          <div className="maps-note">
            {plainPages.length === 1 ? 'Page' : 'Pages'} {pageList(plainPages)}{' '}
            {plainPages.length === 1 ? 'has' : 'have'} no map coordinates, so {plainPages.length === 1 ? "it isn't" : "they aren't"} listed.
          </div>
        )}
        <div className="page-picker-actions">
          <button className="btn small" onClick={() => setChosen(allChosen ? new Set() : new Set(regions))}>
            {allChosen ? 'Select none' : 'Select all'}
          </button>
          <button className="btn small" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button
            className="btn small primary"
            disabled={!chosen.size}
            onClick={() => onDone(regions.filter((r) => chosen.has(r)))}
          >
            Import {chosen.size} {chosen.size === 1 ? 'map' : 'maps'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Import progress with a way out. */
export function ImportChip({ status }: { status: ImportStatus }) {
  return (
    <div className="import-chip" role="status">
      <div className="import-chip-text">
        <span className="import-file">{status.fileName}</span>
        <span className="import-step">{status.label}…</span>
        <span className="import-bar" aria-hidden>
          <span style={{ width: `${Math.round(status.fraction * 100)}%` }} />
        </span>
      </div>
      <button className="btn small" onClick={status.cancel}>
        Cancel
      </button>
    </div>
  )
}
