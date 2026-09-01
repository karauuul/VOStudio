import { compDuration, compEffectsTail, compHasPitch, compHasReverb } from '@shared/comp'
import type { ClipEdits } from '@shared/domain'
import { effectsTail, pitchActive } from '@shared/effects'
import { ensurePitchModule } from './pitch-node'
import { buildClipGraph, renderDuration, scheduleComp, type CompSource } from './clip-graph'
import type { ResolvedComp } from './comp-source'
import { getBuffer, loadCompSources, release } from './transport'
import { encodeWavFloat32 } from './wav'

export interface RenderedClip {
  wav: ArrayBuffer
  duration: number
  sampleRate: number
  channels: number
}

export async function renderBufferOffline(
  buffer: AudioBuffer,
  edits: ClipEdits
): Promise<AudioBuffer> {
  if (!(buffer.duration > 0)) throw new Error('Decoded audio is empty (0 s)')
  const dur = renderDuration(buffer.duration, edits)
  if (!(dur > 0)) {
    throw new Error(
      `Edits leave nothing to export: ${buffer.duration.toFixed(3)}s − trim ${edits.trimStart}s/${edits.trimEnd}s`
    )
  }
  const sampleRate = buffer.sampleRate
  const frames = Math.max(1, Math.ceil((dur + effectsTail(edits.effects)) * sampleRate))
  const channels = edits.effects?.reverb
    ? Math.max(2, buffer.numberOfChannels)
    : buffer.numberOfChannels
  const ctx = new OfflineAudioContext(channels, frames, sampleRate)
  if (pitchActive(edits.effects?.pitch)) await ensurePitchModule(ctx)
  const plan = buildClipGraph(ctx, buffer, edits)
  plan.output.connect(ctx.destination)
  plan.source.start(0, plan.offset)
  plan.source.stop(plan.duration)
  return ctx.startRendering()
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < buffer.numberOfChannels; i++) out.push(buffer.getChannelData(i))
  return out
}

export async function renderClipToWav(
  url: string,
  edits: ClipEdits,
  releaseBuffer = true
): Promise<RenderedClip> {
  let buffer: AudioBuffer
  try {
    buffer = await getBuffer(url)
  } catch (e) {
    throw new Error(`Could not decode source audio: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    const rendered = await renderBufferOffline(buffer, edits)
    return {
      wav: encodeWavFloat32(channelsOf(rendered), rendered.sampleRate),
      duration: rendered.duration,
      sampleRate: rendered.sampleRate,
      channels: rendered.numberOfChannels,
    }
  } finally {
    if (releaseBuffer) release(url)
  }
}

export async function renderCompOffline(
  sources: CompSource[],
  region?: { in: number; out: number }
): Promise<AudioBuffer> {
  const clips = sources.map((s) => s.clip)
  const total = compDuration({ clips })
  if (!(total > 0)) throw new Error('Composition is empty — nothing to render')
  const from = region ? Math.min(Math.max(0, region.in), total) : 0
  const to = region
    ? Math.min(Math.max(from, region.out), total)
    : total + compEffectsTail(clips)
  const dur = to - from
  if (!(dur > 0)) {
    throw new Error(
      `Render region leaves nothing to export (${from.toFixed(3)}s…${to.toFixed(3)}s of ${total.toFixed(3)}s)`
    )
  }
  let sampleRate = 0
  let channels = 1
  for (const s of sources) {
    if (s.buffer.sampleRate > sampleRate) sampleRate = s.buffer.sampleRate
    if (s.buffer.numberOfChannels > channels) channels = s.buffer.numberOfChannels
  }
  if (!(sampleRate > 0)) throw new Error('Composition sources have no sample rate')
  if (compHasReverb(clips)) channels = Math.max(2, channels)
  const frames = Math.max(1, Math.ceil(dur * sampleRate))
  const ctx = new OfflineAudioContext(channels, frames, sampleRate)
  if (compHasPitch(clips)) await ensurePitchModule(ctx)
  scheduleComp(ctx, sources, ctx.destination, { when: 0, seek: from })
  return ctx.startRendering()
}

export async function renderCompToWav(resolved: ResolvedComp): Promise<RenderedClip> {
  const sources = await loadCompSources(resolved)
  try {
    const rendered = await renderCompOffline(sources, resolved.region)
    return {
      wav: encodeWavFloat32(channelsOf(rendered), rendered.sampleRate),
      duration: rendered.duration,
      sampleRate: rendered.sampleRate,
      channels: rendered.numberOfChannels,
    }
  } finally {
    for (const url of new Set(resolved.clips.map((c) => c.url))) release(url)
  }
}
