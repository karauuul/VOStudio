import { pitchActive, type PitchEffect } from '@shared/effects'
import { PITCH_PARAM, PITCH_PROCESSOR, PITCH_WORKLET_SOURCE } from './worklets/pitch-shifter.worklet'

let moduleUrlCache: string | null = null
function moduleUrl(): string {
  if (!moduleUrlCache) {
    moduleUrlCache = URL.createObjectURL(
      new Blob([PITCH_WORKLET_SOURCE], { type: 'text/javascript' })
    )
  }
  return moduleUrlCache
}

const loading = new WeakMap<BaseAudioContext, Promise<void>>()
const registered = new WeakSet<BaseAudioContext>()

export function ensurePitchModule(ctx: BaseAudioContext): Promise<void> {
  const hit = loading.get(ctx)
  if (hit) return hit
  const p = ctx.audioWorklet
    .addModule(moduleUrl())
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

export function pitchModuleReady(ctx: BaseAudioContext): boolean {
  return registered.has(ctx)
}

export function connectPitch(
  ctx: BaseAudioContext,
  input: AudioNode,
  pitch: PitchEffect | undefined,
  channels: number
): AudioNode {
  if (!pitchActive(pitch)) return input
  if (!pitchModuleReady(ctx)) {
    void ensurePitchModule(ctx).catch(() => {})
    return input
  }
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
