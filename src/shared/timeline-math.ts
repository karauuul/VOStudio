export interface TimelineView {
  pxPerSec: number
  scroll: number
}

export const MIN_PX_PER_SEC = 2
export const MAX_PX_PER_SEC = 2000

export const SNAP_PX = 6

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function timeToX(view: TimelineView, t: number): number {
  return (t - view.scroll) * view.pxPerSec
}

export function xToTime(view: TimelineView, x: number): number {
  return view.scroll + x / view.pxPerSec
}

export function fitView(duration: number, width: number, pad = 24): TimelineView {
  const w = Math.max(1, width - pad)
  const d = Number.isFinite(duration) && duration > 0 ? duration : 1
  return { pxPerSec: clamp(w / d, MIN_PX_PER_SEC, MAX_PX_PER_SEC), scroll: 0 }
}

export function zoomAt(view: TimelineView, factor: number, anchorX: number): TimelineView {
  const t = xToTime(view, anchorX)
  const pxPerSec = clamp(view.pxPerSec * factor, MIN_PX_PER_SEC, MAX_PX_PER_SEC)
  return { pxPerSec, scroll: t - anchorX / pxPerSec }
}

export function clampView(
  view: TimelineView,
  width: number,
  contentDuration: number,
  tailPad = 40
): TimelineView {
  const pxPerSec = clamp(view.pxPerSec, MIN_PX_PER_SEC, MAX_PX_PER_SEC)
  const visible = Math.max(0, width) / pxPerSec
  const content = Math.max(0, contentDuration) + Math.max(0, tailPad) / pxPerSec
  const max = Math.max(0, content - visible)
  return { pxPerSec, scroll: clamp(view.scroll, 0, max) }
}

export function clampPlayhead(t: number, extent: number): number {
  if (!(t > 0)) return 0
  return extent > 0 && t > extent ? extent : t
}

export type WheelIntent =
  | { kind: 'zoom'; factor: number }
  | { kind: 'scrollX'; seconds: number }
  | { kind: 'scrollY'; pixels: number }

export interface WheelInput {
  deltaX: number
  deltaY: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export function wheelIntent(e: WheelInput, pxPerSec: number): WheelIntent {
  if (e.altKey) return { kind: 'zoom', factor: Math.exp(-e.deltaY * 0.0025) }
  if (e.ctrlKey || e.metaKey) return { kind: 'scrollY', pixels: e.deltaY }
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  return { kind: 'scrollX', seconds: d / Math.max(1e-9, pxPerSec) }
}

export interface MarqueeClip {
  id: string
  start: number
  end: number
  trackId: string
}

export function marqueeHits(
  clips: readonly MarqueeClip[],
  from: number,
  to: number,
  tracks: readonly string[]
): string[] {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  return clips
    .filter((c) => tracks.includes(c.trackId) && c.start < hi && c.end > lo)
    .map((c) => c.id)
}

const STEPS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
]

export function tickStep(pxPerSec: number, minPx = 64): number {
  const need = Math.max(1, minPx) / Math.max(1e-9, pxPerSec)
  for (const s of STEPS) if (s >= need) return s
  return STEPS[STEPS.length - 1]
}

export function ticks(view: TimelineView, width: number, minPx = 64): number[] {
  const step = tickStep(view.pxPerSec, minPx)
  const from = Math.max(0, view.scroll)
  const to = view.scroll + Math.max(0, width) / view.pxPerSec
  const out: number[] = []
  const first = Math.ceil(from / step - 1e-9)
  const last = Math.floor(to / step + 1e-9)
  for (let i = first; i <= last && out.length < 512; i++) out.push(i * step)
  return out
}

export function tickLabel(t: number, step: number): string {
  if (step >= 1) {
    const m = Math.floor(t / 60)
    const s = Math.round(t - m * 60)
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
  }
  const decimals = step >= 0.1 ? 1 : 2
  return t.toFixed(decimals)
}

export function snap(value: number, targets: readonly number[], tol: number): number {
  if (!(tol > 0)) return value
  let best = value
  let bestD = tol
  for (const t of targets) {
    const d = Math.abs(t - value)
    if (d < bestD) {
      bestD = d
      best = t
    }
  }
  return best
}

export function snapDelta(
  edges: readonly number[],
  rawDelta: number,
  targets: readonly number[],
  tol: number
): number {
  if (!(tol > 0)) return rawDelta
  let best = rawDelta
  let bestD = tol
  for (const e of edges) {
    const at = e + rawDelta
    for (const t of targets) {
      const d = Math.abs(t - at)
      if (d < bestD) {
        bestD = d
        best = t - e
      }
    }
  }
  return best
}
