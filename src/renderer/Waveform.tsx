import { memo, useEffect, useRef } from 'react'
import type { TakeKind } from '@shared/domain'
import { LoadQueue } from '@shared/load-queue'
import { audioUrl } from './api'
import { Lru } from './audio/lru'
import { transport } from './audio/transport'
import { drawWave } from './cue/timeline-draw'

export interface Peaks {
  min: Float32Array
  max: Float32Array
  duration: number
}

const BUCKETS = 1024
const BUCKETS_PER_SECOND = 100
const PEAK_DECODES = 4
const BACKGROUND = 0
const FOREGROUND = 1
const peakCache = new Lru<Peaks>({ maxEntries: 256 })

function computePeaks(audio: AudioBuffer): Peaks {
  const d = audio.getChannelData(0)
  const buckets = Math.max(BUCKETS, Math.ceil(audio.duration * BUCKETS_PER_SECOND))
  const step = Math.max(1, Math.floor(d.length / buckets))
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

const peakQueue = new LoadQueue<Peaks>(PEAK_DECODES, (url, priority) =>
  transport.getBuffer(url, priority > BACKGROUND).then((audio) => {
    const peaks = computePeaks(audio)
    peakCache.set(url, peaks)
    return peaks
  })
)

export function cachedPeaks(absPath: string): Peaks | null {
  return peakCache.get(audioUrl(absPath)) ?? null
}

export function getPeaks(
  absPath: string,
  { background = false, signal }: { background?: boolean; signal?: AbortSignal } = {}
): Promise<Peaks> {
  const url = audioUrl(absPath)
  const hit = peakCache.get(url)
  if (hit) return Promise.resolve(hit)
  return peakQueue.load(url, { priority: background ? BACKGROUND : FOREGROUND, signal })
}

export const GENERATED_COLOR = '#3fb8a8'
export const RECORDED_COLOR = '#a58cf0'
export const IMPORTED_COLOR = '#8f97a8'

export function sourceColor(kind: TakeKind): string {
  if (kind === 'recording') return RECORDED_COLOR
  if (kind === 'imported') return IMPORTED_COLOR
  return GENERATED_COLOR
}

export const Wave = memo(function Wave({
  peaks,
  from,
  to,
  color,
}: {
  peaks: Peaks | null
  from: number
  to: number
  color: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const resize = new ResizeObserver(() => drawWave(canvas, peaks, from, to, color))
    resize.observe(canvas, { box: 'device-pixel-content-box' })
    return () => resize.disconnect()
  }, [peaks, from, to, color])
  return <canvas ref={ref} />
})

export function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  return sec.toFixed(2) + 's'
}
