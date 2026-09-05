export interface ReverbEffect {
  mix: number
  size: number
  decay: number
  preDelay?: number
}

export interface DelayEffect {
  time: number
  feedback: number
  mix: number
}

export interface PitchEffect {
  semitones: number
}

export interface ClipEffects {
  reverb?: ReverbEffect
  delay?: DelayEffect
  pitch?: PitchEffect
}

export const MIX_MIN = 0
export const MIX_MAX = 1
export const REVERB_SIZE_MIN = 0
export const REVERB_SIZE_MAX = 1
export const REVERB_DECAY_MIN = 0.1
export const REVERB_DECAY_MAX = 8
export const REVERB_PREDELAY_MIN = 0
export const REVERB_PREDELAY_MAX = 0.2
export const DELAY_TIME_MIN = 0.01
export const DELAY_TIME_MAX = 2
export const DELAY_FEEDBACK_MIN = 0
export const DELAY_FEEDBACK_MAX = 0.9
export const PITCH_SEMITONES_MIN = -12
export const PITCH_SEMITONES_MAX = 12
export const PITCH_STEP = 0.5

export const DEFAULT_REVERB: ReverbEffect = { mix: 0.25, size: 0.5, decay: 1.2 }
export const DEFAULT_DELAY: DelayEffect = { time: 0.25, feedback: 0.35, mix: 0.3 }
export const DEFAULT_PITCH: PitchEffect = { semitones: 2 }

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback

export function sanitizeReverb(r: ReverbEffect): ReverbEffect {
  const out: ReverbEffect = {
    mix: num(r.mix, MIX_MIN, MIX_MAX, DEFAULT_REVERB.mix),
    size: num(r.size, REVERB_SIZE_MIN, REVERB_SIZE_MAX, DEFAULT_REVERB.size),
    decay: num(r.decay, REVERB_DECAY_MIN, REVERB_DECAY_MAX, DEFAULT_REVERB.decay),
  }
  if (r.preDelay !== undefined) {
    out.preDelay = num(r.preDelay, REVERB_PREDELAY_MIN, REVERB_PREDELAY_MAX, 0)
  }
  return out
}

export function sanitizeDelay(d: DelayEffect): DelayEffect {
  return {
    time: num(d.time, DELAY_TIME_MIN, DELAY_TIME_MAX, DEFAULT_DELAY.time),
    feedback: num(d.feedback, DELAY_FEEDBACK_MIN, DELAY_FEEDBACK_MAX, DEFAULT_DELAY.feedback),
    mix: num(d.mix, MIX_MIN, MIX_MAX, DEFAULT_DELAY.mix),
  }
}

export function sanitizePitch(p: PitchEffect): PitchEffect {
  const s = num(p.semitones, PITCH_SEMITONES_MIN, PITCH_SEMITONES_MAX, 0)
  return { semitones: Math.round(s / PITCH_STEP) * PITCH_STEP }
}

export function sanitizeEffects(fx: ClipEffects | undefined): ClipEffects | undefined {
  if (!fx || typeof fx !== 'object') return undefined
  const out: ClipEffects = {}
  if (fx.reverb) out.reverb = sanitizeReverb(fx.reverb)
  if (fx.delay) out.delay = sanitizeDelay(fx.delay)
  if (fx.pitch) {
    const p = sanitizePitch(fx.pitch)
    if (p.semitones !== 0) out.pitch = p
  }
  return out.reverb || out.delay || out.pitch ? out : undefined
}

export function hasEffects(fx: ClipEffects | undefined): boolean {
  return !!fx && (!!fx.reverb || !!fx.delay || !!fx.pitch)
}

export function hasSends(fx: ClipEffects | undefined): boolean {
  return !!fx && (!!fx.reverb || !!fx.delay)
}

export function pitchActive(p: PitchEffect | undefined): boolean {
  return !!p && sanitizePitch(p).semitones !== 0
}

export interface ClipEffectsPatch {
  reverb?: Partial<ReverbEffect>
  delay?: Partial<DelayEffect>
  pitch?: Partial<PitchEffect>
}

export function mergeEffects(current: ClipEffects | undefined, patch: ClipEffectsPatch): ClipEffects {
  const next: ClipEffects = { ...current }
  if (patch.reverb && current?.reverb) next.reverb = { ...current.reverb, ...patch.reverb }
  if (patch.delay && current?.delay) next.delay = { ...current.delay, ...patch.delay }
  if (patch.pitch && current?.pitch) next.pitch = { ...current.pitch, ...patch.pitch }
  return next
}

export function toggleEffect(
  fx: ClipEffects | undefined,
  which: 'reverb' | 'delay' | 'pitch',
  on: boolean
): ClipEffects | undefined {
  const base = sanitizeEffects(fx) ?? {}
  const next: ClipEffects = { ...base }
  if (!on) delete next[which]
  else if (which === 'reverb') next.reverb = { ...DEFAULT_REVERB }
  else if (which === 'delay') next.delay = { ...DEFAULT_DELAY }
  else next.pitch = { ...DEFAULT_PITCH }
  return sanitizeEffects(next)
}

export function mixGains(mix: number): { dry: number; wet: number } {
  const m = clamp(Number.isFinite(mix) ? mix : 0, 0, 1)
  return { dry: Math.sin(((1 - m) * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) }
}

const SILENCE = 0.001

export const MAX_EFFECT_TAIL = 12

export function reverbTail(r: ReverbEffect): number {
  const s = sanitizeReverb(r)
  return (s.preDelay ?? 0) + s.decay
}

export function delayTail(d: DelayEffect): number {
  const s = sanitizeDelay(d)
  if (!(s.feedback > 0)) return s.time
  const repeats = Math.ceil(Math.log(SILENCE) / Math.log(s.feedback))
  return s.time * Math.max(1, repeats)
}

export function effectsTail(fx: ClipEffects | undefined): number {
  if (!fx) return 0
  let t = 0
  if (fx.reverb) t = Math.max(t, reverbTail(fx.reverb))
  if (fx.delay) t = Math.max(t, delayTail(fx.delay))
  return Math.min(t, MAX_EFFECT_TAIL)
}
