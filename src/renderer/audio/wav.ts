import { WAV_FLOAT, WAV_HEADER_BYTES, wavHeader } from '@shared/wav-header'

export { WAV_HEADER_BYTES }

export function floatToPcm16(v: number): number {
  if (!Number.isFinite(v)) return 0
  const c = v < -1 ? -1 : v > 1 ? 1 : v
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff)
}

export function pcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = floatToPcm16(samples[i])
  return out
}

export function floatToPcm24(v: number): number {
  if (!Number.isFinite(v)) return 0
  const c = v < -1 ? -1 : v > 1 ? 1 : v
  return c < 0 ? Math.round(c * 0x800000) : Math.round(c * 0x7fffff)
}

export function pcm24(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 3)
  for (let i = 0; i < samples.length; i++) {
    const v = floatToPcm24(samples[i])
    out[i * 3] = v & 0xff
    out[i * 3 + 1] = (v >> 8) & 0xff
    out[i * 3 + 2] = (v >> 16) & 0xff
  }
  return out
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataBytes = samples.length * 2
  const header = wavHeader(dataBytes, sampleRate)
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  new Uint8Array(buffer).set(header)
  const view = new DataView(buffer)
  let off = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(off, floatToPcm16(samples[i]), true)
    off += 2
  }
  return buffer
}

export function interleave(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const frames = channels[0].length
  for (const c of channels) {
    if (c.length !== frames) throw new Error('Channels have different lengths')
  }
  const out = new Float32Array(frames * channels.length)
  let o = 0
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels.length; ch++) out[o++] = channels[ch][i]
  }
  return out
}

export function encodeWavFloat32(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`)
  }
  if (channels.length === 0) throw new Error('No channels to encode')
  const samples = interleave(channels)
  const dataBytes = samples.length * 4
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  new Uint8Array(buffer).set(wavHeader(dataBytes, sampleRate, channels.length, 32, WAV_FLOAT))
  const view = new DataView(buffer)

  let off = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(off, samples[i], true)
    off += 4
  }
  return buffer
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

export function pcmDuration(sampleCount: number, sampleRate: number): number {
  return sampleRate > 0 ? sampleCount / sampleRate : 0
}
