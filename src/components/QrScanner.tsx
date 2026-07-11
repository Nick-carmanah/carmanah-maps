import { useEffect, useRef } from 'react'
import jsQR from 'jsqr'

interface QrScannerProps {
  onResult: (text: string) => void
  onClose: () => void
  onError: (message: string) => void
}

/**
 * Full-screen camera QR scanner. Scans the per-fire QR codes (which encode a
 * URL to the fire's KML) and hands the decoded URL to onResult.
 */
export default function QrScanner({ onResult, onClose, onError }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const callbacksRef = useRef({ onResult, onClose, onError })
  callbacksRef.current = { onResult, onClose, onError }

  useEffect(() => {
    let stream: MediaStream | null = null
    let rafId = 0
    let stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    const tick = () => {
      if (stopped) return
      const video = videoRef.current
      if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(image.data, image.width, image.height, {
          inversionAttempts: 'dontInvert',
        })
        if (code?.data) {
          stopped = true
          callbacksRef.current.onResult(code.data)
          return
        }
      }
      rafId = requestAnimationFrame(tick)
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const video = videoRef.current
        if (video) {
          video.srcObject = s
          video.play().catch(() => {})
          rafId = requestAnimationFrame(tick)
        }
      })
      .catch(() => {
        callbacksRef.current.onError(
          'Camera unavailable — check camera permissions for this site.',
        )
        callbacksRef.current.onClose()
      })

    return () => {
      stopped = true
      cancelAnimationFrame(rafId)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="scanner-overlay">
      <video ref={videoRef} muted playsInline />
      <div className="scanner-hint">Point at a fire's QR code to load its map</div>
      <div className="scanner-frame" />
      <button className="btn scanner-close" onClick={onClose}>
        Cancel
      </button>
    </div>
  )
}
