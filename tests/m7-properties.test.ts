import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DELAY,
  DEFAULT_REVERB,
  effectOn,
  effectsTail,
  hasEffects,
  hasSends,
  pitchActive,
  sanitizeEffects,
  setEffectEnabled,
  EFFECT_KINDS,
  pickEffects,
  TRACK_EFFECT_KINDS,
  type ClipEffects,
} from '../src/shared/effects'
import { propertiesTab, propertiesTabs } from '../src/shared/properties'
import { connectEffects } from '../src/renderer/audio/effects-graph'
import { compHasReverb } from '../src/shared/comp'
import { resolveTargetTrack } from '../src/shared/library'
import { placeTake } from '../src/shared/generation'
import {
  emptyEdits,
  nextOriginal,
  type CompClip,
  type CompTrack,
  type Cue,
  type CueComp,
  type Project,
  type Take,
} from '../src/shared/domain'
import { applyProjectCommand } from '../src/shared/project-commands'
import { clipEffectsSchema, projectCommandSchema } from '../src/main/schemas'

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'c1',
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

describe('bypass — a new optional field', () => {
  it('absent means on; false is kept, true is never written', () => {
    expect(effectOn(DEFAULT_REVERB)).toBe(true)
    expect(sanitizeEffects({ reverb: DEFAULT_REVERB })).toEqual({ reverb: DEFAULT_REVERB })
    expect(sanitizeEffects({ reverb: { ...DEFAULT_REVERB, enabled: false } })).toEqual({
      reverb: { ...DEFAULT_REVERB, enabled: false },
    })
    expect(
      sanitizeEffects({ reverb: { ...DEFAULT_REVERB, enabled: true as unknown as false } })?.reverb
    ).toEqual(DEFAULT_REVERB)
  })

  it('a project written before the field sanitizes byte-identical', () => {
    const old: ClipEffects = {
      reverb: DEFAULT_REVERB,
      delay: DEFAULT_DELAY,
      pitch: { semitones: 2 },
    }
    const raw = JSON.parse(JSON.stringify(old)) as ClipEffects
    expect(JSON.stringify(sanitizeEffects(raw))).toBe(JSON.stringify(old))
    expect(hasEffects(old)).toBe(true)
    expect(hasSends(old)).toBe(true)
    expect(pitchActive(old.pitch)).toBe(true)
  })

  it('setEffectEnabled toggles one effect and leaves its siblings alone', () => {
    const on: ClipEffects = { reverb: DEFAULT_REVERB, delay: DEFAULT_DELAY }
    const off = setEffectEnabled(on, 'reverb', false)
    expect(off).toEqual({ reverb: { ...DEFAULT_REVERB, enabled: false }, delay: DEFAULT_DELAY })
    expect(setEffectEnabled(off, 'reverb', true)).toEqual(on)
  })

  it('a bypassed effect is invisible to every consumer of the model', () => {
    const off = setEffectEnabled({ reverb: DEFAULT_REVERB }, 'reverb', false)
    expect(hasSends(off)).toBe(false)
    expect(hasEffects(off)).toBe(false)
    expect(effectsTail(off)).toBe(0)
    expect(compHasReverb([clip({ edits: { ...emptyEdits(), effects: off } })])).toBe(false)
    expect(pitchActive(setEffectEnabled({ pitch: { semitones: 5 } }, 'pitch', false)?.pitch)).toBe(
      false
    )
  })

  it('the zod mirror carries the field and refuses enabled: true', () => {
    const fx = { reverb: { ...DEFAULT_REVERB, enabled: false as const } }
    expect(JSON.stringify(clipEffectsSchema.parse(JSON.parse(JSON.stringify(fx))))).toBe(
      JSON.stringify(fx)
    )
    expect(clipEffectsSchema.safeParse({ reverb: { ...DEFAULT_REVERB, enabled: true } }).success).toBe(
      false
    )
  })
})

interface FakeNode {
  kind: string
  to: FakeNode[]
}

function fakeContext(): { ctx: BaseAudioContext; made: string[] } {
  const made: string[] = []
  const connect = function (this: FakeNode, target: FakeNode): FakeNode {
    this.to.push(target)
    return target
  }
  const node = (kind: string): FakeNode => {
    made.push(kind)
    return Object.assign({ kind, to: [] as FakeNode[] }, { connect })
  }
  const ctx = {
    sampleRate: 48000,
    createGain: () => Object.assign(node('gain'), { gain: { value: 1 } }),
    createConvolver: () => Object.assign(node('convolver'), { normalize: true, buffer: null }),
    createDelay: () => Object.assign(node('delay'), { delayTime: { value: 0 } }),
    createBuffer: (channels: number, frames: number) => ({
      numberOfChannels: channels,
      length: frames,
      getChannelData: () => new Float32Array(frames),
    }),
  }
  return { ctx: ctx as unknown as BaseAudioContext, made }
}

describe('connectEffects honours the bypass', () => {
  const input = (): AudioNode =>
    Object.assign({ kind: 'input', to: [] as FakeNode[] }, {
      connect(this: FakeNode, t: FakeNode) {
        this.to.push(t)
        return t
      },
    }) as unknown as AudioNode

  it('a bypassed reverb builds no convolver', () => {
    const { ctx, made } = fakeContext()
    const fx = setEffectEnabled({ reverb: DEFAULT_REVERB }, 'reverb', false)
    const out = connectEffects(ctx, input(), fx)
    expect(made).toEqual([])
    expect((out as unknown as FakeNode).kind).toBe('input')
  })

  it('a bypassed delay beside a live reverb leaves only the reverb', () => {
    const { ctx, made } = fakeContext()
    const fx = setEffectEnabled({ reverb: DEFAULT_REVERB, delay: DEFAULT_DELAY }, 'delay', false)
    connectEffects(ctx, input(), fx)
    expect(made.filter((k) => k === 'convolver')).toHaveLength(1)
    expect(made.filter((k) => k === 'delay')).toHaveLength(0)
  })
})

describe('resolveTargetTrack', () => {
  const comp: CueComp = { clips: [clip()], tracks: [track('track-1'), track('track-2')] }

  it('keeps a target that still exists', () => {
    expect(resolveTargetTrack(comp, 'track-2')).toBe('track-2')
  })

  it('falls back to the first track when the target is gone or unset', () => {
    expect(resolveTargetTrack(comp, 'track-9')).toBe('track-1')
    expect(resolveTargetTrack(comp, undefined)).toBe('track-1')
    expect(resolveTargetTrack(undefined, 'track-9')).toBe('track-1')
  })

  it('placement lands on the first track when the stored target vanished', () => {
    const placed = placeTake({
      comp: { clips: [], tracks: [track('track-1'), track('track-2')] },
      takeId: 't1',
      duration: 1,
      targetTrackId: 'track-9',
      playhead: 0,
    })
    expect(placed.trackId).toBe('track-1')
  })
})

describe('nextOriginal', () => {
  it('turning export on supplies the default duck once', () => {
    expect(nextOriginal(undefined, { exportMode: 'on' })).toEqual({ exportMode: 'on', duckDb: -12 })
    expect(nextOriginal({ exportMode: 'off', duckDb: -3 }, { exportMode: 'on' })).toEqual({
      exportMode: 'on',
      duckDb: -3,
    })
  })

  it('a legacy line with export on keeps its missing duck when only preview toggles', () => {
    expect(nextOriginal({ exportMode: 'on' }, { previewMuted: true })).toEqual({
      exportMode: 'on',
      previewMuted: true,
    })
  })

  it('previewMuted is written only when true', () => {
    expect(nextOriginal({ exportMode: 'off', previewMuted: true }, { previewMuted: undefined })).toEqual(
      { exportMode: 'off' }
    )
    expect(nextOriginal(undefined, { previewMuted: true })).toEqual({
      exportMode: 'off',
      previewMuted: true,
    })
  })
})

const take = (over: Partial<Take> = {}): Take => ({
  id: 't1',
  kind: 'tts',
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: 'f1', relPath: 'a.wav', format: 'wav' },
  duration: 2,
  meta: {},
  edits: emptyEdits(),
  ...over,
})

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'cue1',
  characterId: 'ch',
  key: 'K1',
  fields: {},
  sourceText: 'src',
  text: 'txt',
  status: 'generated',
  notes: '',
  takes: [take()],
  ...over,
})

const project = (): Project =>
  ({
    name: 'p',
    characters: [],
    cues: [cue()],
    sessions: [],
    pronunciationRules: '',
    exportTemplate: '{exportName}.{ext}',
  }) as unknown as Project

describe('cue.setTakeEffects', () => {
  it('writes source effects onto the take and clears them again', () => {
    const p = project()
    applyProjectCommand(p, {
      type: 'cue.setTakeEffects',
      cueId: 'cue1',
      takeId: 't1',
      effects: { reverb: DEFAULT_REVERB },
    })
    expect(p.cues[0].takes[0].edits.effects).toEqual({ reverb: DEFAULT_REVERB })

    applyProjectCommand(p, {
      type: 'cue.setTakeEffects',
      cueId: 'cue1',
      takeId: 't1',
      effects: null,
    })
    expect(p.cues[0].takes[0].edits).toEqual(emptyEdits())
  })

  it('a write that changes nothing leaves the output revision alone', () => {
    const p = project()
    applyProjectCommand(p, {
      type: 'cue.setTakeEffects',
      cueId: 'cue1',
      takeId: 't1',
      effects: { reverb: DEFAULT_REVERB },
    })
    const before = JSON.stringify(p.cues[0].output)
    applyProjectCommand(p, {
      type: 'cue.setTakeEffects',
      cueId: 'cue1',
      takeId: 't1',
      effects: { reverb: DEFAULT_REVERB },
    })
    expect(JSON.stringify(p.cues[0].output)).toBe(before)
  })

  it('refuses a take that is not in the cue', () => {
    expect(() =>
      applyProjectCommand(project(), {
        type: 'cue.setTakeEffects',
        cueId: 'cue1',
        takeId: 'nope',
        effects: null,
      })
    ).toThrow()
  })

  it('is mirrored in the command schema', () => {
    expect(
      projectCommandSchema.parse({
        type: 'cue.setTakeEffects',
        cueId: 'cue1',
        takeId: 't1',
        effects: { delay: { ...DEFAULT_DELAY, enabled: false } },
      })
    ).toEqual({
      type: 'cue.setTakeEffects',
      cueId: 'cue1',
      takeId: 't1',
      effects: { delay: { ...DEFAULT_DELAY, enabled: false } },
    })
  })
})

describe('withSourceEffects', () => {
  it('merges the source effects into a clip that has none and lets the clip override per kind', async () => {
    const { withSourceEffects } = await import('../src/shared/comp')
    const { emptyEdits } = await import('../src/shared/domain')
    const take = { edits: { ...emptyEdits(), effects: { reverb: { mix: 0.3, size: 0.5, decay: 1 }, delay: { time: 0.2, feedback: 0.3, mix: 0.2 } } } }
    const clip = { id: 'c', sourceTakeId: 't', srcIn: 0, srcOut: 1, start: 0, edits: { ...emptyEdits(), effects: { delay: { time: 0.5, feedback: 0.1, mix: 0.1 } } } }
    const out = withSourceEffects(clip, take)
    expect(out.edits.effects?.reverb?.mix).toBe(0.3)
    expect(out.edits.effects?.delay?.time).toBe(0.5)
    expect(withSourceEffects(clip, { edits: emptyEdits() })).toBe(clip)
  })
})

describe('properties tabs follow the newest selection', () => {
  const none = { source: '', clip: '', track: '' }

  it('a timeline clip opens the Clip tab while a library row stays selected', () => {
    const withSource = { ...none, source: 'take-1' }
    expect(propertiesTab(none, withSource, 'line')).toBe('source')
    const withClip = { ...withSource, clip: 'clip-a' }
    expect(propertiesTab(withSource, withClip, 'source')).toBe('clip')
    expect(propertiesTabs(withClip)).toEqual(['clip', 'track', 'line', 'source'])
  })

  it('offers the Source tab only while a library row is selected', () => {
    expect(propertiesTabs(none)).toEqual(['clip', 'track', 'line'])
    expect(propertiesTabs({ ...none, clip: 'clip-a' })).toEqual(['clip', 'track', 'line'])
  })

  it('a library row opens the Source tab while a clip stays selected', () => {
    const withClip = { ...none, clip: 'clip-a' }
    expect(propertiesTab(withClip, { ...withClip, source: 'take-2' }, 'clip')).toBe('source')
  })

  it('keeps a hand-picked tab until the selection changes', () => {
    const withClip = { ...none, clip: 'clip-a' }
    expect(propertiesTab(withClip, withClip, 'track')).toBe('track')
    expect(propertiesTab(withClip, withClip, 'line')).toBe('line')
    expect(propertiesTab(withClip, withClip, 'clip')).toBe('clip')
  })

  it('falls back when the shown target disappears', () => {
    expect(propertiesTab(none, none, 'clip')).toBe('line')
    expect(propertiesTab(none, none, 'source')).toBe('line')
    expect(propertiesTab(none, { ...none, clip: 'clip-a' }, 'source')).toBe('clip')
    expect(propertiesTab(none, { ...none, track: 'tr1' }, 'clip')).toBe('track')
  })

  it('picking a track strip opens the Track tab', () => {
    expect(propertiesTab(none, { ...none, track: 'tr2' }, 'line')).toBe('track')
  })
})

describe('pickEffects — copy and paste an effect stack', () => {
  const full: ClipEffects = {
    reverb: { ...DEFAULT_REVERB },
    delay: { ...DEFAULT_DELAY },
    pitch: { semitones: 3 },
  }

  it('replaces rather than merges and drops what the target cannot hold', () => {
    expect(pickEffects(full, EFFECT_KINDS)).toEqual(full)
    expect(pickEffects(full, TRACK_EFFECT_KINDS)).toEqual({
      reverb: { ...DEFAULT_REVERB },
      delay: { ...DEFAULT_DELAY },
    })
    expect(pickEffects(undefined, EFFECT_KINDS)).toBeUndefined()
    expect(pickEffects({ pitch: { semitones: 3 } }, TRACK_EFFECT_KINDS)).toBeUndefined()
  })

  it('hands out a detached copy, so editing the paste never touches the source', () => {
    const copy = pickEffects(full, EFFECT_KINDS)!
    copy.reverb!.mix = 0.9
    expect(full.reverb!.mix).toBe(DEFAULT_REVERB.mix)
    expect(pickEffects(full, EFFECT_KINDS)!.reverb).not.toBe(full.reverb)
  })

  it('keeps a bypassed effect bypassed through a paste', () => {
    const off: ClipEffects = { delay: { ...DEFAULT_DELAY, enabled: false } }
    expect(pickEffects(off, TRACK_EFFECT_KINDS)?.delay?.enabled).toBe(false)
  })
})
