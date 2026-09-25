export const WAV_HEADER_BYTES = 44

export const WAV_PCM = 1
export const WAV_FLOAT = 3

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

export function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels = 1,
  bitsPerSample = 16,
  format = WAV_PCM
): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`Invalid sampleRate: ${sampleRate}`)
  }
  const blockAlign = channels * (bitsPerSample / 8)
  const header = new Uint8Array(WAV_HEADER_BYTES)
  const view = new DataView(header.buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return header
}

export function wavDataBytes(fileSize: number, blockAlign = 2): number {
  const body = Math.max(0, Math.floor(fileSize) - WAV_HEADER_BYTES)
  return body - (body % blockAlign)
}
