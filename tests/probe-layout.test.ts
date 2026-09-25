import { describe, expect, it } from 'vitest'
import { layoutChannels, parseProbe } from '../src/main/ffmpeg'
import { decodedBytes } from '../src/shared/take-import'

const line = (layout: string): string =>
  `  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, ${layout}, s16, 4608 kb/s`

describe('channel layouts from ffmpeg', () => {
  it('counts named layouts from real ffmpeg stream lines', () => {
    const expected: Record<string, number> = {
      mono: 1,
      stereo: 2,
      '2.1': 3,
      '3.0': 3,
      quad: 4,
      '4.0': 4,
      '5.0': 5,
      '5.1': 6,
      '5.1(side)': 6,
      '6.1': 7,
      '7.1': 8,
      '6 channels': 6,
      '12 channels': 12,
    }
    for (const [layout, channels] of Object.entries(expected)) {
      const probe = parseProbe(`  Duration: 00:00:00.10, start: 0.000000, bitrate: 4608 kb/s\n${line(layout)}`)
      expect(probe.channels, layout).toBe(channels)
      expect(probe.sampleRate).toBe(48000)
      expect(probe.hasAudio).toBe(true)
    }
  })

  it('treats unknown layouts as 8 channels', () => {
    expect(layoutChannels('hexagonal')).toBe(8)
    expect(parseProbe(line('hexagonal')).channels).toBe(8)
  })

  it('budgets surround audio by its real channel count', () => {
    const surround = parseProbe(`  Duration: 00:01:00.00, start: 0.000000, bitrate: 4608 kb/s\n${line('5.1(side)')}`)
    expect(decodedBytes(surround)).toBe(60 * 48000 * 6 * 4)
  })

  it('reports no audio for a video-only file', () => {
    const probe = parseProbe(
      '  Duration: 00:00:00.32, start: 0.000000, bitrate: 180 kb/s\n  Stream #0:0: Video: theora, yuv444p, 64x64 [SAR 1:1 DAR 1:1], 25 tbr, 25 tbn'
    )
    expect(probe.hasAudio).toBe(false)
    expect(probe.duration).toBeCloseTo(0.32, 2)
  })
})
