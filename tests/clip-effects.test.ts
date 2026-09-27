import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DELAY,
  DEFAULT_REVERB,
  EFFECT_KINDS,
  effectChain,
  hasEffects,
  pickEffects,
  reverbTail,
  setEffectEnabled,
  toggleEffect,
  type ClipEffects,
} from '@shared/effects'
import { compEffectsTail, setClipEdits, splitClipAt, withSourceEffects } from '@shared/comp'
import { nextCompEdit, recordCompEdit, stepCompEdit, type CompHistory } from '@shared/comp-history'
import { resolveCompClips } from '@shared/export-plan'
import { emptyEdits, type CompClip, type Cue, type CueComp, type Take } from '@shared/domain'
import { compSchema, projectCommandSchema } from '../src/main/schemas'
import { copiedEffects, copyEffects } from '../src/renderer/effects-clipboard'

const json = (v: unknown): string => JSON.stringify(v)

const TAKE_FX: ClipEffects = { reverb: { ...DEFAULT_REVERB } }

const take = (effects?: ClipEffects): Take => ({
  id: 't1',
  kind: 'recording',
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: 'f1', relPath: 'takes/t1.wav', format: 'wav' },
  duration: 4,
  meta: {},
  edits: { ...emptyEdits(), ...(effects ? { effects } : {}) },
})

const whole = (): CueComp => ({
  clips: [{ id: 'a', sourceTakeId: 't1', srcIn: 0, srcOut: 4, start: 0, edits: emptyEdits() }],
})

const split = (): CueComp => splitClipAt(whole(), 'a', 2, { left: 'L', right: 'R' })

const cue = (comp: CueComp, effects?: ClipEffects): Cue => ({
  id: 'cue1',
  characterId: 'ch',
  key: 'K1',
  fields: {},
  sourceText: 'src',
  text: 'txt',
  status: 'generated',
  notes: '',
  takes: [take(effects)],
  comp,
})

const clipOf = (comp: CueComp, id: string): CompClip => comp.clips.find((c) => c.id === id)!

const setFx = (comp: CueComp, id: string, fx: ClipEffects | undefined): CueComp =>
  setClipEdits(comp, id, { effects: fx })

const badge = (clip: CompClip, t: Take): boolean => hasEffects(withSourceEffects(clip, t).edits.effects)

describe('clip effects edit one clip, never its siblings from the same take', () => {
  it('adding reverb to the left half leaves the right half byte-identical', () => {
    const before = split()
    const after = setFx(before, 'L', toggleEffect(clipOf(before, 'L').edits.effects, 'reverb', true))
    expect(clipOf(after, 'L').edits.effects).toEqual({ reverb: DEFAULT_REVERB })
    expect(json(clipOf(after, 'R'))).toBe(json(clipOf(before, 'R')))
    expect('effects' in clipOf(before, 'L').edits).toBe(false)
  })

  it('removing the last effect drops the key instead of writing undefined', () => {
    const on = setFx(split(), 'L', { reverb: DEFAULT_REVERB })
    const off = setFx(on, 'L', toggleEffect(clipOf(on, 'L').edits.effects, 'reverb', false))
    expect('effects' in clipOf(off, 'L').edits).toBe(false)
    expect(json(off)).toBe(json(setClipEdits(split(), 'L', {})))
  })

  it('bypass is kept on the clip and silences it for playback and the badge', () => {
    const on = setFx(split(), 'L', { reverb: DEFAULT_REVERB, delay: DEFAULT_DELAY })
    const off = setFx(on, 'L', setEffectEnabled(clipOf(on, 'L').edits.effects, 'reverb', false))
    expect(clipOf(off, 'L').edits.effects?.reverb?.enabled).toBe(false)
    expect(effectChain(clipOf(off, 'L').edits.effects)).toEqual(['sends'])
    const bypassed = setFx(off, 'L', setEffectEnabled(clipOf(off, 'L').edits.effects, 'delay', false))
    expect(badge(clipOf(bypassed, 'L'), take())).toBe(false)
  })

  it('a tweak is clamped by the same sanitizer as every other effect', () => {
    const next = setFx(split(), 'L', { reverb: { ...DEFAULT_REVERB, mix: 5, decay: -1 } })
    expect(clipOf(next, 'L').edits.effects?.reverb).toEqual({ ...DEFAULT_REVERB, mix: 1, decay: 0.1 })
  })

  it('the clip stack survives the zod mirror on its way to disk', () => {
    const comp = setFx(split(), 'L', { reverb: { ...DEFAULT_REVERB, enabled: false }, pitch: { semitones: 3 } })
    expect(compSchema.parse(JSON.parse(json(comp)))).toEqual(comp)
    const cmd = { type: 'cue.setComp', cueId: 'cue1', comp }
    expect(projectCommandSchema.parse(JSON.parse(json(cmd)))).toEqual(cmd)
  })
})

describe('take effects under clip effects', () => {
  it('a clip inherits the take stack and overrides it per kind', () => {
    const t = take({ reverb: DEFAULT_REVERB, delay: DEFAULT_DELAY })
    const own = setFx(split(), 'L', { delay: { ...DEFAULT_DELAY, time: 0.5 } })
    const merged = withSourceEffects(clipOf(own, 'L'), t).edits.effects
    expect(merged?.reverb).toEqual(DEFAULT_REVERB)
    expect(merged?.delay?.time).toBe(0.5)
    expect(withSourceEffects(clipOf(own, 'R'), t).edits.effects).toEqual(t.edits.effects)
  })

  it('a bypassed clip effect silences the inherited one of the same kind on that clip only', () => {
    const t = take(TAKE_FX)
    const comp = setFx(split(), 'L', { reverb: { ...DEFAULT_REVERB, enabled: false } })
    expect(badge(clipOf(comp, 'L'), t)).toBe(false)
    expect(badge(clipOf(comp, 'R'), t)).toBe(true)
  })

  it('the badge shows inherited effects and hides a bypassed take effect', () => {
    const c = clipOf(split(), 'R')
    expect(badge(c, take(TAKE_FX))).toBe(true)
    expect(badge(c, take(setEffectEnabled(TAKE_FX, 'reverb', false)))).toBe(false)
    expect(badge(c, take())).toBe(false)
  })
})

describe('an old project with take effects plays exactly as before', () => {
  const OLD = json(cue(split(), TAKE_FX))

  it('every clip resolves to the take chain and the data stays byte-identical', () => {
    const c = JSON.parse(OLD) as Cue
    const resolved = resolveCompClips(undefined, c, c.comp!)
    for (const r of resolved) {
      expect(json(r.clip.edits.effects)).toBe(json(TAKE_FX))
      expect(effectChain(r.clip.edits.effects)).toEqual(['sends'])
    }
    expect(json(c)).toBe(OLD)
    expect(json(compSchema.parse(c.comp))).toBe(json(c.comp))
  })

  it('a clip edit on one half leaves the other half resolving to the old chain', () => {
    const c = JSON.parse(OLD) as Cue
    const edited = { ...c, comp: setFx(c.comp!, 'L', { delay: DEFAULT_DELAY }) }
    const [left, right] = resolveCompClips(undefined, edited, edited.comp)
    expect(json(right.clip.edits.effects)).toBe(json(TAKE_FX))
    expect(left.clip.edits.effects).toEqual({ ...TAKE_FX, delay: DEFAULT_DELAY })
    expect(json(edited.takes)).toBe(json(c.takes))
  })
})

describe('export length follows the clip that carries the tail', () => {
  it('reverb on the last clip extends the render; on an earlier, longer-covered clip it does not', () => {
    const short = { ...DEFAULT_REVERB, decay: 0.5 }
    const onRight = setFx(split(), 'R', { reverb: short })
    expect(compEffectsTail(onRight.clips)).toBeCloseTo(reverbTail(short))
    const onLeft = setFx(split(), 'L', { reverb: short })
    expect(compEffectsTail(onLeft.clips)).toBe(0)
  })
})

describe('clip effect edits undo in the timeline history', () => {
  it('undo restores the clip without effects, redo brings them back', () => {
    const history: CompHistory = new Map()
    const prev = split()
    const next = setFx(prev, 'L', { reverb: DEFAULT_REVERB })
    recordCompEdit(history, 'cue1', prev, 10)
    expect(nextCompEdit(history, 'undo')).toEqual({ cueId: 'cue1', at: 10 })
    const undo = stepCompEdit(history, 'cue1', 'undo', next)
    expect(json(undo?.value)).toBe(json(prev))
    expect('effects' in clipOf(undo!.value!, 'L').edits).toBe(false)
    const redo = stepCompEdit(history, 'cue1', 'redo', prev)
    expect(clipOf(redo!.value!, 'L').edits.effects).toEqual({ reverb: DEFAULT_REVERB })
    expect(json(clipOf(redo!.value!, 'R'))).toBe(json(clipOf(prev, 'R')))
  })
})

describe('copy and paste effects between clips', () => {
  it('copies the clip stack and pastes it onto another clip, leaving the take alone', () => {
    const t = take(TAKE_FX)
    const src = setFx(split(), 'L', { delay: DEFAULT_DELAY, pitch: { semitones: 2 } })
    copyEffects(clipOf(src, 'L').edits.effects)
    const pasted = setFx(src, 'R', pickEffects(copiedEffects(), EFFECT_KINDS))
    expect(json(clipOf(pasted, 'R').edits.effects)).toBe(json(clipOf(src, 'L').edits.effects))
    expect(json(t.edits.effects)).toBe(json(TAKE_FX))
  })

  it('pasting an empty clipboard clears the clip stack', () => {
    const src = setFx(split(), 'R', { delay: DEFAULT_DELAY })
    copyEffects(clipOf(src, 'L').edits.effects)
    const pasted = setFx(src, 'R', pickEffects(copiedEffects(), EFFECT_KINDS))
    expect('effects' in clipOf(pasted, 'R').edits).toBe(false)
  })
})
