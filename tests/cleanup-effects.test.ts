import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPRESSOR_ATTACK_MAX,
  COMPRESSOR_MAKEUP_MAX,
  COMPRESSOR_RATIO_MAX,
  COMPRESSOR_RATIO_MIN,
  COMPRESSOR_RELEASE_MIN,
  COMPRESSOR_THRESHOLD_MIN,
  DEFAULT_COMPRESSOR,
  DEFAULT_DELAY,
  DEFAULT_EQ,
  DEFAULT_GATE,
  DEFAULT_HIGHPASS,
  DEFAULT_REVERB,
  EFFECT_KINDS,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  EQ_HIGH_FREQ_MAX,
  EQ_LOW_FREQ_MIN,
  EQ_Q_MIN,
  GATE_ATTACK_MAX,
  GATE_HOLD_MIN,
  GATE_RANGE_MIN,
  GATE_RELEASE_MIN,
  GATE_THRESHOLD_MAX,
  HIGHPASS_FREQ_MAX,
  HIGHPASS_FREQ_MIN,
  TRACK_EFFECT_KINDS,
  effectChain,
  effectsTail,
  hasEffects,
  hasSends,
  pickEffects,
  sanitizeCompressor,
  sanitizeEffects,
  sanitizeEq,
  sanitizeGate,
  sanitizeHighPass,
  setEffectEnabled,
  toggleEffect,
  usesWorklets,
  type ClipEffects,
  type EffectKind,
} from '@shared/effects'
import { compUsesWorklets, normalizeComp, setClipEdits } from '@shared/comp'
import {
  emptyEdits,
  sanitizeCompTracks,
  type CompClip,
  type CompTrack,
  type Cue,
  type Project,
  type Take,
} from '@shared/domain'
import { hasEdits } from '@shared/export-plan'
import { applyProjectCommand } from '@shared/project-commands'
import {
  clipEffectsSchema,
  compSchema,
  compTrackSchema,
  cueSchema,
  projectCommandSchema,
} from '../src/main/schemas'
import { copiedEffects, copyEffects } from '../src/renderer/effects-clipboard'
import { BUTTERWORTH_Q_DB, connectEffects } from '../src/renderer/audio/effects-graph'
import { ensureEffectWorklets } from '../src/renderer/audio/effect-worklets'
import { scheduleComp, type CompSource } from '../src/renderer/audio/clip-graph'

const NEW_KINDS = ['gate', 'highpass', 'eq', 'compressor'] as const

const CLEANUP: ClipEffects = {
  gate: { threshold: -50, attack: 0.002, hold: 0.08, release: 0.2, range: -30 },
  highpass: { frequency: 120 },
  eq: {
    lowFreq: 150,
    lowGain: -3,
    midFreq: 2500,
    midGain: 2.5,
    midQ: 1.4,
    highFreq: 9000,
    highGain: 1.5,
  },
  compressor: { threshold: -20, ratio: 4, attack: 0.005, release: 0.12, knee: 8, makeup: 3 },
}

const FULL: ClipEffects = {
  reverb: { ...DEFAULT_REVERB },
  delay: { ...DEFAULT_DELAY },
  pitch: { semitones: 3 },
  ...CLEANUP,
}

const OLD: ClipEffects = {
  reverb: { mix: 0.3, size: 0.6, decay: 1.5, preDelay: 0.02 },
  delay: { time: 0.3, feedback: 0.4, mix: 0.2, enabled: false },
  pitch: { semitones: -2.5 },
}

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

const json = (v: unknown): string => JSON.stringify(v)

describe('sanitize — the new cleanup effects', () => {
  it('the defaults survive sanitizing unchanged', () => {
    expect(json(sanitizeGate(DEFAULT_GATE))).toBe(json(DEFAULT_GATE))
    expect(json(sanitizeHighPass(DEFAULT_HIGHPASS))).toBe(json(DEFAULT_HIGHPASS))
    expect(json(sanitizeEq(DEFAULT_EQ))).toBe(json(DEFAULT_EQ))
    expect(json(sanitizeCompressor(DEFAULT_COMPRESSOR))).toBe(json(DEFAULT_COMPRESSOR))
    expect(DEFAULT_HIGHPASS.frequency).toBe(80)
  })

  it('clamps every knob into its range', () => {
    expect(sanitizeGate({ threshold: 20, attack: 5, hold: -1, release: 0, range: -500 })).toEqual({
      threshold: GATE_THRESHOLD_MAX,
      attack: GATE_ATTACK_MAX,
      hold: GATE_HOLD_MIN,
      release: GATE_RELEASE_MIN,
      range: GATE_RANGE_MIN,
    })
    expect(sanitizeHighPass({ frequency: 5 }).frequency).toBe(HIGHPASS_FREQ_MIN)
    expect(sanitizeHighPass({ frequency: 9000 }).frequency).toBe(HIGHPASS_FREQ_MAX)
    expect(
      sanitizeEq({
        lowFreq: 1,
        lowGain: 99,
        midFreq: 1000,
        midGain: -99,
        midQ: 0,
        highFreq: 1e6,
        highGain: 0,
      })
    ).toEqual({
      lowFreq: EQ_LOW_FREQ_MIN,
      lowGain: EQ_GAIN_MAX,
      midFreq: 1000,
      midGain: EQ_GAIN_MIN,
      midQ: EQ_Q_MIN,
      highFreq: EQ_HIGH_FREQ_MAX,
      highGain: 0,
    })
    expect(
      sanitizeCompressor({ threshold: -99, ratio: 0, attack: 3, release: 0, knee: 6, makeup: 60 })
    ).toEqual({
      threshold: COMPRESSOR_THRESHOLD_MIN,
      ratio: COMPRESSOR_RATIO_MIN,
      attack: COMPRESSOR_ATTACK_MAX,
      release: COMPRESSOR_RELEASE_MIN,
      knee: 6,
      makeup: COMPRESSOR_MAKEUP_MAX,
    })
    expect(sanitizeCompressor({ ...DEFAULT_COMPRESSOR, ratio: 99 }).ratio).toBe(COMPRESSOR_RATIO_MAX)
  })

  it('turns garbage into the default instead of NaN', () => {
    const nan = NaN as number
    expect(
      sanitizeGate({ threshold: nan, attack: nan, hold: nan, release: nan, range: nan })
    ).toEqual(DEFAULT_GATE)
    expect(sanitizeHighPass({ frequency: Infinity })).toEqual(DEFAULT_HIGHPASS)
    expect(
      sanitizeEq({
        lowFreq: nan,
        lowGain: nan,
        midFreq: nan,
        midGain: nan,
        midQ: nan,
        highFreq: nan,
        highGain: nan,
      })
    ).toEqual(DEFAULT_EQ)
    expect(
      sanitizeCompressor({
        threshold: nan,
        ratio: nan,
        attack: nan,
        release: nan,
        knee: nan,
        makeup: 'x' as unknown as number,
      })
    ).toEqual(DEFAULT_COMPRESSOR)
  })

  it('bypass is kept as false, and true is never written', () => {
    for (const k of NEW_KINDS) {
      const off = sanitizeEffects({ [k]: { ...CLEANUP[k], enabled: false } })
      expect(off?.[k]?.enabled).toBe(false)
      const on = sanitizeEffects({ [k]: { ...CLEANUP[k], enabled: true as unknown as false } })
      expect(on?.[k] && 'enabled' in on[k]!).toBe(false)
    }
  })

  it('a flat EQ stays in the stack — adding it must not make it vanish', () => {
    expect(sanitizeEffects({ eq: DEFAULT_EQ })).toEqual({ eq: DEFAULT_EQ })
    expect(hasEffects({ eq: DEFAULT_EQ })).toBe(true)
  })

  it('new keys come AFTER the old ones, so old files keep their byte order', () => {
    const scrambled = {
      compressor: CLEANUP.compressor,
      eq: CLEANUP.eq,
      pitch: FULL.pitch,
      highpass: CLEANUP.highpass,
      reverb: FULL.reverb,
      gate: CLEANUP.gate,
      delay: FULL.delay,
    } as ClipEffects
    expect(Object.keys(sanitizeEffects(scrambled)!)).toEqual([
      'reverb',
      'delay',
      'pitch',
      'gate',
      'highpass',
      'eq',
      'compressor',
    ])
  })
})

describe('toggle and bypass for every kind', () => {
  it('switching on writes the documented defaults', () => {
    expect(toggleEffect(undefined, 'gate', true)).toEqual({ gate: DEFAULT_GATE })
    expect(toggleEffect(undefined, 'highpass', true)).toEqual({ highpass: DEFAULT_HIGHPASS })
    expect(toggleEffect(undefined, 'eq', true)).toEqual({ eq: DEFAULT_EQ })
    expect(toggleEffect(undefined, 'compressor', true)).toEqual({ compressor: DEFAULT_COMPRESSOR })
  })

  it('switching on hands out a copy, never the shared default object', () => {
    const fx = toggleEffect(undefined, 'eq', true)!
    fx.eq!.lowGain = 6
    expect(DEFAULT_EQ.lowGain).toBe(0)
  })

  it('switching off REMOVES the field and leaves its siblings alone', () => {
    const off = toggleEffect(FULL, 'compressor', false)
    expect(off && 'compressor' in off).toBe(false)
    expect(off?.gate).toEqual(FULL.gate)
    expect(toggleEffect({ gate: DEFAULT_GATE }, 'gate', false)).toBeUndefined()
  })

  it('setEffectEnabled flips one kind and back', () => {
    for (const k of EFFECT_KINDS) {
      const off = setEffectEnabled(FULL, k, false)!
      expect(off[k]?.enabled).toBe(false)
      for (const other of EFFECT_KINDS) if (other !== k) expect(off[other]).toEqual(FULL[other])
      expect(json(setEffectEnabled(off, k, true))).toBe(json(sanitizeEffects(FULL)))
    }
  })

  it('setEffectEnabled on a kind that is not there changes nothing', () => {
    expect(setEffectEnabled({ gate: DEFAULT_GATE }, 'compressor', false)).toEqual({
      gate: DEFAULT_GATE,
    })
    expect(setEffectEnabled(undefined, 'gate', false)).toBeUndefined()
  })
})

describe('what the model tells its consumers', () => {
  it('each new effect counts as an effect, but none is a send and none adds a tail', () => {
    for (const k of NEW_KINDS) {
      const fx = { [k]: CLEANUP[k] } as ClipEffects
      expect(hasEffects(fx)).toBe(true)
      expect(hasSends(fx)).toBe(false)
      expect(effectsTail(fx)).toBe(0)
      expect(hasEdits({ ...emptyEdits(), effects: fx })).toBe(true)
    }
  })

  it('a bypassed cleanup effect is invisible', () => {
    for (const k of NEW_KINDS) {
      const fx = setEffectEnabled({ [k]: CLEANUP[k] }, k, false)
      expect(hasEffects(fx)).toBe(false)
      expect(effectChain(fx)).toEqual([])
      expect(hasEdits({ ...emptyEdits(), effects: fx })).toBe(false)
    }
  })

  it('only gate and pitch need the worklet module', () => {
    expect(usesWorklets({ gate: DEFAULT_GATE })).toBe(true)
    expect(usesWorklets({ pitch: { semitones: 2 } })).toBe(true)
    expect(usesWorklets({ highpass: DEFAULT_HIGHPASS, eq: DEFAULT_EQ })).toBe(false)
    expect(usesWorklets({ compressor: DEFAULT_COMPRESSOR, reverb: DEFAULT_REVERB })).toBe(false)
    expect(usesWorklets({ gate: { ...DEFAULT_GATE, enabled: false } })).toBe(false)
    expect(usesWorklets(undefined)).toBe(false)
  })

  it('a gate on a TRACK loads the worklet module too, not just clips', () => {
    expect(compUsesWorklets([clip()])).toBe(false)
    expect(compUsesWorklets([clip()], [track('track-1', { effects: { gate: DEFAULT_GATE } })])).toBe(
      true
    )
    expect(
      compUsesWorklets([clip({ edits: { ...emptyEdits(), effects: { gate: DEFAULT_GATE } } })])
    ).toBe(true)
    expect(
      compUsesWorklets([clip()], [track('track-1', { effects: { compressor: DEFAULT_COMPRESSOR } })])
    ).toBe(false)
  })
})

describe('effectChain — the one processing order', () => {
  it('gate → high-pass → EQ → compressor → pitch → sends', () => {
    expect(effectChain(FULL)).toEqual(['gate', 'highpass', 'eq', 'compressor', 'pitch', 'sends'])
  })

  it('an old stack keeps exactly the order it had: pitch, then the sends', () => {
    expect(effectChain({ reverb: DEFAULT_REVERB, delay: DEFAULT_DELAY, pitch: { semitones: 2 } })).toEqual(
      ['pitch', 'sends']
    )
    expect(effectChain({ reverb: DEFAULT_REVERB })).toEqual(['sends'])
    expect(effectChain({ pitch: { semitones: 2 } })).toEqual(['pitch'])
    expect(effectChain(undefined)).toEqual([])
    expect(effectChain({})).toEqual([])
  })

  it('the order does not depend on the key order in the file', () => {
    const reversed = Object.fromEntries(Object.entries(FULL).reverse()) as ClipEffects
    expect(effectChain(reversed)).toEqual(effectChain(FULL))
  })

  it('a bypassed stage drops out and the rest keep their places', () => {
    expect(effectChain(setEffectEnabled(FULL, 'eq', false))).toEqual([
      'gate',
      'highpass',
      'compressor',
      'pitch',
      'sends',
    ])
    expect(effectChain({ ...CLEANUP, pitch: { semitones: 0 } })).toEqual([
      'gate',
      'highpass',
      'eq',
      'compressor',
    ])
  })
})

describe('zod mirrors — nothing is eaten on the way to disk', () => {
  const withFx = (fx: ClipEffects): unknown => ({
    clips: [
      {
        id: 'c1',
        sourceTakeId: 't1',
        srcIn: 0,
        srcOut: 2,
        start: 0,
        edits: { ...emptyEdits(), effects: fx },
      },
    ],
  })

  for (const k of NEW_KINDS) {
    it(`${k} on a clip roundtrips byte for byte, bypassed or not`, () => {
      for (const fx of [{ [k]: CLEANUP[k] }, { [k]: { ...CLEANUP[k], enabled: false } }] as ClipEffects[]) {
        const parsed = compSchema.parse(JSON.parse(json(withFx(fx))))
        expect(json(parsed?.clips[0].edits.effects)).toBe(json(sanitizeEffects(fx)))
      }
    })

    it(`${k} on a track roundtrips byte for byte`, () => {
      const t = track('track-1', { effects: { [k]: CLEANUP[k] } as ClipEffects })
      const parsed = compTrackSchema.parse(JSON.parse(json(t)))
      expect(json(parsed)).toBe(json(t))
      expect(json(sanitizeCompTracks([t]))).toBe(json([t]))
    })
  }

  it('the whole stack roundtrips on a clip in sanitize order', () => {
    const parsed = compSchema.parse(JSON.parse(json(withFx(sanitizeEffects(FULL)!))))
    expect(json(parsed?.clips[0].edits.effects)).toBe(json(sanitizeEffects(FULL)))
  })

  it('a track keeps every cleanup effect and still drops pitch', () => {
    const t = track('track-1', { effects: FULL })
    const { pitch: _pitch, ...trackFx } = sanitizeEffects(FULL)!
    expect(compTrackSchema.parse(JSON.parse(json(t))).effects).toEqual(trackFx)
    expect(sanitizeCompTracks([t])?.[0].effects).toEqual(trackFx)
    expect(json(sanitizeCompTracks([t])?.[0].effects)).toBe(json(trackFx))
  })

  it('a cue with cleanup effects on the take, the clip and the track survives the file schema', () => {
    const c = cue({
      takes: [take({ edits: { ...emptyEdits(), effects: sanitizeEffects(FULL) } })],
      comp: {
        clips: [clip({ edits: { ...emptyEdits(), effects: sanitizeEffects(CLEANUP) } })],
        tracks: [track('track-1', { effects: sanitizeEffects(CLEANUP) })],
      },
    })
    expect(json(cueSchema.parse(JSON.parse(json(c))))).toBe(json(c))
  })

  it('the command that writes source effects carries them', () => {
    const cmd = { type: 'cue.setTakeEffects', cueId: 'cue1', takeId: 't1', effects: sanitizeEffects(FULL) }
    const parsed = projectCommandSchema.parse(JSON.parse(json(cmd)))
    expect(parsed).toEqual(cmd)
    expect(json((parsed as { effects: unknown }).effects)).toBe(json(cmd.effects))
  })

  it('a value the UI cannot produce is rejected, not silently clamped', () => {
    const bad: unknown[] = [
      { gate: { ...DEFAULT_GATE, threshold: 5 } },
      { gate: { ...DEFAULT_GATE, range: -100 } },
      { gate: { ...DEFAULT_GATE, enabled: true } },
      { highpass: { frequency: 10 } },
      { highpass: { frequency: 500 } },
      { eq: { ...DEFAULT_EQ, midGain: 24 } },
      { eq: { ...DEFAULT_EQ, midQ: 0 } },
      { compressor: { ...DEFAULT_COMPRESSOR, ratio: 30 } },
      { compressor: { ...DEFAULT_COMPRESSOR, makeup: -1 } },
      { compressor: { ...DEFAULT_COMPRESSOR, threshold: NaN } },
    ]
    for (const fx of bad) expect(clipEffectsSchema.safeParse(fx).success).toBe(false)
  })
})

describe('old projects are byte-identical', () => {
  const oldComp = {
    clips: [
      clip({ edits: { ...emptyEdits(), effects: OLD } }),
      clip({ id: 'c2', srcOut: 1, start: 2, trackId: 'track-2' }),
    ],
    tracks: [
      track('track-1', { name: 'Track 1', effects: { reverb: OLD.reverb } }),
      track('track-2', { name: 'Track 2', gainDb: -3 }),
    ],
  }

  it('an old comp with reverb, delay and pitch parses and normalizes unchanged', () => {
    const raw = JSON.parse(json(oldComp))
    expect(json(compSchema.parse(raw))).toBe(json(oldComp))
    expect(json(normalizeComp(raw))).toBe(json(oldComp))
  })

  it('an old effect set sanitizes byte-identical', () => {
    expect(json(sanitizeEffects(JSON.parse(json(OLD))))).toBe(json(OLD))
  })

  it('an unrelated clip edit writes no new keys', () => {
    const after = setClipEdits(normalizeComp(JSON.parse(json(oldComp))), 'c1', { gainDb: -2 })
    expect(Object.keys(after.clips[0].edits.effects!)).toEqual(['reverb', 'delay', 'pitch'])
    expect(json(after.clips[0].edits.effects)).toBe(json(OLD))
  })

  it('the clip and track pickers leave an old stack as it was', () => {
    expect(json(pickEffects(OLD, EFFECT_KINDS))).toBe(json(OLD))
    const { pitch: _pitch, ...trackOld } = OLD
    expect(json(pickEffects(OLD, TRACK_EFFECT_KINDS))).toBe(json(trackOld))
  })
})

describe('effects clipboard carries the cleanup stack', () => {
  it('copy → paste onto a clip keeps every effect and its bypass', () => {
    const fx = setEffectEnabled(FULL, 'gate', false)
    copyEffects(fx)
    expect(json(pickEffects(copiedEffects(), EFFECT_KINDS))).toBe(json(sanitizeEffects(fx)))
  })

  it('copy from a clip → paste onto a track drops only pitch', () => {
    copyEffects(FULL)
    const pasted = pickEffects(copiedEffects(), TRACK_EFFECT_KINDS)!
    expect(Object.keys(pasted)).toEqual(['reverb', 'delay', 'gate', 'highpass', 'eq', 'compressor'])
    for (const k of NEW_KINDS) expect(pasted[k]).toEqual(FULL[k])
  })

  it('the clipboard holds a snapshot, not a live reference', () => {
    const fx = { ...CLEANUP, eq: { ...CLEANUP.eq! } }
    copyEffects(fx)
    fx.eq.lowGain = 12
    expect(copiedEffects()?.eq?.lowGain).toBe(CLEANUP.eq!.lowGain)
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

function cue(over: Partial<Cue> = {}): Cue {
  return {
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
  }
}

const project = (): Project =>
  ({
    name: 'p',
    characters: [],
    cues: [cue()],
    sessions: [],
    pronunciationRules: '',
    exportTemplate: '{exportName}.{ext}',
  }) as unknown as Project

describe('source effects command — the path the fx undo history replays', () => {
  it('writes the cleanup stack and an undo snapshot restores the previous one exactly', () => {
    const p = project()
    const set = (effects: ClipEffects | null): void => {
      applyProjectCommand(p, { type: 'cue.setTakeEffects', cueId: 'cue1', takeId: 't1', effects })
    }
    set(OLD)
    const prev = p.cues[0].takes[0].edits.effects
    set({ ...OLD, ...CLEANUP })
    expect(json(p.cues[0].takes[0].edits.effects)).toBe(json(sanitizeEffects({ ...OLD, ...CLEANUP })))
    set(prev ?? null)
    expect(json(p.cues[0].takes[0].edits.effects)).toBe(json(OLD))
    set(null)
    expect(p.cues[0].takes[0].edits).toEqual(emptyEdits())
  })
})

interface FakeNode {
  kind: string
  type?: string
  processor?: string
  options?: Record<string, unknown>
  to: FakeNode[]
  connect: (t: FakeNode) => FakeNode
  [k: string]: unknown
}

const param = (value = 0): Record<string, unknown> => ({
  value,
  setValueAtTime: () => undefined,
  setValueCurveAtTime: () => undefined,
  linearRampToValueAtTime: () => undefined,
})

function fakeContext(): { ctx: BaseAudioContext; made: FakeNode[]; modules: string[] } {
  const made: FakeNode[] = []
  const modules: string[] = []
  const node = (kind: string, extra: Record<string, unknown> = {}): FakeNode => {
    const n: FakeNode = {
      kind,
      to: [],
      connect(t: FakeNode) {
        this.to.push(t)
        return t
      },
      ...extra,
    }
    made.push(n)
    return n
  }
  const ctx = {
    sampleRate: 48000,
    currentTime: 0,
    audioWorklet: {
      addModule: (url: string) => {
        modules.push(url)
        return Promise.resolve()
      },
    },
    createGain: () => node('gain', { gain: param(1) }),
    createBiquadFilter: () =>
      node('biquad', { type: 'lowpass', frequency: param(350), gain: param(0), Q: param(1) }),
    createDynamicsCompressor: () =>
      node('compressor', {
        threshold: param(-24),
        ratio: param(12),
        attack: param(0.003),
        release: param(0.25),
        knee: param(30),
      }),
    createConvolver: () => node('convolver', { normalize: true, buffer: null }),
    createDelay: () => node('delay', { delayTime: param(0) }),
    createBuffer: (channels: number, frames: number) => ({
      numberOfChannels: channels,
      length: frames,
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () =>
      node('source', { buffer: null, playbackRate: param(1), start: () => undefined, stop: () => undefined }),
  }
  class FakeWorkletNode {
    constructor(_ctx: unknown, processor: string, options: Record<string, unknown>) {
      return node('worklet', { processor, options })
    }
  }
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  return { ctx: ctx as unknown as BaseAudioContext, made, modules }
}

const label = (n: FakeNode): string =>
  n.kind === 'biquad'
    ? `biquad:${n.type}`
    : n.kind === 'worklet'
      ? `worklet:${n.processor}`
      : n.kind

function inputNode(): FakeNode {
  return {
    kind: 'input',
    to: [],
    connect(t: FakeNode) {
      this.to.push(t)
      return t
    },
  }
}

function serial(from: FakeNode, steps: number): string[] {
  const out: string[] = []
  let n = from
  for (let i = 0; i < steps; i++) {
    expect(n.to).toHaveLength(1)
    n = n.to[0]
    out.push(label(n))
  }
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connectEffects builds the chain in effectChain order', () => {
  it('gate → high-pass → EQ → compressor → makeup → pitch → sends, one serial path', async () => {
    const { ctx } = fakeContext()
    await ensureEffectWorklets(ctx)
    const input = inputNode()
    const out = connectEffects(ctx, input as unknown as AudioNode, FULL, 2) as unknown as FakeNode
    expect(serial(input, 8)).toEqual([
      'worklet:vo-gate',
      'biquad:highpass',
      'biquad:lowshelf',
      'biquad:peaking',
      'biquad:highshelf',
      'compressor',
      'gain',
      'worklet:vo-pitch',
    ])
    let pitch = input
    for (let i = 0; i < 8; i++) pitch = pitch.to[0]
    expect(pitch.to.map(label).sort()).toEqual(['convolver', 'delay', 'gain'])
    expect(out.kind).toBe('gain')
  })

  it('every node carries the sanitized parameters', async () => {
    const { ctx, made } = fakeContext()
    await ensureEffectWorklets(ctx)
    connectEffects(ctx, inputNode() as unknown as AudioNode, CLEANUP, 1)
    const byLabel = (l: string): FakeNode[] => made.filter((n) => label(n) === l)
    const val = (n: FakeNode, k: string): unknown => (n[k] as { value: number }).value
    expect(byLabel('worklet:vo-gate')[0].options?.processorOptions).toEqual(CLEANUP.gate)
    expect(byLabel('worklet:vo-gate')[0].options?.channelCountMode).toBe('max')
    expect(byLabel('worklet:vo-gate')[0].options?.outputChannelCount).toBeUndefined()
    const hp = byLabel('biquad:highpass')[0]
    expect(val(hp, 'frequency')).toBe(120)
    expect(val(hp, 'Q')).toBeCloseTo(BUTTERWORTH_Q_DB, 12)
    expect(BUTTERWORTH_Q_DB).toBeCloseTo(-3.0103, 4)
    const [low] = byLabel('biquad:lowshelf')
    const [mid] = byLabel('biquad:peaking')
    const [high] = byLabel('biquad:highshelf')
    expect([val(low, 'frequency'), val(low, 'gain')]).toEqual([150, -3])
    expect([val(mid, 'frequency'), val(mid, 'gain'), val(mid, 'Q')]).toEqual([2500, 2.5, 1.4])
    expect([val(high, 'frequency'), val(high, 'gain')]).toEqual([9000, 1.5])
    const [k] = byLabel('compressor')
    expect(['threshold', 'ratio', 'attack', 'release', 'knee'].map((p) => val(k, p))).toEqual([
      -20, 4, 0.005, 0.12, 8,
    ])
    expect(val(k.to[0], 'gain')).toBeCloseTo(Math.pow(10, 3 / 20), 12)
  })

  it('an old stack builds no cleanup nodes at all', async () => {
    const { ctx, made } = fakeContext()
    await ensureEffectWorklets(ctx)
    const input = inputNode()
    connectEffects(ctx, input as unknown as AudioNode, OLD, 2)
    expect(made.map(label).filter((l) => l.startsWith('biquad') || l === 'compressor')).toEqual([])
    expect(made.map(label).filter((l) => l === 'worklet:vo-gate')).toEqual([])
    expect(label(input.to[0])).toBe('worklet:vo-pitch')
  })

  it('both processors are registered by the one ensure call', async () => {
    const { ctx, modules } = fakeContext()
    await ensureEffectWorklets(ctx)
    await ensureEffectWorklets(ctx)
    expect(modules).toHaveLength(2)
  })

  it('before the module is ready the gate passes audio through and starts loading', () => {
    const { ctx, modules } = fakeContext()
    const input = inputNode()
    connectEffects(ctx, input as unknown as AudioNode, { gate: DEFAULT_GATE, highpass: DEFAULT_HIGHPASS }, 1)
    expect(label(input.to[0])).toBe('biquad:highpass')
    expect(modules.length).toBeGreaterThan(0)
  })
})

describe('scheduleComp routes the cleanup stack through clip and track alike', () => {
  const buffer = { duration: 2, numberOfChannels: 1, sampleRate: 48000 } as unknown as AudioBuffer

  it('a compressor on a track sits on the track bus, a high-pass on the clip sits on the clip', () => {
    const { ctx, made } = fakeContext()
    const destination = inputNode()
    const sources: CompSource[] = [
      {
        clip: clip({ edits: { ...emptyEdits(), effects: { highpass: DEFAULT_HIGHPASS } } }),
        buffer,
      },
    ]
    const tracks = [track('track-1', { effects: { compressor: DEFAULT_COMPRESSOR } })]
    const s = scheduleComp(ctx, sources, destination as unknown as AudioNode, { tracks })
    const out = s.voices[0].output as unknown as FakeNode
    expect(label(out)).toBe('biquad:highpass')
    const bus = out.to[0]
    expect(label(bus)).toBe('gain')
    expect(serial(bus, 2)).toEqual(['compressor', 'gain'])
    expect(bus.to[0].to[0].to[0]).toBe(destination)
    expect(made.filter((n) => n.kind === 'compressor')).toHaveLength(1)
  })
})

describe('every kind has a label-free identity in both lists', () => {
  it('clips offer every kind, tracks every kind but pitch, cleanup first', () => {
    expect(EFFECT_KINDS).toEqual(['gate', 'highpass', 'eq', 'compressor', 'reverb', 'delay', 'pitch'])
    expect(TRACK_EFFECT_KINDS).toEqual(EFFECT_KINDS.filter((k: EffectKind) => k !== 'pitch'))
  })
})
