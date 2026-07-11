// Backgrounded/embedded tabs suspend requestAnimationFrame, which stalls
// MapLibre's style load entirely. Race each frame request against a 250ms
// timer so the map keeps working when the tab isn't front-and-center.
// In an active tab the native frame always wins and this is a no-op.
{
  const nativeRaf = window.requestAnimationFrame.bind(window)
  const nativeCancel = window.cancelAnimationFrame.bind(window)
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nativeRaf((t) => {
      clearTimeout(timers.get(id))
      timers.delete(id)
      cb(t)
    })
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        nativeCancel(id)
        cb(performance.now())
      }, 250),
    )
    return id
  }
  window.cancelAnimationFrame = (id: number): void => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    nativeCancel(id)
  }
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
