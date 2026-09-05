import { describe, expect, it } from 'vitest'
import { mergeEffects } from '../src/shared/effects'
import {
  compEffectsTail,
  compHasReverb,
  normalizeComp,
  setClipEdits,
  splitClipAt,
} from '@shared/comp'
import { emptyEdits, type ClipEdits, type CompClip, type CueComp } from '@shared/domain'
import {
  DEFAULT_DELAY,
  DEFAULT_REVERB,
  DELAY_FEEDBACK_MAX,
  MAX_EFFECT_TAIL,
  REVERB_DECAY_MAX,
  REVERB_DECAY_MIN,
  delayTail,
  effectsTail,
  hasEffects,
  mixGains,
  reverbTail,
  sanitizeDelay,
  sanitizeEffects,
  sanitizeReverb,
  toggleEffect,
  type ClipEffects,
} from '@shared/effects'
import { clipEffectsSchema, compSchema } from '../src/main/schemas'
import { hasEdits } from '@shared/export-plan'

const clip = (over: Partial<CompClip> = {}): CompClip => ({
  id: 'c1',
  sourceTakeId: 't1',
  srcIn: 0,
  srcOut: 2,
  start: 0,
  edits: emptyEdits(),
  ...over,
})

const comp = (clips: CompClip[]): CueComp => normalizeComp({ clips })

describe('sanitize', () => {
  it('clamps reverb into the knob range', () => {
    const r = sanitizeReverb({ mix: 5, size: -3, decay: 999 })
    expect(r.mix).toBe(1)
    expect(r.size).toBe(0)
    expect(r.decay).toBe(REVERB_DECAY_MAX)
    expect(sanitizeReverb({ mix: 0.5, size: 0.5, decay: 0 }).decay).toBe(REVERB_DECAY_MIN)
  })

  it('never lets feedback reach 1 — self-oscillation is arithmetically impossible', () => {
    expect(sanitizeDelay({ time: 0.2, feedback: 1, mix: 0.5 }).feedback).toBe(DELAY_FEEDBACK_MAX)
    expect(sanitizeDelay({ time: 0.2, feedback: 12, mix: 0.5 }).feedback).toBe(DELAY_FEEDBACK_MAX)
    expect(DELAY_FEEDBACK_MAX).toBeLessThan(1)
  })

  it('turns garbage into the default instead of NaN', () => {
    const r = sanitizeReverb({ mix: NaN, size: Infinity, decay: undefined as unknown as number })
    expect(Number.isFinite(r.mix)).toBe(true)
    expect(Number.isFinite(r.size)).toBe(true)
    expect(r.decay).toBe(DEFAULT_REVERB.decay)
    const d = sanitizeDelay({ time: NaN, feedback: NaN, mix: NaN })
    expect(d).toEqual(DEFAULT_DELAY)
  })

  it('keeps preDelay absent when it was absent', () => {
    expect('preDelay' in sanitizeReverb({ mix: 0.2, size: 0.5, decay: 1 })).toBe(false)
    expect(sanitizeReverb({ mix: 0.2, size: 0.5, decay: 1, preDelay: 9 }).preDelay).toBe(0.2)
  })

  it('an empty set is undefined, not an empty object', () => {
    expect(sanitizeEffects(undefined)).toBeUndefined()
    expect(sanitizeEffects({})).toBeUndefined()
    expect(hasEffects(sanitizeEffects({}))).toBe(false)
    expect(sanitizeEffects({ reverb: DEFAULT_REVERB })).toEqual({ reverb: DEFAULT_REVERB })
  })
})

describe('toggleEffect', () => {
  it('switches on with the documented defaults', () => {
    expect(toggleEffect(undefined, 'reverb', true)).toEqual({ reverb: DEFAULT_REVERB })
    expect(toggleEffect(undefined, 'delay', true)).toEqual({ delay: DEFAULT_DELAY })
  })

  it('switching off REMOVES the field, it does not zero the mix', () => {
    const both: ClipEffects = { reverb: DEFAULT_REVERB, delay: DEFAULT_DELAY }
    const off = toggleEffect(both, 'reverb', false)
    expect(off).toEqual({ delay: DEFAULT_DELAY })
    expect(off && 'reverb' in off).toBe(false)
    expect(toggleEffect({ delay: DEFAULT_DELAY }, 'delay', false)).toBeUndefined()
  })
})

describe('mixGains', () => {
  it('is equal-power: dry² + wet² = 1', () => {
    for (const m of [0, 0.25, 0.3, 0.5, 0.77, 1]) {
      const { dry, wet } = mixGains(m)
      expect(dry * dry + wet * wet).toBeCloseTo(1, 12)
    }
  })

  it('leaves the dry signal untouched at mix 0 and gone at mix 1', () => {
    expect(mixGains(0)).toEqual({ dry: 1, wet: 0 })
    expect(mixGains(1).dry).toBeCloseTo(0, 12)
    expect(mixGains(1).wet).toBe(1)
  })

  it('does not drop the voice by 2.5 dB the moment reverb is switched on', () => {
    expect(mixGains(DEFAULT_REVERB.mix).dry).toBeGreaterThan(0.9)
  })
})

describe('tail', () => {
  it('reverb tail is preDelay + decay', () => {
    expect(reverbTail({ mix: 0.3, size: 0.5, decay: 1.2 })).toBeCloseTo(1.2, 9)
    expect(reverbTail({ mix: 0.3, size: 0.5, decay: 1.2, preDelay: 0.05 })).toBeCloseTo(1.25, 9)
  })

  it('delay tail is the number of repeats down to −60 dB', () => {
    expect(delayTail(DEFAULT_DELAY)).toBeCloseTo(1.75, 9)
    expect(delayTail({ time: 0.4, feedback: 0, mix: 0.5 })).toBeCloseTo(0.4, 9)
    expect(delayTail({ time: 0.1, feedback: 0.5, mix: 0.5 })).toBeCloseTo(1, 9)
  })

  it('caps the tail — feedback 0.9 alone would run for two minutes', () => {
    const raw = delayTail({ time: 2, feedback: DELAY_FEEDBACK_MAX, mix: 1 })
    expect(raw).toBeGreaterThan(100)
    expect(effectsTail({ delay: { time: 2, feedback: DELAY_FEEDBACK_MAX, mix: 1 } })).toBe(
      MAX_EFFECT_TAIL
    )
  })

  it('a set of effects tails as long as its LONGEST send, not their sum', () => {
    const fx: ClipEffects = { reverb: { mix: 0.3, size: 0.5, decay: 3 }, delay: DEFAULT_DELAY }
    expect(effectsTail(fx)).toBeCloseTo(3, 9)
  })

  it('no effects means no tail at all', () => {
    expect(effectsTail(undefined)).toBe(0)
    expect(compEffectsTail([clip(), clip({ id: 'c2', start: 2, srcIn: 0, srcOut: 2 })])).toBe(0)
  })

  it('measures the tail from the clip that carries it, not from the last clip', () => {
    const fx: ClipEffects = { reverb: { mix: 0.3, size: 0.5, decay: 5 } }
    const clips = [
      clip({ edits: { ...emptyEdits(), effects: fx } }),
      clip({ id: 'c2', start: 2, srcIn: 0, srcOut: 2 }),
    ]
    expect(compEffectsTail(clips)).toBeCloseTo(3, 9)
  })

  it('adds nothing when the tail dies inside the composition', () => {
    const fx: ClipEffects = { reverb: { mix: 0.3, size: 0.5, decay: 0.5 } }
    const clips = [
      clip({ edits: { ...emptyEdits(), effects: fx } }),
      clip({ id: 'c2', start: 2, srcIn: 0, srcOut: 2 }),
    ]
    expect(compEffectsTail(clips)).toBe(0)
  })

  it('knows when the render must be stereo', () => {
    expect(compHasReverb([clip()])).toBe(false)
    expect(compHasReverb([clip({ edits: { ...emptyEdits(), effects: { delay: DEFAULT_DELAY } } })])).toBe(
      false
    )
    expect(
      compHasReverb([clip({ edits: { ...emptyEdits(), effects: { reverb: DEFAULT_REVERB } } })])
    ).toBe(true)
  })
})

describe('setClipEdits and effects', () => {
  it('clamps effects that arrive through the normal edit path', () => {
    const c = comp([clip()])
    const next = setClipEdits(c, 'c1', {
      effects: { delay: { time: 99, feedback: 4, mix: 3 } },
    })
    const d = next.clips[0].edits.effects?.delay
    expect(d).toEqual({ time: 2, feedback: DELAY_FEEDBACK_MAX, mix: 1 })
  })

  it('DELETES the key when the last effect is switched off', () => {
    const on = setClipEdits(comp([clip()]), 'c1', { effects: { reverb: DEFAULT_REVERB } })
    expect(on.clips[0].edits.effects).toEqual({ reverb: DEFAULT_REVERB })
    const off = setClipEdits(on, 'c1', { effects: undefined })
    expect('effects' in off.clips[0].edits).toBe(false)
    const never = setClipEdits(comp([clip()]), 'c1', {})
    expect(JSON.parse(JSON.stringify(off))).toEqual(JSON.parse(JSON.stringify(never)))
  })

  it('leaves an effect-free clip byte-for-byte the same after an unrelated edit', () => {
    const before = comp([clip()])
    const after = setClipEdits(before, 'c1', { gainDb: -3 })
    expect('effects' in after.clips[0].edits).toBe(false)
    expect(JSON.stringify({ ...after.clips[0].edits, gainDb: 0 })).toBe(
      JSON.stringify({ ...before.clips[0].edits, timeStretch: 1 })
    )
  })

  it('carries effects across a cut — both halves keep sounding the same', () => {
    const fx: ClipEffects = { reverb: DEFAULT_REVERB }
    const c = comp([clip({ srcOut: 4, edits: { ...emptyEdits(), effects: fx } })])
    const split = splitClipAt(c, 'c1', 2)
    expect(split.clips).toHaveLength(2)
    for (const x of split.clips) expect(x.edits.effects).toEqual(fx)
  })

  it('effects kill the byte-copy fast path', () => {
    const plain: ClipEdits = emptyEdits()
    expect(hasEdits(plain)).toBe(false)
    expect(hasEdits({ ...plain, effects: { reverb: DEFAULT_REVERB } })).toBe(true)
    expect(hasEdits({ ...plain, effects: { delay: DEFAULT_DELAY } })).toBe(true)
  })
})

describe('zod roundtrip', () => {
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

  it('does not eat the effects on the way to disk', () => {
    const fx: ClipEffects = { reverb: { mix: 0.4, size: 0.7, decay: 2.5 }, delay: DEFAULT_DELAY }
    const parsed = compSchema.parse(withFx(fx))
    expect(parsed?.clips[0].edits.effects).toEqual(fx)
  })

  it('keeps preDelay when it is there', () => {
    const fx: ClipEffects = { reverb: { mix: 0.4, size: 0.7, decay: 2.5, preDelay: 0.08 } }
    expect(compSchema.parse(withFx(fx))?.clips[0].edits.effects).toEqual(fx)
  })

  it('accepts an old comp with no effects at all and adds nothing', () => {
    const old = {
      clips: [{ id: 'c1', sourceTakeId: 't1', srcIn: 0, srcOut: 2, start: 0, edits: emptyEdits() }],
    }
    const parsed = compSchema.parse(old)
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(old))
    expect('effects' in (parsed?.clips[0].edits ?? {})).toBe(false)
  })

  it('mirrors the shared clamps — a value the UI cannot produce is rejected', () => {
    expect(clipEffectsSchema.safeParse({ delay: { time: 0.2, feedback: 0.95, mix: 0.5 } }).success).toBe(
      false
    )
    expect(clipEffectsSchema.safeParse({ reverb: { mix: 1.5, size: 0.5, decay: 1 } }).success).toBe(false)
    expect(clipEffectsSchema.safeParse({ reverb: { mix: 0.5, size: 0.5, decay: 20 } }).success).toBe(
      false
    )
    expect(
      clipEffectsSchema.safeParse({ reverb: { mix: 0.5, size: 0.5, decay: 1, preDelay: 0.5 } }).success
    ).toBe(false)
  })
})

describe('mergeEffects', () => {
  const current = {
    reverb: { mix: 0.3, size: 0.5, decay: 1.2 },
    delay: { time: 0.25, feedback: 0.4, mix: 0.2 },
    pitch: { semitones: 2 },
  }

  it('patches one reverb field and keeps its siblings', () => {
    expect(mergeEffects(current, { reverb: { mix: 0.8 } })).toEqual({
      ...current,
      reverb: { mix: 0.8, size: 0.5, decay: 1.2 },
    })
  })

  it('patches delay and pitch without touching reverb', () => {
    expect(mergeEffects(current, { delay: { feedback: 0.1 }, pitch: { semitones: -3 } })).toEqual({
      reverb: current.reverb,
      delay: { time: 0.25, feedback: 0.1, mix: 0.2 },
      pitch: { semitones: -3 },
    })
  })

  it('ignores a patch for an effect that is off', () => {
    expect(mergeEffects({ pitch: { semitones: 1 } }, { reverb: { mix: 0.5 } })).toEqual({ pitch: { semitones: 1 } })
    expect(mergeEffects(undefined, { delay: { mix: 0.5 } })).toEqual({})
  })
})
