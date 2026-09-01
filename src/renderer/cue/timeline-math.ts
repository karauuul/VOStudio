export interface TimelineView {
  pxPerSec: number
  scroll: number
}

export const MIN_PX_PER_SEC = 2
export const MAX_PX_PER_SEC = 2000

export const EDGE_PX = 6
export const HANDLE_PX = 9
export const FADE_ZONE_PX = 12
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

export interface SnapClip {
  id: string
  start: number
  end: number
}

export function snapTargets(
  clips: readonly SnapClip[],
  excludeId: string | null,
  extra: readonly number[] = []
): number[] {
  const out: number[] = [0]
  for (const c of clips) {
    if (c.id === excludeId) continue
    out.push(c.start, c.end)
  }
  for (const e of extra) if (Number.isFinite(e) && e >= 0) out.push(e)
  return [...new Set(out)].sort((a, b) => a - b)
}

export interface HitClip extends SnapClip {
  fadeIn: number
  fadeOut: number
  crossfade: number
}

export type HitKind = 'clip' | 'trimStart' | 'trimEnd' | 'fadeIn' | 'fadeOut' | 'crossfade'
export interface Hit {
  kind: HitKind
  id: string
}

export function hitTest(
  clips: readonly HitClip[],
  t: number,
  pxPerSec: number,
  top: boolean
): Hit | null {
  if (!(pxPerSec > 0)) return null
  const edge = EDGE_PX / pxPerSec
  const handle = HANDLE_PX / pxPerSec
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i]
    if (top) {
      if (Math.abs(t - (c.start + c.fadeIn)) <= handle) return { kind: 'fadeIn', id: c.id }
      if (Math.abs(t - (c.end - c.fadeOut)) <= handle) return { kind: 'fadeOut', id: c.id }
    }
  }
  if (!top) {
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i]
      if (c.crossfade > 0 && t >= c.end - c.crossfade - edge && t <= c.end + edge) {
        return { kind: 'crossfade', id: c.id }
      }
    }
  }
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i]
    if (Math.abs(t - c.start) <= edge) return { kind: 'trimStart', id: c.id }
    if (Math.abs(t - c.end) <= edge) return { kind: 'trimEnd', id: c.id }
  }
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i]
    if (t >= c.start && t <= c.end) return { kind: 'clip', id: c.id }
  }
  return null
}

export function clipAt(clips: readonly SnapClip[], t: number): string | null {
  for (const c of clips) if (t > c.start && t < c.end) return c.id
  return null
}

export const REGION_BAND_PX = 11

export type RegionGrab = 'in' | 'out' | 'new'

export function regionHit(
  region: { in: number; out: number } | undefined,
  t: number,
  pxPerSec: number
): RegionGrab {
  if (!region || !(pxPerSec > 0)) return 'new'
  const edge = HANDLE_PX / pxPerSec
  const dIn = Math.abs(t - region.in)
  const dOut = Math.abs(t - region.out)
  if (dIn <= edge && dIn <= dOut) return 'in'
  if (dOut <= edge) return 'out'
  return 'new'
}
