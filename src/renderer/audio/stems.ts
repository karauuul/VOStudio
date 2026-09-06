import { emptyEdits, type Stem } from '@shared/domain'
import type { OriginalRef } from '@shared/export-plan'
import { api, audioUrl } from '../api'
import { channelsOf, renderBufferOffline } from './offline-render'
import { getBuffer } from './transport'
import { encodeWavFloat32 } from './wav'

function aligned(source: AudioBuffer, channels: number, frames: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let ch = 0; ch < channels; ch++) {
    const data = source.getChannelData(Math.min(ch, source.numberOfChannels - 1))
    const row = new Float32Array(frames)
    row.set(data.length > frames ? data.subarray(0, frames) : data)
    out.push(row)
  }
  return out
}

export async function splitStems(
  cueId: string,
  ref: Pick<OriginalRef, 'srcPath' | 'offset' | 'duration'>
): Promise<Stem[]> {
  const buffer = await getBuffer(audioUrl(ref.srcPath))
  const offset = Math.max(0, ref.offset)
  const duration = ref.duration > 0 ? ref.duration : buffer.duration - offset
  if (!(duration > 0)) throw new Error('The original region is empty')

  const region = await renderBufferOffline(buffer, {
    ...emptyEdits(),
    trimStart: offset,
    trimEnd: Math.max(0, buffer.duration - offset - duration),
  })

  const isolated = await api['stems:isolate'](
    cueId,
    encodeWavFloat32(channelsOf(region), region.sampleRate)
  )
  const decoded = await new OfflineAudioContext(1, 1, region.sampleRate).decodeAudioData(isolated)

  const channels = region.numberOfChannels
  const frames = region.length
  const voice = aligned(decoded, channels, frames)
  const rest = channelsOf(region).map((data, ch) => {
    const row = new Float32Array(frames)
    for (let i = 0; i < frames; i++) row[i] = data[i] - voice[ch][i]
    return row
  })

  return api['stems:save'](
    cueId,
    encodeWavFloat32(voice, region.sampleRate),
    encodeWavFloat32(rest, region.sampleRate)
  )
}
