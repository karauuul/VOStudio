import { clipSpeed, envelopeDbAt, type ClipEdits, type CompClip, type FadeShape } from '@shared/domain'
import { clipTimelineDuration, compClipEdits, compDuration, compRenderPlan } from '@shared/comp'
import { connectEffects } from './effects-graph'
import { connectPitch } from './pitch-node'

export const FADE_CURVE_POINTS = 64

export { envelopeDbAt }
export const stretchRate = clipSpeed

export function trimmedDuration(bufferDuration: number, edits: ClipEdits): number {
  const start = Math.max(0, edits.trimStart)
  const end = Math.max(0, edits.trimEnd)
  return bufferDuration - start - end
}

export function renderDuration(bufferDuration: number, edits: ClipEdits): number {
  return trimmedDuration(bufferDuration, edits) / stretchRate(edits)
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export function fadeValue(shape: FadeShape, x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x
  if (shape === 'linear') return t
  if (shape === 'sCurve') return t * t * (3 - 2 * t)
  return Math.sin((t * Math.PI) / 2)
}

export function fadeCurve(
  shape: FadeShape,
  from: number,
  to: number,
  points = FADE_CURVE_POINTS,
  out = false
): Float32Array {
  const n = Math.max(2, Math.floor(points))
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = from + ((to - from) * i) / (n - 1)
    curve[i] = fadeValue(shape, out ? 1 - x : x)
  }
  return curve
}

export interface FadeWindow {
  at: number
  duration: number
  from: number
  to: number
}

export function fadeInWindow(fadeDur: number, seek: number): FadeWindow | null {
  const d = Math.max(0, fadeDur)
  const s = Math.max(0, seek)
  if (d <= 0 || s >= d) return null
  return { at: 0, duration: d - s, from: s / d, to: 1 }
}

export function fadeOutWindow(fadeDur: number, clipDur: number, seek: number): FadeWindow | null {
  const d = Math.min(Math.max(0, fadeDur), Math.max(0, clipDur))
  const s = Math.max(0, seek)
  if (d <= 0 || s >= clipDur) return null
  const startsAt = clipDur - d
  if (s <= startsAt) return { at: startsAt - s, duration: d, from: 0, to: 1 }
  const passed = s - startsAt
  return { at: 0, duration: d - passed, from: passed / d, to: 1 }
}

export interface ClipGraphPlan {
  source: AudioBufferSourceNode
  output: AudioNode
  offset: number
  duration: number
}

export interface ClipGraphOptions {
  when?: number
  seek?: number
  crossfadeIn?: number
  crossfadeOut?: number
}

function fadeNode(
  ctx: BaseAudioContext,
  shape: FadeShape,
  win: FadeWindow,
  when: number,
  out: boolean
): GainNode {
  const g = ctx.createGain()
  g.gain.setValueAtTime(out ? 1 : fadeValue(shape, win.from), when)
  g.gain.setValueCurveAtTime(
    fadeCurve(shape, win.from, win.to, FADE_CURVE_POINTS, out),
    when + win.at,
    win.duration
  )
  return g
}

export function buildClipGraph(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  edits: ClipEdits,
  opts: ClipGraphOptions = {}
): ClipGraphPlan {
  const when = opts.when ?? 0
  const rate = stretchRate(edits)
  const clipDur = Math.max(0, renderDuration(buffer.duration, edits))
  const seek = Math.max(0, Math.min(clipDur, opts.seek ?? 0))

  const source = ctx.createBufferSource()
  source.buffer = buffer
  if (rate !== 1) source.playbackRate.value = rate

  let node: AudioNode = source

  const inWin = fadeInWindow(edits.fadeIn?.duration ?? 0, seek)
  if (inWin) {
    const g = fadeNode(ctx, edits.fadeIn.shape, inWin, when, false)
    node.connect(g)
    node = g
  }

  const outWin = fadeOutWindow(edits.fadeOut?.duration ?? 0, clipDur, seek)
  if (outWin) {
    const g = fadeNode(ctx, edits.fadeOut.shape, outWin, when, true)
    node.connect(g)
    node = g
  }

  const xfInWin = fadeInWindow(Math.max(0, opts.crossfadeIn ?? 0), seek)
  if (xfInWin) {
    const g = fadeNode(ctx, 'equalPower', xfInWin, when, false)
    node.connect(g)
    node = g
  }

  const xfOutWin = fadeOutWindow(Math.max(0, opts.crossfadeOut ?? 0), clipDur, seek)
  if (xfOutWin) {
    const g = fadeNode(ctx, 'equalPower', xfOutWin, when, true)
    node.connect(g)
    node = g
  }

  const env = edits.gainEnvelope
  if (env && env.length > 0) {
    const pts = [...env].sort((a, b) => a.t - b.t)
    const g = ctx.createGain()
    g.gain.setValueAtTime(dbToGain(envelopeDbAt(pts, seek)), when)
    for (const p of pts) {
      if (p.t <= seek) continue
      g.gain.linearRampToValueAtTime(dbToGain(p.db), when + (p.t - seek))
    }
    node.connect(g)
    node = g
  }

  const gain = ctx.createGain()
  gain.gain.value = dbToGain(edits.gainDb)
  node.connect(gain)

  const pitched = connectPitch(ctx, gain, edits.effects?.pitch, buffer.numberOfChannels)

  const output = connectEffects(ctx, pitched, edits.effects)

  return {
    source,
    output,
    offset: Math.max(0, edits.trimStart) + seek * rate,
    duration: Math.max(0, clipDur - seek),
  }
}

export interface CompSource {
  clip: CompClip
  buffer: AudioBuffer
}

export interface ScheduledVoice {
  source: AudioBufferSourceNode
  output: AudioNode
  at: number
  duration: number
}

export interface ScheduledComp {
  voices: ScheduledVoice[]
  duration: number
}

export function scheduleComp(
  ctx: BaseAudioContext,
  sources: CompSource[],
  destination: AudioNode,
  opts: ClipGraphOptions = {}
): ScheduledComp {
  const when = opts.when ?? 0
  const seek = Math.max(0, opts.seek ?? 0)
  const voices: ScheduledVoice[] = []
  const plan = compRenderPlan(sources.map((s) => s.clip))

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]
    const c = plan[i].clip
    const tl = clipTimelineDuration(c)
    if (!(tl > 0)) continue
    const end = c.start + tl
    if (seek >= end) continue
    const localSeek = Math.max(0, seek - c.start)
    const at = when + Math.max(0, c.start - seek)

    const graph = buildClipGraph(ctx, s.buffer, compClipEdits(c, s.buffer.duration), {
      when: at,
      seek: localSeek,
      crossfadeIn: plan[i].crossfadeIn,
      crossfadeOut: plan[i].crossfadeOut,
    })
    if (!(graph.duration > 0)) continue
    graph.output.connect(destination)
    graph.source.start(at, graph.offset)
    graph.source.stop(at + graph.duration)
    voices.push({ source: graph.source, output: graph.output, at, duration: graph.duration })
  }

  return { voices, duration: Math.max(0, compDuration({ clips: sources.map((s) => s.clip) }) - seek) }
}
