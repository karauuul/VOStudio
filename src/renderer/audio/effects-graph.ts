import {
  hasSends,
  mixGains,
  sanitizeDelay,
  sanitizeReverb,
  type ClipEffects,
  type DelayEffect,
  type ReverbEffect,
} from '@shared/effects'

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedOf(size: number, decay: number, channel: number): number {
  const a = Math.round(size * 1000)
  const b = Math.round(decay * 1000)
  return (a * 73856093) ^ (b * 19349663) ^ ((channel + 1) * 83492791)
}

const DECAY_TO_SILENCE = Math.log(1000)

export function buildImpulseResponse(
  ctx: BaseAudioContext,
  size: number,
  decay: number
): AudioBuffer {
  const sr = ctx.sampleRate
  const frames = Math.max(1, Math.ceil(decay * sr))
  const ir = ctx.createBuffer(2, frames, sr)
  const attack = Math.max(1, (0.004 + 0.05 * size) * sr)
  const lpA = 0.25 + 0.7 * (1 - size)

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    const rnd = prng(seedOf(size, decay, ch))
    let lp = 0
    let energy = 0
    for (let i = 0; i < frames; i++) {
      const noise = rnd() * 2 - 1
      lp += lpA * (noise - lp)
      const rise = 1 - Math.exp(-i / attack)
      const fall = Math.exp((-DECAY_TO_SILENCE * i) / frames)
      const v = lp * rise * fall
      data[i] = v
      energy += v * v
    }
    const norm = energy > 0 ? 1 / Math.sqrt(energy) : 1
    for (let i = 0; i < frames; i++) data[i] *= norm
  }
  return ir
}

const irCache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>()

function impulseResponse(ctx: BaseAudioContext, size: number, decay: number): AudioBuffer {
  const s = Math.round(size * 100) / 100
  const d = Math.round(decay * 100) / 100
  const key = `${s}|${d}`
  let byKey = irCache.get(ctx)
  if (!byKey) {
    byKey = new Map()
    irCache.set(ctx, byKey)
  }
  const hit = byKey.get(key)
  if (hit) return hit
  const ir = buildImpulseResponse(ctx, s, d)
  byKey.set(key, ir)
  return ir
}

function reverbSend(ctx: BaseAudioContext, input: AudioNode, r: ReverbEffect, out: AudioNode): number {
  const s = sanitizeReverb(r)
  const { dry, wet } = mixGains(s.mix)
  const conv = ctx.createConvolver()
  conv.normalize = false
  conv.buffer = impulseResponse(ctx, s.size, s.decay)
  const g = ctx.createGain()
  g.gain.value = wet
  const pre = s.preDelay ?? 0
  if (pre > 0) {
    const d = ctx.createDelay(Math.max(0.01, pre))
    d.delayTime.value = pre
    input.connect(d)
    d.connect(conv)
  } else {
    input.connect(conv)
  }
  conv.connect(g)
  g.connect(out)
  return dry
}

function delaySend(ctx: BaseAudioContext, input: AudioNode, e: DelayEffect, out: AudioNode): number {
  const s = sanitizeDelay(e)
  const { dry, wet } = mixGains(s.mix)
  const d = ctx.createDelay(Math.max(2, s.time))
  d.delayTime.value = s.time
  const fb = ctx.createGain()
  fb.gain.value = s.feedback
  const g = ctx.createGain()
  g.gain.value = wet
  input.connect(d)
  d.connect(fb)
  fb.connect(d)
  d.connect(g)
  g.connect(out)
  return dry
}

export function connectEffects(
  ctx: BaseAudioContext,
  input: AudioNode,
  fx: ClipEffects | undefined
): AudioNode {
  if (!hasSends(fx)) return input
  const sum = ctx.createGain()
  const dryGain = ctx.createGain()
  let dry = 1
  if (fx!.reverb) dry *= reverbSend(ctx, input, fx!.reverb, sum)
  if (fx!.delay) dry *= delaySend(ctx, input, fx!.delay, sum)
  dryGain.gain.value = dry
  input.connect(dryGain)
  dryGain.connect(sum)
  return sum
}
