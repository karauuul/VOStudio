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

export function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—'
  return sec.toFixed(2) + 's'
}
