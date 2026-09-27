import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE_SETTINGS } from '../src/shared/domain'
import { MOCK_SAMPLE_RATE, mockDuration } from '../src/shared/mock-voice'
import { isV3, modelsFor } from '../src/shared/provider-models'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { voiceProvider } = await import('../src/main/providers/voice-provider')
const { mockProvider } = await import('../src/main/providers/mock')
const { decodedDuration, decodedSeconds: timeInStderr, runFfmpeg } = await import('../src/main/ffmpeg')

const LINE = 'Welcome back, pioneer. The station is ready.'
const request = (text = LINE, speed = 1) => ({
  text,
  voiceId: 'mock-alto',
  model: 'eleven_multilingual_v2',
  settings: { ...DEFAULT_VOICE_SETTINGS, speed },
})

const decodedSeconds = async (mp3: Buffer): Promise<number> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-mock-test-'))
  const input = path.join(dir, 'in.mp3')
  const pcm = path.join(dir, 'out.pcm')
  await fs.writeFile(input, mp3)
  await runFfmpeg(['-i', input, '-f', 's16le', '-ac', '1', '-ar', String(MOCK_SAMPLE_RATE), pcm])
  const bytes = (await fs.stat(pcm)).size
  await fs.rm(dir, { recursive: true, force: true })
  return bytes / 2 / MOCK_SAMPLE_RATE
}

const original = process.env.VOSTUDIO_PROVIDER

afterEach(() => {
  if (original === undefined) delete process.env.VOSTUDIO_PROVIDER
  else process.env.VOSTUDIO_PROVIDER = original
})

describe('voice provider accessor', () => {
  it('uses ElevenLabs unless the mock is requested', async () => {
    delete process.env.VOSTUDIO_PROVIDER
    expect(voiceProvider().id).toBe('elevenlabs')
    process.env.VOSTUDIO_PROVIDER = 'elevenlabs'
    expect(voiceProvider().id).toBe('elevenlabs')
    process.env.VOSTUDIO_PROVIDER = 'mock'
    expect(voiceProvider().id).toBe('mock')
    expect(voiceProvider()).toBe(voiceProvider())
    expect(await voiceProvider().hasApiKey()).toBe(true)
  })

  it('serializes every audio call across callers and leaves metadata calls free', async () => {
    process.env.VOSTUDIO_PROVIDER = 'mock'
    const provider = voiceProvider()
    const started: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const audio = Buffer.from('x')
    const spies = [
      vi.spyOn(mockProvider, 'stt').mockImplementation(async () => {
        started.push('stt')
        await held
        return 'text'
      }),
      ...(['tts', 'sts', 'audioIsolation'] as const).map((name) =>
        vi.spyOn(mockProvider, name).mockImplementation(async () => {
          started.push(name)
          return audio
        })
      ),
      vi.spyOn(mockProvider, 'ttsWithTimestamps').mockImplementation(async () => {
        started.push('ttsWithTimestamps')
        return { audio }
      }),
      vi.spyOn(mockProvider, 'sttWords').mockImplementation(async () => {
        started.push('sttWords')
        return []
      }),
    ]
    const file = { audio, filename: 'a.wav' }
    const calls = Promise.all([
      provider.stt(file),
      provider.tts(request()),
      provider.ttsWithTimestamps(request()),
      provider.sts({ ...file, voiceId: 'mock-alto', model: 'm', settings: DEFAULT_VOICE_SETTINGS }),
      provider.audioIsolation(file),
      provider.sttWords(file),
    ])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(started).toEqual(['stt'])
    expect((await provider.voices()).length).toBeGreaterThan(0)
    expect(await provider.usage()).not.toBeNull()
    release()
    await calls
    expect(started).toEqual(['stt', 'tts', 'ttsWithTimestamps', 'sts', 'audioIsolation', 'sttWords'])
    for (const spy of spies) spy.mockRestore()
  })
})

describe('mock voice provider', () => {
  it('generates a deterministic mp3 of the planned length that transcribes back', async () => {
    const first = await mockProvider.ttsWithTimestamps(request())
    const second = await mockProvider.ttsWithTimestamps(request())
    expect(first.audio.equals(second.audio)).toBe(true)
    expect(first.audio.subarray(0, 3).toString('latin1')).toBe('ID3')
    const planned = mockDuration(LINE, 1)
    expect(Math.abs((await decodedSeconds(first.audio)) - planned)).toBeLessThan(0.06)
    expect(first.words?.map((w) => w.text)).toEqual(LINE.split(' '))
    expect(first.words?.[first.words.length - 1].end).toBeLessThan(planned)
    const file = { audio: first.audio, filename: 'take.mp3' }
    expect(await mockProvider.stt(file)).toBe(LINE)
    const words = await mockProvider.sttWords(file)
    expect(words.map((w) => w.text)).toEqual(LINE.split(' '))
    expect(words[words.length - 1].end).toBeLessThan(planned + 0.1)
  })

  it('makes faster speech shorter and counts characters', async () => {
    const before = (await mockProvider.usage())!.used
    const slow = await mockProvider.tts(request(LINE, 0.7))
    const fast = await mockProvider.tts(request(LINE, 1.2))
    expect(await decodedSeconds(fast)).toBeLessThan(await decodedSeconds(slow))
    const after = (await mockProvider.usage())!
    expect(after.used - before).toBe(LINE.length * 2)
    expect(after.remaining).toBe(after.limit - after.used)
  })

  it('keeps the duration through voice conversion and isolation and drops the text tag', async () => {
    const source = await mockProvider.tts(request())
    const seconds = await decodedSeconds(source)
    for (const convert of [mockProvider.sts, mockProvider.audioIsolation]) {
      const out = await convert({ audio: source, filename: 'rec.mp3', voiceId: 'mock-bass', model: 'm', settings: DEFAULT_VOICE_SETTINGS })
      expect(Math.abs((await decodedSeconds(out)) - seconds)).toBeLessThan(0.06)
      await expect(mockProvider.stt({ audio: out, filename: 'out.mp3' })).rejects.toThrow(/mock voice/)
    }
  })

  it('refuses to transcribe untagged audio', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-mock-test-'))
    const wav = path.join(dir, 'tone.wav')
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', wav])
    const file = { audio: await fs.readFile(wav), filename: 'tone.wav' }
    await expect(mockProvider.stt(file)).rejects.toThrow(/mock voice/)
    await expect(mockProvider.sttWords(file)).rejects.toThrow(/mock voice/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('lists fixed voices and models that match the default model ids', async () => {
    expect((await mockProvider.voices()).map((v) => v.id)).toEqual(['mock-alto', 'mock-bass', 'mock-tenor'])
    const models = await mockProvider.models()
    expect(modelsFor(models, 'tts').map((m) => m.id)).toEqual(['eleven_multilingual_v2'])
    expect(modelsFor(models, 'sts').map((m) => m.id)).toEqual(['eleven_multilingual_sts_v2'])
    expect(models.some(isV3)).toBe(false)
  })
})

describe('decoded take duration', () => {
  it('measures what a decoder plays, not the padded mp3 header length', async () => {
    const { audio } = await mockProvider.ttsWithTimestamps(request())
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-mock-test-'))
    const file = path.join(dir, 'take.mp3')
    await fs.writeFile(file, audio)
    const measured = await decodedDuration(file)
    await fs.rm(dir, { recursive: true, force: true })
    expect(Math.abs((measured ?? 0) - (await decodedSeconds(audio)))).toBeLessThan(0.011)
  })

  it('reads the last progress time and ignores output without one', () => {
    expect(timeInStderr('size=N/A time=00:00:00.50 bitrate=N/A\rsize=N/A time=00:01:01.49 bitrate=N/A')).toBe(61.49)
    expect(timeInStderr('Duration: 00:00:01.54')).toBeUndefined()
  })
})
