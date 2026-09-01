import { clipEnd, clipTimelineDuration } from '@shared/comp'
import { clipSpeed, type CompClip, type CompRegion } from '@shared/domain'
import type { Peaks } from '../Waveform'
import {
  REGION_BAND_PX,
  timeToX,
  tickLabel,
  ticks,
  tickStep,
  type TimelineView,
} from './timeline-math'

const WAVE_REF = '#7c869c'
const CLIP_FILL = 'rgba(70, 201, 140, 0.10)'
const CLIP_FILL_SEL = 'rgba(70, 201, 140, 0.20)'
const CLIP_LINE = 'rgba(70, 201, 140, 0.45)'
const CLIP_LINE_SEL = '#ececf1'
const CLIP_WAVE = '#46c98c'
const CLIP_WAVE_SEL = '#6fe3aa'
const REF_END_LINE = 'rgba(124, 134, 156, 0.85)'
const REF_END_SHADE = 'rgba(10, 10, 12, 0.42)'
const FADE_FILL = 'rgba(20, 20, 22, 0.55)'
const FADE_LINE = 'rgba(236, 236, 241, 0.5)'
const HANDLE_FILL = '#ececf1'
const TICK = '#3b3b43'
const TICK_TEXT = '#5f5f6b'
const CLIP_TEXT = 'rgba(236, 236, 241, 0.82)'
const CLIP_TEXT_DIM = 'rgba(154, 154, 165, 0.9)'
const EMPTY_LINE = 'rgba(95, 95, 107, 0.45)'
const XFADE_FILL = 'rgba(109, 159, 242, 0.16)'
const XFADE_LINE = 'rgba(150, 190, 255, 0.85)'
const REGION_SHADE = 'rgba(8, 8, 10, 0.55)'
const REGION_BAR = '#e6a23c'
const REGION_BAR_DIM = 'rgba(230, 162, 60, 0.22)'
const FX_FILL = 'rgba(109, 159, 242, 0.22)'
const FX_LINE = '#6d9ff2'
const GHOST_OK_FILL = 'rgba(70, 201, 140, 0.16)'
const GHOST_OK_LINE = 'rgba(111, 227, 170, 0.9)'
const GHOST_BAD_FILL = 'rgba(224, 90, 90, 0.14)'
const GHOST_BAD_LINE = 'rgba(240, 120, 120, 0.95)'

export interface Surface {
  cx: CanvasRenderingContext2D
  dpr: number
  W: number
  H: number
}

export function surface(canvas: HTMLCanvasElement | null): Surface | null {
  if (!canvas) return null
  const cx = canvas.getContext('2d')
  if (!cx) return null
  const dpr = window.devicePixelRatio || 1
  const W = Math.max(1, Math.round(canvas.offsetWidth * dpr))
  const H = Math.max(1, Math.round(canvas.offsetHeight * dpr))
  if (canvas.width !== W) canvas.width = W
  if (canvas.height !== H) canvas.height = H
  cx.clearRect(0, 0, W, H)
  return { cx, dpr, W, H }
}

function peaksInto(
  s: Surface,
  peaks: Peaks,
  x0: number,
  x1: number,
  t0: number,
  t1: number,
  midY: number,
  halfH: number,
  color: string
): void {
  const span = x1 - x0
  if (!(span > 0)) return
  const n = peaks.min.length
  if (n === 0) return
  const dur = peaks.duration > 0 ? peaks.duration : 1
  const step = Math.max(1, Math.round(s.dpr))
  const from = Math.max(0, Math.floor(x0))
  const to = Math.min(s.W, Math.ceil(x1))
  s.cx.fillStyle = color
  for (let x = from; x < to; x += step) {
    const t = t0 + ((x + step / 2 - x0) / span) * (t1 - t0)
    const i = Math.min(n - 1, Math.max(0, Math.floor((t / dur) * n)))
    const top = midY - peaks.max[i] * halfH
    const bot = midY - peaks.min[i] * halfH
    s.cx.fillRect(x, Math.min(top, bot), step, Math.max(step, Math.abs(bot - top)))
  }
}

function drawRefEnd(s: Surface, view: TimelineView, refEnd: number): void {
  if (!(refEnd > 0)) return
  const x = Math.round(timeToX(view, refEnd) * s.dpr)
  if (x > s.W) return
  if (x < s.W) {
    s.cx.fillStyle = REF_END_SHADE
    s.cx.fillRect(Math.max(0, x), 0, s.W - Math.max(0, x), s.H)
  }
  if (x < 0) return
  s.cx.fillStyle = REF_END_LINE
  s.cx.fillRect(x, 0, Math.max(1, Math.round(s.dpr)), s.H)
}

function drawRegionShade(s: Surface, view: TimelineView, region?: CompRegion): void {
  if (!region) return
  const xa = Math.round(timeToX(view, region.in) * s.dpr)
  const xb = Math.round(timeToX(view, region.out) * s.dpr)
  s.cx.fillStyle = REGION_SHADE
  if (xa > 0) s.cx.fillRect(0, 0, Math.min(xa, s.W), s.H)
  if (xb < s.W) s.cx.fillRect(Math.max(0, xb), 0, s.W - Math.max(0, xb), s.H)
  s.cx.fillStyle = REGION_BAR_DIM
  const w = Math.max(1, Math.round(s.dpr))
  if (xa >= 0 && xa <= s.W) s.cx.fillRect(xa, 0, w, s.H)
  if (xb >= 0 && xb <= s.W) s.cx.fillRect(xb - w, 0, w, s.H)
}

export function drawRuler(
  canvas: HTMLCanvasElement | null,
  view: TimelineView,
  region?: CompRegion
): void {
  const s = surface(canvas)
  if (!s) return
  const width = s.W / s.dpr
  const step = tickStep(view.pxPerSec)
  const band = Math.round(REGION_BAND_PX * s.dpr)

  s.cx.font = `${10 * s.dpr}px ui-monospace, Consolas, monospace`
  s.cx.textBaseline = 'top'
  for (const t of ticks(view, width)) {
    const x = Math.round(timeToX(view, t) * s.dpr)
    s.cx.fillStyle = TICK
    s.cx.fillRect(x, s.H - Math.round(5 * s.dpr), Math.max(1, Math.round(s.dpr)), Math.round(5 * s.dpr))
    s.cx.fillStyle = TICK_TEXT
    s.cx.fillText(tickLabel(t, step), x + 3 * s.dpr, 2 * s.dpr)
  }

  if (!region) return
  const xa = Math.round(timeToX(view, region.in) * s.dpr)
  const xb = Math.round(timeToX(view, region.out) * s.dpr)
  const grip = Math.max(2, Math.round(3 * s.dpr))
  s.cx.fillStyle = REGION_BAR_DIM
  s.cx.fillRect(Math.max(0, xa), 0, Math.max(0, Math.min(xb, s.W) - Math.max(0, xa)), band)
  s.cx.fillStyle = REGION_BAR
  s.cx.fillRect(xa, 0, grip, band)
  s.cx.fillRect(xa, 0, Math.round(7 * s.dpr), grip)
  s.cx.fillRect(xb - grip, 0, grip, band)
  s.cx.fillRect(xb - Math.round(7 * s.dpr), 0, Math.round(7 * s.dpr), grip)
}

export function drawSourceLane(
  canvas: HTMLCanvasElement | null,
  peaks: Peaks | null,
  view: TimelineView,
  region?: CompRegion
): void {
  const s = surface(canvas)
  if (!s) return
  const mid = s.H / 2
  if (!peaks || !(peaks.duration > 0)) {
    s.cx.fillStyle = EMPTY_LINE
    s.cx.fillRect(0, mid, s.W, Math.max(1, Math.round(s.dpr)))
    drawRegionShade(s, view, region)
    return
  }
  const x0 = timeToX(view, 0) * s.dpr
  const x1 = timeToX(view, peaks.duration) * s.dpr
  peaksInto(s, peaks, x0, x1, 0, peaks.duration, mid, mid * 0.88, WAVE_REF)
  drawRefEnd(s, view, peaks.duration)
  drawRegionShade(s, view, region)
}

export interface DrawClip {
  clip: CompClip
  peaks: Peaks | null
  label: string
  busy?: boolean
  crossfade?: number
}

export interface DrawGhost {
  start: number
  duration: number
  valid: boolean
  label: string
}

export interface CompLaneOptions {
  pulse?: number
  refEnd?: number
  region?: CompRegion
  ghost?: DrawGhost | null
}

export function drawCompLane(
  canvas: HTMLCanvasElement | null,
  clips: readonly DrawClip[],
  view: TimelineView,
  selectedId: string | null,
  opts: CompLaneOptions = {}
): void {
  const s = surface(canvas)
  if (!s) return
  const pulse = opts.pulse ?? 0
  const refEnd = opts.refEnd ?? 0
  const r = Math.round(4 * s.dpr)
  const pad = Math.round(3 * s.dpr)

  for (const d of clips) {
    const c = d.clip
    const tl = clipTimelineDuration(c)
    if (!(tl > 0)) continue
    const x0 = timeToX(view, c.start) * s.dpr
    const x1 = timeToX(view, clipEnd(c)) * s.dpr
    if (x1 < -2 || x0 > s.W + 2) continue
    const sel = c.id === selectedId
    const w = Math.max(1, x1 - x0)

    s.cx.save()
    s.cx.beginPath()
    s.cx.roundRect(x0, pad, w, s.H - pad * 2, r)
    s.cx.fillStyle = sel ? CLIP_FILL_SEL : CLIP_FILL
    s.cx.fill()
    s.cx.clip()

    if (d.peaks) {
      const mid = s.H / 2
      peaksInto(s, d.peaks, x0, x1, c.srcIn, c.srcOut, mid, (s.H / 2 - pad) * 0.8,
        sel ? CLIP_WAVE_SEL : CLIP_WAVE)
    }

    drawFades(s, c, view, x0, x1)
    drawClipText(s, d, tl, x0, x1)
    drawFxBadge(s, c, x0, x1)
    s.cx.restore()

    s.cx.beginPath()
    s.cx.roundRect(x0 + 0.5, pad + 0.5, Math.max(1, w - 1), s.H - pad * 2 - 1, r)
    if (d.busy) {
      s.cx.strokeStyle = `rgba(230, 162, 60, ${(0.35 + pulse * 0.55).toFixed(3)})`
      s.cx.lineWidth = Math.max(1, Math.round(s.dpr * 2))
    } else {
      s.cx.strokeStyle = sel ? CLIP_LINE_SEL : CLIP_LINE
      s.cx.lineWidth = Math.max(1, Math.round(s.dpr * (sel ? 2.5 : 1)))
      if (sel) {
        s.cx.shadowColor = 'rgba(236, 236, 241, 0.55)'
        s.cx.shadowBlur = Math.round(6 * s.dpr)
      }
    }
    s.cx.stroke()
    s.cx.shadowBlur = 0

    drawHandles(s, c, view, x0, x1, pad, sel)
  }

  for (const d of clips) {
    if (d.crossfade && d.crossfade > 0) drawCrossfade(s, d.clip, d.crossfade, view, pad)
  }

  if (opts.ghost) drawGhost(s, opts.ghost, view, pad, r)

  drawRefEnd(s, view, refEnd)
  drawRegionShade(s, view, opts.region)
}

function drawCrossfade(
  s: Surface,
  c: CompClip,
  xf: number,
  view: TimelineView,
  pad: number
): void {
  const joint = clipEnd(c)
  const xa = timeToX(view, joint - xf) * s.dpr
  const xb = timeToX(view, joint) * s.dpr
  if (xb < -2 || xa > s.W + 2) return
  const top = pad
  const bot = s.H - pad
  s.cx.save()
  s.cx.beginPath()
  s.cx.rect(xa, top, Math.max(1, xb - xa), bot - top)
  s.cx.fillStyle = XFADE_FILL
  s.cx.fill()
  s.cx.beginPath()
  s.cx.moveTo(xa, top)
  s.cx.lineTo(xb, bot)
  s.cx.moveTo(xa, bot)
  s.cx.lineTo(xb, top)
  s.cx.strokeStyle = XFADE_LINE
  s.cx.lineWidth = Math.max(1, Math.round(s.dpr * 1.4))
  s.cx.stroke()
  s.cx.restore()
}

function drawGhost(
  s: Surface,
  g: DrawGhost,
  view: TimelineView,
  pad: number,
  r: number
): void {
  const x0 = timeToX(view, g.start) * s.dpr
  const x1 = timeToX(view, g.start + g.duration) * s.dpr
  const w = Math.max(2, x1 - x0)
  s.cx.save()
  s.cx.beginPath()
  s.cx.roundRect(x0, pad, w, s.H - pad * 2, r)
  s.cx.fillStyle = g.valid ? GHOST_OK_FILL : GHOST_BAD_FILL
  s.cx.fill()
  s.cx.setLineDash([Math.round(4 * s.dpr), Math.round(3 * s.dpr)])
  s.cx.strokeStyle = g.valid ? GHOST_OK_LINE : GHOST_BAD_LINE
  s.cx.lineWidth = Math.max(1, Math.round(s.dpr * 2))
  s.cx.stroke()
  s.cx.setLineDash([])
  if (w > 46 * s.dpr) {
    s.cx.font = `${10 * s.dpr}px ui-monospace, Consolas, monospace`
    s.cx.textBaseline = 'top'
    s.cx.fillStyle = g.valid ? GHOST_OK_LINE : GHOST_BAD_LINE
    s.cx.fillText(g.label, x0 + 8 * s.dpr, pad + 5 * s.dpr)
  }
  s.cx.restore()
}

function drawFades(
  s: Surface,
  c: CompClip,
  view: TimelineView,
  x0: number,
  x1: number
): void {
  const top = 0
  const bot = s.H
  const inD = c.edits.fadeIn.duration
  const outD = c.edits.fadeOut.duration
  if (inD > 0) {
    const xa = timeToX(view, c.start + inD) * s.dpr
    s.cx.beginPath()
    s.cx.moveTo(x0, top)
    s.cx.lineTo(xa, top)
    s.cx.lineTo(x0, bot)
    s.cx.closePath()
    s.cx.fillStyle = FADE_FILL
    s.cx.fill()
    s.cx.beginPath()
    s.cx.moveTo(x0, bot)
    s.cx.lineTo(xa, top)
    s.cx.strokeStyle = FADE_LINE
    s.cx.lineWidth = Math.max(1, Math.round(s.dpr))
    s.cx.stroke()
  }
  if (outD > 0) {
    const xb = timeToX(view, clipEnd(c) - outD) * s.dpr
    s.cx.beginPath()
    s.cx.moveTo(xb, top)
    s.cx.lineTo(x1, top)
    s.cx.lineTo(x1, bot)
    s.cx.closePath()
    s.cx.fillStyle = FADE_FILL
    s.cx.fill()
    s.cx.beginPath()
    s.cx.moveTo(xb, top)
    s.cx.lineTo(x1, bot)
    s.cx.strokeStyle = FADE_LINE
    s.cx.lineWidth = Math.max(1, Math.round(s.dpr))
    s.cx.stroke()
  }
}

function drawFxBadge(s: Surface, c: CompClip, x0: number, x1: number): void {
  const fx = c.edits.effects
  if (!fx) return
  const tag =
    'fx' + (fx.reverb ? ' R' : '') + (fx.delay ? ' D' : '') + (fx.pitch ? ' P' : '')
  s.cx.font = `${9 * s.dpr}px ui-monospace, Consolas, monospace`
  s.cx.textBaseline = 'bottom'
  const w = s.cx.measureText(tag).width + 8 * s.dpr
  const h = 12 * s.dpr
  if (x1 - x0 < w + 10 * s.dpr) return
  const x = x0 + 5 * s.dpr
  const y = s.H - 4 * s.dpr - h
  s.cx.beginPath()
  s.cx.roundRect(x, y, w, h, Math.round(3 * s.dpr))
  s.cx.fillStyle = FX_FILL
  s.cx.fill()
  s.cx.fillStyle = FX_LINE
  s.cx.fillText(tag, x + 4 * s.dpr, y + h - 2.5 * s.dpr)
}

function drawHandles(
  s: Surface,
  c: CompClip,
  view: TimelineView,
  x0: number,
  x1: number,
  pad: number,
  sel = false
): void {
  const size = Math.round((sel ? 7 : 5) * s.dpr)
  const y = pad + Math.round(1 * s.dpr)
  const xa = timeToX(view, c.start + c.edits.fadeIn.duration) * s.dpr
  const xb = timeToX(view, clipEnd(c) - c.edits.fadeOut.duration) * s.dpr
  s.cx.fillStyle = HANDLE_FILL
  if (x1 - x0 > size * 3) {
    s.cx.fillRect(Math.min(xa, x1 - size), y, size, size)
    s.cx.fillRect(Math.max(xb - size, x0), y, size, size)
  }
}

function drawClipText(s: Surface, d: DrawClip, tl: number, x0: number, x1: number): void {
  if (x1 - x0 < 46 * s.dpr) return
  const speed = clipSpeed(d.clip.edits)
  const gain = d.clip.edits.gainDb
  s.cx.font = `${10 * s.dpr}px ui-monospace, Consolas, monospace`
  s.cx.textBaseline = 'top'
  s.cx.fillStyle = CLIP_TEXT
  s.cx.fillText(d.label, x0 + 14 * s.dpr, 5 * s.dpr)
  s.cx.textBaseline = 'bottom'
  s.cx.fillStyle = CLIP_TEXT_DIM
  const extra =
    (Math.abs(gain) > 0.05 ? ` ${gain > 0 ? '+' : ''}${gain.toFixed(1)}dB` : '') +
    (Math.abs(speed - 1) > 0.005 ? ` ${speed.toFixed(2)}×` : '')
  const txt = `${tl.toFixed(2)}s${extra}`
  const w = s.cx.measureText(txt).width
  s.cx.fillText(txt, Math.max(x0 + 6 * s.dpr, x1 - 6 * s.dpr - w), s.H - 5 * s.dpr)
}
