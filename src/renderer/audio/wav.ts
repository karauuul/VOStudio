export const WAV_HEADER_BYTES = 44

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

export function floatToPcm16(v: number): number {
  if (!Number.isFinite(v)) return 0
  const c = v < -1 ? -1 : v > 1 ? 1 : v
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff)
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`)
  }
  const channels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataBytes = samples.length * bytesPerSample

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let off = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(off, floatToPcm16(samples[i]), true)
    off += 2
  }
  return buffer
}

const FORMAT_FLOAT = 3

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
  const numChannels = channels.length
  const bytesPerSample = 4
  const blockAlign = numChannels * bytesPerSample
  const dataBytes = samples.length * bytesPerSample

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, FORMAT_FLOAT, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)

  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

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
