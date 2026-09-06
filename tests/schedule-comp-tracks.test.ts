import { describe, expect, it } from 'vitest'
import { dbToGain, scheduleComp, type CompSource } from '../src/renderer/audio/clip-graph'
import { emptyEdits, type CompClip, type CompTrack } from '../src/shared/domain'

interface FakeNode {
  kind: string
  gain: { value: number }
  to: FakeNode[]
}

const node = (kind: string): FakeNode => ({ kind, gain: { value: 1 }, to: [] })

function fakeContext(): { ctx: BaseAudioContext; destination: FakeNode } {
  const connect = function (this: FakeNode, target: FakeNode): FakeNode {
    this.to.push(target)
    return target
  }
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain: () => {
      const g = node('gain')
      return Object.assign(g, {
        connect,
        gain: {
          value: 1,
          setValueAtTime: () => undefined,
          setValueCurveAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
        },
      })
    },
    createBufferSource: () =>
      Object.assign(node('source'), {
        connect,
        buffer: null,
        playbackRate: { value: 1 },
        start: () => undefined,
        stop: () => undefined,
      }),
  }
  const destination = Object.assign(node('destination'), { connect })
  return { ctx: ctx as unknown as BaseAudioContext, destination }
}

const buffer = { duration: 2, numberOfChannels: 1, sampleRate: 48000 } as unknown as AudioBuffer

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'a',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 2,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const track = (id: string, over: Partial<CompTrack> = {}): CompTrack => ({
  id,
  name: id,
  gainDb: 0,
  muted: false,
  solo: false,
  ...over,
})

const sources = (clips: CompClip[]): CompSource[] => clips.map((c) => ({ clip: c, buffer }))

describe('scheduleComp without tracks', () => {
  it('every voice lands straight on the destination', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources([clip({ id: 'a' }), clip({ id: 'b', start: 2 })]), destination)
    expect(s.voices).toHaveLength(2)
    for (const v of s.voices) expect((v.output as unknown as FakeNode).to).toEqual([destination])
  })
})

describe('scheduleComp with tracks', () => {
  const clips = [clip({ id: 'a' }), clip({ id: 'b', start: 0, trackId: 'track-2' })]

  const busOf = (voice: { output: AudioNode }, destination: FakeNode): FakeNode => {
    const bus = (voice.output as unknown as FakeNode).to[0]
    expect(bus.to).toContain(destination)
    return bus
  }

  it('groups voices per track through one gain node each', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources(clips), destination, {
      tracks: [track('track-1', { gainDb: -6 }), track('track-2')],
    })
    const first = busOf(s.voices[0], destination)
    const second = busOf(s.voices[1], destination)
    expect(first).not.toBe(second)
    expect(first.gain.value).toBeCloseTo(dbToGain(-6), 6)
    expect(second.gain.value).toBe(1)
  })

  it('one bus per track, whatever the clip count', () => {
    const { ctx, destination } = fakeContext()
    const many = [clip({ id: 'a' }), clip({ id: 'b', start: 2 }), clip({ id: 'c', start: 4 })]
    const s = scheduleComp(ctx, sources(many), destination, { tracks: [track('track-1')] })
    const buses = new Set(s.voices.map((v) => busOf(v, destination)))
    expect(buses.size).toBe(1)
  })

  it('a muted track is silent', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources(clips), destination, {
      tracks: [track('track-1', { muted: true }), track('track-2')],
    })
    expect(busOf(s.voices[0], destination).gain.value).toBe(0)
    expect(busOf(s.voices[1], destination).gain.value).toBe(1)
  })

  it('a solo anywhere silences every other track', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources(clips), destination, {
      tracks: [track('track-1'), track('track-2', { solo: true, gainDb: -3 })],
    })
    expect(busOf(s.voices[0], destination).gain.value).toBe(0)
    expect(busOf(s.voices[1], destination).gain.value).toBeCloseTo(dbToGain(-3), 6)
  })
})

describe('the original lane as a preview voice', () => {
  const orig = { duration: 5, numberOfChannels: 1, sampleRate: 48000 } as unknown as AudioBuffer

  it('rides straight on the destination, past the track buses', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources([clip()]), destination, {
      tracks: [track('track-1', { muted: true })],
      originals: [{ buffer: orig, gainDb: -6 }],
    })
    expect(s.voices).toHaveLength(2)
    expect((s.voices[1].output as unknown as FakeNode).to).toEqual([destination])
  })

  it('the composition runs to the end of the longer original', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources([clip()]), destination, {
      originals: [{ buffer: orig, gainDb: 0 }],
    })
    expect(s.duration).toBe(5)
  })

  it('without an original nothing extra is scheduled', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources([clip()]), destination, {})
    expect(s.voices).toHaveLength(1)
    expect(s.duration).toBe(2)
  })

  it('a seek past the end of the original leaves it out', () => {
    const { ctx, destination } = fakeContext()
    const s = scheduleComp(ctx, sources([clip({ start: 6, srcOut: 2 })]), destination, {
      seek: 5.5,
      original: { buffer: orig, gainDb: 0 },
    })
    expect(s.voices).toHaveLength(1)
  })
})
