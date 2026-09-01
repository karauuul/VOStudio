import { useEffect, useRef, type RefObject } from 'react'
import { audioUrl } from './api'
import { Lru } from './audio/lru'
import { transport } from './audio/transport'

export interface Peaks {
  min: Float32Array
  max: Float32Array
  duration: number
}

const BUCKETS = 1024
const peakCache = new Lru<Promise<Peaks>>({ maxEntries: 256 })

function computePeaks(audio: AudioBuffer): Peaks {
  const d = audio.getChannelData(0)
  const step = Math.max(1, Math.floor(d.length / BUCKETS))
  const n = Math.max(1, Math.floor(d.length / step))
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let mn = 1
    let mx = -1
    const base = i * step
    for (let j = 0; j < step; j++) {
      const v = d[base + j] ?? 0
      if (v < mn) mn = v
      if (v > mx) mx = v
    }
    min[i] = mn
    max[i] = mx
  }
  return { min, max, duration: audio.duration }
}

export function getPeaks(absPath: string): Promise<Peaks> {
  const url = audioUrl(absPath)
  const hit = peakCache.get(url)
  if (hit) return hit
  const p = transport.getBuffer(url).then(computePeaks)
  peakCache.set(url, p)
  void p.catch(() => peakCache.delete(url))
  return p
}

function drawPeaks(c: HTMLCanvasElement, peaks: Peaks | null, color: string): void {
  const cx = c.getContext('2d')
  if (!cx) return
  const dpr = window.devicePixelRatio || 1
  const W = (c.width = Math.max(1, Math.round(c.offsetWidth * dpr)))
  const H = (c.height = Math.max(1, Math.round(c.offsetHeight * dpr)))
  cx.clearRect(0, 0, W, H)
  const mid = H / 2
  if (!peaks) {
    cx.fillStyle = 'rgba(95,95,107,0.5)'
    cx.fillRect(0, mid, W, Math.max(1, dpr))
    return
  }
  const n = peaks.min.length
  cx.fillStyle = color
  const w = Math.max(1, Math.round(dpr))
  for (let x = 0; x < W; x += w) {
    const i = Math.min(n - 1, Math.floor((x * n) / W))
    const top = mid - peaks.max[i] * mid * 0.92
    const bot = mid - peaks.min[i] * mid * 0.92
    cx.fillRect(x, Math.min(top, bot), w, Math.max(w, Math.abs(bot - top)))
  }
}

function usePeakCanvas(
  absPath: string,
  color: string,
  onDuration?: (d: number) => void
): RefObject<HTMLCanvasElement> {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const peaksRef = useRef<Peaks | null>(null)
  const cbRef = useRef(onDuration)
  cbRef.current = onDuration

  useEffect(() => {
    let cancelled = false
    peaksRef.current = null
    const redraw = (): void => {
      if (canvasRef.current) drawPeaks(canvasRef.current, peaksRef.current, color)
    }
    redraw()
    void getPeaks(absPath)
      .then((p) => {
        if (cancelled) return
        peaksRef.current = p
        redraw()
        cbRef.current?.(p.duration)
      })
      .catch(() => {})
    const ro = new ResizeObserver(redraw)
    if (canvasRef.current) ro.observe(canvasRef.current)
    return () => {
      cancelled = true
      ro.disconnect()
    }
  }, [absPath, color])

  return canvasRef
}

export function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  return sec.toFixed(2) + 's'
}

export interface WaveformHandle {
  toggle: () => void
  play: () => void
  pause: () => void
}

export function MiniWave({
  absPath,
  color,
  onDuration,
}: {
  absPath: string
  color: string
  onDuration?: (d: number) => void
}) {
  const canvasRef = usePeakCanvas(absPath, color, onDuration)
  return <canvas ref={canvasRef} />
}
