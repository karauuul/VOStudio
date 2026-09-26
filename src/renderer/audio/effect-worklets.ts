import {
  effectOn,
  pitchActive,
  sanitizeGate,
  type NoiseGateEffect,
  type PitchEffect,
} from '@shared/effects'
import { PITCH_PARAM, PITCH_PROCESSOR, PITCH_WORKLET_SOURCE } from './worklets/pitch-shifter.worklet'
import { GATE_PROCESSOR, GATE_WORKLET_SOURCE } from './worklets/noise-gate.worklet'

let moduleUrlsCache: string[] | null = null
function moduleUrls(): string[] {
  if (!moduleUrlsCache) {
    moduleUrlsCache = [PITCH_WORKLET_SOURCE, GATE_WORKLET_SOURCE].map((source) =>
      URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    )
  }
  return moduleUrlsCache
}

const loading = new WeakMap<BaseAudioContext, Promise<void>>()
const registered = new WeakSet<BaseAudioContext>()

export function ensureEffectWorklets(ctx: BaseAudioContext): Promise<void> {
  const hit = loading.get(ctx)
  if (hit) return hit
  const p = Promise.all(moduleUrls().map((url) => ctx.audioWorklet.addModule(url)))
    .then(() => {
      registered.add(ctx)
    })
    .catch((e) => {
      loading.delete(ctx)
      throw e
    })
  loading.set(ctx, p)
  return p
}

export function effectWorkletsReady(ctx: BaseAudioContext): boolean {
  return registered.has(ctx)
}

function workletsReadyOrLoad(ctx: BaseAudioContext): boolean {
  if (effectWorkletsReady(ctx)) return true
  void ensureEffectWorklets(ctx).catch(() => {})
  return false
}

export function connectPitch(
  ctx: BaseAudioContext,
  input: AudioNode,
  pitch: PitchEffect | undefined,
  channels: number
): AudioNode {
  if (!pitchActive(pitch)) return input
  if (!workletsReadyOrLoad(ctx)) return input
  const n = Math.max(1, Math.min(32, Math.floor(channels) || 1))
  try {
    const node = new AudioWorkletNode(ctx, PITCH_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [n],
      channelCount: n,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      parameterData: { [PITCH_PARAM]: pitch!.semitones },
    })
    input.connect(node)
    return node
  } catch {
    return input
  }
}

export function connectGate(
  ctx: BaseAudioContext,
  input: AudioNode,
  gate: NoiseGateEffect | undefined
): AudioNode {
  if (!effectOn(gate)) return input
  if (!workletsReadyOrLoad(ctx)) return input
  try {
    const node = new AudioWorkletNode(ctx, GATE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      processorOptions: sanitizeGate(gate!),
    })
    input.connect(node)
    return node
  } catch {
    return input
  }
}
