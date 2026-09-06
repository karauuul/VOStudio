import { describe, expect, it } from 'vitest'
import {
  clipTimelineDuration,
  compDuration,
  DUCK_ATTACK,
  DUCK_RELEASE,
  duckEnvelope,
  SPEED_MAX,
} from '../src/shared/comp'
import { fitToLength } from '../src/shared/library'
import {
  emptyEdits,
  envelopeDbAt,
  sanitizeStems,
  type CompClip,
  type Cue,
  type CueComp,
  type Project,
  type Stem,
  type Take,
} from '../src/shared/domain'
import { applyProjectCommand } from '../src/shared/project-commands'
import { compPlanFor, mixesOriginal, originalRefs } from '../src/shared/export-plan'
import { stemsSchema } from '../src/main/schemas'
import { scheduleComp, type CompSource } from '../src/renderer/audio/clip-graph'

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'a',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 1,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const stem = (over: Partial<Stem> = {}): Stem => ({
  id: 's-voice',
  name: 'Voice',
  file: { fileId: 'c1/voice.wav', relPath: 'E:/p/audio/stems/c1/voice.wav', format: 'wav' },
  exportMode: 'off',
  ...over,
})

describe('duck envelope', () => {
  it('ramps down before a clip and back up after it', () => {
    const env = duckEnvelope([clip({ start: 1, srcOut: 2 })], -12)
    expect(env).toEqual([
      { t: 1 - DUCK_ATTACK, db: 0 },
      { t: 1, db: -12 },
      { t: 3, db: -12 },
      { t: 3 + DUCK_RELEASE, db: 0 },
    ])
    expect(envelopeDbAt(env, 0)).toBe(0)
    expect(envelopeDbAt(env, 2)).toBe(-12)
    expect(envelopeDbAt(env, 1 - DUCK_ATTACK / 2)).toBeCloseTo(-6, 6)
    expect(envelopeDbAt(env, 10)).toBe(0)
  })

  it('holds the duck across clips that are closer than attack plus release', () => {
    const env = duckEnvelope(
      [clip({ id: 'a', start: 0, srcOut: 1 }), clip({ id: 'b', start: 1.1, srcOut: 1, srcIn: 0 })],
      -9
    )
    expect(env).toHaveLength(4)
    expect(envelopeDbAt(env, 1.05)).toBe(-9)
    expect(env[env.length - 1]).toEqual({ t: 2.1 + DUCK_RELEASE, db: 0 })
  })

  it('keeps separate spans when the gap is wide enough', () => {
    const env = duckEnvelope(
      [clip({ id: 'a', start: 0, srcOut: 1 }), clip({ id: 'b', start: 5, srcOut: 1 })],
      -9
    )
    expect(env).toHaveLength(8)
    expect(envelopeDbAt(env, 3)).toBe(0)
  })

  it('clamps the attack at zero and is empty without a duck', () => {
    expect(duckEnvelope([clip({ start: 0 })], -6)[0]).toEqual({ t: 0, db: 0 })
    expect(duckEnvelope([clip()], 0)).toEqual([])
    expect(duckEnvelope([clip()], Number.NaN)).toEqual([])
    expect(duckEnvelope([], -12)).toEqual([])
  })

  it('reaches the original voice through scheduleComp', () => {
    const ramps: number[] = []
    const connect = function (this: unknown): unknown {
      return this
    }
    const ctx = {
      sampleRate: 48000,
      currentTime: 0,
      createGain: () => ({
        connect,
        gain: {
          value: 1,
          setValueAtTime: () => undefined,
          setValueCurveAtTime: () => undefined,
          linearRampToValueAtTime: (v: number) => ramps.push(v),
        },
      }),
      createBufferSource: () => ({
        connect,
        buffer: null,
        playbackRate: { value: 1 },
        start: () => undefined,
        stop: () => undefined,
      }),
    } as unknown as BaseAudioContext
    const destination = { connect } as unknown as AudioNode
    const buffer = { duration: 4, numberOfChannels: 1, sampleRate: 48000 } as unknown as AudioBuffer
    const sources: CompSource[] = [{ clip: clip({ start: 1, srcOut: 2 }), buffer }]

    scheduleComp(ctx, sources, destination, {
      originals: [{ buffer, gainDb: 0, duckDb: -12 }],
    })
    expect(ramps.some((v) => Math.abs(v - Math.pow(10, -12 / 20)) < 1e-9)).toBe(true)

    ramps.length = 0
    scheduleComp(ctx, sources, destination, { originals: [{ buffer, gainDb: 0 }] })
    expect(ramps).toEqual([])
  })
})

describe('fit to original length', () => {
  it('makes the composition duration equal the original', () => {
    const comp: CueComp = { clips: [clip({ srcOut: 3 })] }
    const r = fitToLength(comp, ['a'], 2)
    if ('refused' in r) throw new Error(r.refused)
    expect(compDuration(r.comp)).toBeCloseTo(2, 9)
    expect(Math.abs(compDuration(r.comp) - 2) < 1e-6).toBe(true)
  })

  it('keeps a single clip anchored at its own start', () => {
    const comp: CueComp = { clips: [clip({ srcOut: 2, start: 1 })] }
    const r = fitToLength(comp, ['a'], 4)
    if ('refused' in r) throw new Error(r.refused)
    expect(r.comp.clips[0].start).toBe(1)
    expect(clipTimelineDuration(r.comp.clips[0])).toBeCloseTo(3, 9)
  })

  it('scales a whole track proportionally with the starts', () => {
    const comp: CueComp = {
      clips: [
        clip({ id: 'a', srcOut: 1, start: 0 }),
        clip({ id: 'b', srcOut: 1, start: 3 }),
      ],
    }
    const r = fitToLength(comp, ['a', 'b'], 2)
    if ('refused' in r) throw new Error(r.refused)
    expect(compDuration(r.comp)).toBeCloseTo(2, 9)
    expect(r.comp.clips[1].start).toBeCloseTo(1.5, 9)
    expect(r.comp.clips[0].edits.timeStretch).toBeCloseTo(2, 9)
  })

  it('refuses a factor outside the speed range', () => {
    const comp: CueComp = { clips: [clip({ srcOut: 10 })] }
    const r = fitToLength(comp, ['a'], 1)
    expect('refused' in r && r.refused).toContain(`${SPEED_MAX}`)
  })

  it('refuses when it would overlap a clip that stays put', () => {
    const comp: CueComp = {
      clips: [clip({ id: 'a', srcOut: 1, start: 0 }), clip({ id: 'b', srcOut: 1, start: 1 })],
    }
    const r = fitToLength(comp, ['a'], 2)
    expect('refused' in r && r.refused).toContain('overlap')
  })

  it('refuses an unknown clip and a target before the anchor', () => {
    const comp: CueComp = { clips: [clip({ start: 2, srcOut: 1 })] }
    expect(fitToLength(comp, ['nope'], 3)).toEqual({ refused: 'Nothing to fit' })
    expect('refused' in fitToLength(comp, ['a'], 1)).toBe(true)
  })
})

describe('stems on the model', () => {
  it('sanitizes, clamps and drops broken rows', () => {
    expect(
      sanitizeStems([
        { id: ' ', name: 'x', file: stem().file, exportMode: 'on' },
        { id: 'a', file: { fileId: 'f', relPath: 'p', format: 'flac' }, exportMode: 'on' },
        { id: 'b', file: stem().file, exportMode: 'nonsense', duckDb: -400 },
        { id: 'b', name: 'dup', file: stem().file, exportMode: 'on' },
        { id: 'c', name: 'Music & SFX', file: stem().file, exportMode: 'on', duckDb: 12 },
      ])
    ).toEqual([
      { id: 'b', name: 'b', file: stem().file, exportMode: 'off', duckDb: -60 },
      { id: 'c', name: 'Music & SFX', file: stem().file, exportMode: 'on', duckDb: 0 },
    ])
    expect(sanitizeStems([])).toBeUndefined()
    expect(sanitizeStems('nope')).toBeUndefined()
  })

  it('survives a serialization roundtrip through the zod mirror', () => {
    const stems: Stem[] = [
      stem(),
      stem({
        id: 's-rest',
        name: 'Music & SFX',
        file: { fileId: 'c1/rest.wav', relPath: 'E:/p/audio/stems/c1/rest.wav', format: 'wav' },
        exportMode: 'on',
        duckDb: 0,
      }),
    ]
    const wire = JSON.parse(JSON.stringify(stems)) as unknown
    expect(stemsSchema.parse(wire)).toEqual(stems)
    expect(sanitizeStems(wire)).toEqual(stems)
  })
})

const take = (id: string): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: id, relPath: `E:/p/${id}.mp3`, format: 'mp3' },
  duration: 3,
  meta: {},
  edits: emptyEdits(),
})

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'c1',
  characterId: 'ch1',
  key: 'K1',
  fields: {},
  sourceText: 'source',
  text: 'text',
  status: 'generated',
  notes: '',
  referenceAudio: { fileId: 'r', relPath: 'E:/orig/1.wav', format: 'wav' },
  referenceDuration: 3.5,
  takes: [take('t-1')],
  finalTakeId: 't-1',
  output: { kind: 'take', takeId: 't-1', revision: 1 },
  ...over,
})

const project = (cues: Cue[]): Project => ({
  id: 'p',
  schemaVersion: 1,
  name: 'p',
  createdAt: '2026-01-01T00:00:00.000Z',
  media: { referenceDir: 'E:/orig', referencePattern: '{Key}.wav' },
  characters: [],
  cues,
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '{Key}.wav',
  ui: { filter: '', search: '' },
})

describe('stems through the command and the export plan', () => {
  const stems: Stem[] = [
    stem(),
    stem({
      id: 's-rest',
      name: 'Music & SFX',
      file: { fileId: 'c1/rest.wav', relPath: 'E:/p/audio/stems/c1/rest.wav', format: 'wav' },
      exportMode: 'on',
      duckDb: -12,
    }),
  ]

  it('sets and clears the stems on a cue', () => {
    const p = project([cue()])
    applyProjectCommand(p, { type: 'cue.setStems', cueId: 'c1', stems })
    expect(p.cues[0].stems).toEqual(stems)
    applyProjectCommand(p, { type: 'cue.setStems', cueId: 'c1', stems: null })
    expect(p.cues[0].stems).toBeUndefined()
    expect(() =>
      applyProjectCommand(p, { type: 'cue.setStems', cueId: 'c1', stems: [] })
    ).toThrow('Invalid stems')
  })

  it('exports the on stems instead of the combined original', () => {
    const c = cue({ stems, original: { exportMode: 'off' } })
    expect(mixesOriginal(c)).toBe(true)
    expect(originalRefs(c, undefined)).toEqual([
      { srcPath: 'E:/p/audio/stems/c1/rest.wav', gainDb: 0, offset: 0, duration: 3.5, duckDb: -12 },
    ])
    const plan = compPlanFor(c, c.takes[0], project([c]))!
    expect(plan.originals).toEqual(originalRefs(c, undefined))
  })

  it('mixes nothing when every stem is off', () => {
    const c = cue({ stems: [stem(), stem({ id: 's-rest', exportMode: 'off' })] })
    expect(mixesOriginal(c)).toBe(false)
    expect(originalRefs(c, undefined)).toEqual([])
  })
})

describe('a project written before milestone 12', () => {
  const old = cue({ original: { exportMode: 'on', duckDb: -12 } })

  it('reads and writes without a stems key', () => {
    expect(old.stems).toBeUndefined()
    expect(mixesOriginal(old)).toBe(true)
    expect(originalRefs(old, undefined)).toEqual([
      { srcPath: 'E:/orig/1.wav', gainDb: 0, offset: 0, duration: 3.5, duckDb: -12 },
    ])
    const p = project([old])
    applyProjectCommand(p, { type: 'cue.setOriginal', cueId: 'c1', original: { exportMode: 'off' } })
    expect(JSON.parse(JSON.stringify(p.cues[0])).stems).toBeUndefined()
  })

  it('renders a plain original with no envelope when the duck is unset', () => {
    const c = cue({ original: { exportMode: 'on' } })
    expect(originalRefs(c, undefined)).toEqual([
      { srcPath: 'E:/orig/1.wav', gainDb: 0, offset: 0, duration: 3.5 },
    ])
  })
})
