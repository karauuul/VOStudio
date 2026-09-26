export interface ReverbEffect {
  mix: number
  size: number
  decay: number
  preDelay?: number
  enabled?: false
}

export interface DelayEffect {
  time: number
  feedback: number
  mix: number
  enabled?: false
}

export interface PitchEffect {
  semitones: number
  enabled?: false
}

export interface NoiseGateEffect {
  threshold: number
  attack: number
  hold: number
  release: number
  range: number
  enabled?: false
}

export interface HighPassEffect {
  frequency: number
  enabled?: false
}

export interface EqEffect {
  lowFreq: number
  lowGain: number
  midFreq: number
  midGain: number
  midQ: number
  highFreq: number
  highGain: number
  enabled?: false
}

export interface CompressorEffect {
  threshold: number
  ratio: number
  attack: number
  release: number
  knee: number
  makeup: number
  enabled?: false
}

export type EffectKind = 'gate' | 'highpass' | 'eq' | 'compressor' | 'reverb' | 'delay' | 'pitch'

export const EFFECT_KINDS: readonly EffectKind[] = [
  'gate',
  'highpass',
  'eq',
  'compressor',
  'reverb',
  'delay',
  'pitch',
]
export const TRACK_EFFECT_KINDS: readonly EffectKind[] = [
  'gate',
  'highpass',
  'eq',
  'compressor',
  'reverb',
  'delay',
]

export type EffectStage = 'gate' | 'highpass' | 'eq' | 'compressor' | 'pitch' | 'sends'

export function effectOn(effect: { enabled?: false } | undefined): boolean {
  return !!effect && effect.enabled !== false
}

export interface ClipEffects {
  reverb?: ReverbEffect
  delay?: DelayEffect
  pitch?: PitchEffect
  gate?: NoiseGateEffect
  highpass?: HighPassEffect
  eq?: EqEffect
  compressor?: CompressorEffect
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
export const GATE_THRESHOLD_MIN = -80
export const GATE_THRESHOLD_MAX = 0
export const GATE_ATTACK_MIN = 0
export const GATE_ATTACK_MAX = 0.1
export const GATE_HOLD_MIN = 0
export const GATE_HOLD_MAX = 0.5
export const GATE_RELEASE_MIN = 0.005
export const GATE_RELEASE_MAX = 1
export const GATE_RANGE_MIN = -80
export const GATE_RANGE_MAX = 0
export const HIGHPASS_FREQ_MIN = 20
export const HIGHPASS_FREQ_MAX = 400
export const EQ_GAIN_MIN = -18
export const EQ_GAIN_MAX = 18
export const EQ_LOW_FREQ_MIN = 20
export const EQ_LOW_FREQ_MAX = 1000
export const EQ_MID_FREQ_MIN = 100
export const EQ_MID_FREQ_MAX = 10000
export const EQ_HIGH_FREQ_MIN = 1000
export const EQ_HIGH_FREQ_MAX = 16000
export const EQ_Q_MIN = 0.1
export const EQ_Q_MAX = 10
export const COMPRESSOR_THRESHOLD_MIN = -60
export const COMPRESSOR_THRESHOLD_MAX = 0
export const COMPRESSOR_RATIO_MIN = 1
export const COMPRESSOR_RATIO_MAX = 20
export const COMPRESSOR_ATTACK_MIN = 0
export const COMPRESSOR_ATTACK_MAX = 0.2
export const COMPRESSOR_RELEASE_MIN = 0.01
export const COMPRESSOR_RELEASE_MAX = 1
export const COMPRESSOR_KNEE_MIN = 0
export const COMPRESSOR_KNEE_MAX = 40
export const COMPRESSOR_MAKEUP_MIN = 0
export const COMPRESSOR_MAKEUP_MAX = 24

export const DEFAULT_REVERB: ReverbEffect = { mix: 0.25, size: 0.5, decay: 1.2 }
export const DEFAULT_DELAY: DelayEffect = { time: 0.25, feedback: 0.35, mix: 0.3 }
export const DEFAULT_PITCH: PitchEffect = { semitones: 2 }
export const DEFAULT_GATE: NoiseGateEffect = {
  threshold: -40,
  attack: 0.005,
  hold: 0.05,
  release: 0.1,
  range: -24,
}
export const DEFAULT_HIGHPASS: HighPassEffect = { frequency: 80 }
export const DEFAULT_EQ: EqEffect = {
  lowFreq: 120,
  lowGain: 0,
  midFreq: 1000,
  midGain: 0,
  midQ: 1,
  highFreq: 8000,
  highGain: 0,
}
export const DEFAULT_COMPRESSOR: CompressorEffect = {
  threshold: -18,
  ratio: 3,
  attack: 0.01,
  release: 0.15,
  knee: 6,
  makeup: 0,
}

const DEFAULTS: Required<ClipEffects> = {
  gate: DEFAULT_GATE,
  highpass: DEFAULT_HIGHPASS,
  eq: DEFAULT_EQ,
  compressor: DEFAULT_COMPRESSOR,
  reverb: DEFAULT_REVERB,
  delay: DEFAULT_DELAY,
  pitch: DEFAULT_PITCH,
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback

const bypass = (effect: { enabled?: false }): { enabled?: false } =>
  effect.enabled === false ? { enabled: false } : {}

export function sanitizeReverb(r: ReverbEffect): ReverbEffect {
  const out: ReverbEffect = {
    mix: num(r.mix, MIX_MIN, MIX_MAX, DEFAULT_REVERB.mix),
    size: num(r.size, REVERB_SIZE_MIN, REVERB_SIZE_MAX, DEFAULT_REVERB.size),
    decay: num(r.decay, REVERB_DECAY_MIN, REVERB_DECAY_MAX, DEFAULT_REVERB.decay),
  }
  if (r.preDelay !== undefined) {
    out.preDelay = num(r.preDelay, REVERB_PREDELAY_MIN, REVERB_PREDELAY_MAX, 0)
  }
  return { ...out, ...bypass(r) }
}

export function sanitizeDelay(d: DelayEffect): DelayEffect {
  return {
    time: num(d.time, DELAY_TIME_MIN, DELAY_TIME_MAX, DEFAULT_DELAY.time),
    feedback: num(d.feedback, DELAY_FEEDBACK_MIN, DELAY_FEEDBACK_MAX, DEFAULT_DELAY.feedback),
    mix: num(d.mix, MIX_MIN, MIX_MAX, DEFAULT_DELAY.mix),
    ...bypass(d),
  }
}

export function sanitizePitch(p: PitchEffect): PitchEffect {
  const s = num(p.semitones, PITCH_SEMITONES_MIN, PITCH_SEMITONES_MAX, 0)
  return { semitones: Math.round(s / PITCH_STEP) * PITCH_STEP, ...bypass(p) }
}

export function sanitizeGate(g: NoiseGateEffect): NoiseGateEffect {
  return {
    threshold: num(g.threshold, GATE_THRESHOLD_MIN, GATE_THRESHOLD_MAX, DEFAULT_GATE.threshold),
    attack: num(g.attack, GATE_ATTACK_MIN, GATE_ATTACK_MAX, DEFAULT_GATE.attack),
    hold: num(g.hold, GATE_HOLD_MIN, GATE_HOLD_MAX, DEFAULT_GATE.hold),
    release: num(g.release, GATE_RELEASE_MIN, GATE_RELEASE_MAX, DEFAULT_GATE.release),
    range: num(g.range, GATE_RANGE_MIN, GATE_RANGE_MAX, DEFAULT_GATE.range),
    ...bypass(g),
  }
}

export function sanitizeHighPass(h: HighPassEffect): HighPassEffect {
  return {
    frequency: num(h.frequency, HIGHPASS_FREQ_MIN, HIGHPASS_FREQ_MAX, DEFAULT_HIGHPASS.frequency),
    ...bypass(h),
  }
}

export function sanitizeEq(e: EqEffect): EqEffect {
  return {
    lowFreq: num(e.lowFreq, EQ_LOW_FREQ_MIN, EQ_LOW_FREQ_MAX, DEFAULT_EQ.lowFreq),
    lowGain: num(e.lowGain, EQ_GAIN_MIN, EQ_GAIN_MAX, DEFAULT_EQ.lowGain),
    midFreq: num(e.midFreq, EQ_MID_FREQ_MIN, EQ_MID_FREQ_MAX, DEFAULT_EQ.midFreq),
    midGain: num(e.midGain, EQ_GAIN_MIN, EQ_GAIN_MAX, DEFAULT_EQ.midGain),
    midQ: num(e.midQ, EQ_Q_MIN, EQ_Q_MAX, DEFAULT_EQ.midQ),
    highFreq: num(e.highFreq, EQ_HIGH_FREQ_MIN, EQ_HIGH_FREQ_MAX, DEFAULT_EQ.highFreq),
    highGain: num(e.highGain, EQ_GAIN_MIN, EQ_GAIN_MAX, DEFAULT_EQ.highGain),
    ...bypass(e),
  }
}

export function sanitizeCompressor(c: CompressorEffect): CompressorEffect {
  return {
    threshold: num(
      c.threshold,
      COMPRESSOR_THRESHOLD_MIN,
      COMPRESSOR_THRESHOLD_MAX,
      DEFAULT_COMPRESSOR.threshold
    ),
    ratio: num(c.ratio, COMPRESSOR_RATIO_MIN, COMPRESSOR_RATIO_MAX, DEFAULT_COMPRESSOR.ratio),
    attack: num(c.attack, COMPRESSOR_ATTACK_MIN, COMPRESSOR_ATTACK_MAX, DEFAULT_COMPRESSOR.attack),
    release: num(
      c.release,
      COMPRESSOR_RELEASE_MIN,
      COMPRESSOR_RELEASE_MAX,
      DEFAULT_COMPRESSOR.release
    ),
    knee: num(c.knee, COMPRESSOR_KNEE_MIN, COMPRESSOR_KNEE_MAX, DEFAULT_COMPRESSOR.knee),
    makeup: num(c.makeup, COMPRESSOR_MAKEUP_MIN, COMPRESSOR_MAKEUP_MAX, DEFAULT_COMPRESSOR.makeup),
    ...bypass(c),
  }
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
  if (fx.gate) out.gate = sanitizeGate(fx.gate)
  if (fx.highpass) out.highpass = sanitizeHighPass(fx.highpass)
  if (fx.eq) out.eq = sanitizeEq(fx.eq)
  if (fx.compressor) out.compressor = sanitizeCompressor(fx.compressor)
  return Object.keys(out).length > 0 ? out : undefined
}

function copyKind<K extends EffectKind>(to: ClipEffects, from: ClipEffects, k: K): void {
  if (from[k]) to[k] = from[k]
}

export function pickEffects(
  fx: ClipEffects | undefined,
  kinds: readonly EffectKind[]
): ClipEffects | undefined {
  if (!fx) return undefined
  const out: ClipEffects = {}
  for (const k of kinds) copyKind(out, fx, k)
  return sanitizeEffects(out)
}

export function effectChain(fx: ClipEffects | undefined): EffectStage[] {
  if (!fx) return []
  const chain: EffectStage[] = []
  if (effectOn(fx.gate)) chain.push('gate')
  if (effectOn(fx.highpass)) chain.push('highpass')
  if (effectOn(fx.eq)) chain.push('eq')
  if (effectOn(fx.compressor)) chain.push('compressor')
  if (pitchActive(fx.pitch)) chain.push('pitch')
  if (hasSends(fx)) chain.push('sends')
  return chain
}

export function hasEffects(fx: ClipEffects | undefined): boolean {
  return effectChain(fx).length > 0
}

export function usesWorklets(fx: ClipEffects | undefined): boolean {
  return !!fx && (pitchActive(fx.pitch) || effectOn(fx.gate))
}

export function hasSends(fx: ClipEffects | undefined): boolean {
  return !!fx && (effectOn(fx.reverb) || effectOn(fx.delay))
}

export function pitchActive(p: PitchEffect | undefined): boolean {
  return effectOn(p) && sanitizePitch(p!).semitones !== 0
}

export function setEffectEnabled(
  fx: ClipEffects | undefined,
  which: EffectKind,
  on: boolean
): ClipEffects | undefined {
  if (!fx) return fx
  const current = fx[which]
  if (!current) return sanitizeEffects(fx)
  return sanitizeEffects({ ...fx, [which]: { ...current, enabled: on ? undefined : false } })
}

export function toggleEffect(
  fx: ClipEffects | undefined,
  which: EffectKind,
  on: boolean
): ClipEffects | undefined {
  const next: ClipEffects = { ...(sanitizeEffects(fx) ?? {}) }
  if (on) return sanitizeEffects({ ...next, [which]: { ...DEFAULTS[which] } })
  delete next[which]
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
  if (effectOn(fx.reverb)) t = Math.max(t, reverbTail(fx.reverb!))
  if (effectOn(fx.delay)) t = Math.max(t, delayTail(fx.delay!))
  return Math.min(t, MAX_EFFECT_TAIL)
}
