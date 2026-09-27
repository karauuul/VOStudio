import { describe, expect, it } from 'vitest'
import { planLine } from '../src/shared/agent-generate'
import { jobChars, jobTtsPlan, stsPlan, ttsPlan, VOICE_CHANGED } from '../src/shared/provider-models'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'

const voice = { stability: 0.5, similarity: 0.5, style: 0.2, speed: 1, boost: true }

const recording = (id: string, extra: Partial<Take> = {}): Take => ({
  id, kind: 'recording', createdAt: 'now', file: { fileId: id, relPath: `/p/${id}.wav`, format: 'wav' }, duration: 2, meta: { text: 'said' }, edits: emptyEdits(), ...extra,
})

function project(cue: Partial<Cue> = {}): Project {
  return {
    id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', pronunciationRules: '',
    media: { referenceDir: '', referencePattern: '' }, sessions: [], exportTemplate: '{key}.{ext}', ui: { filter: '', search: '' },
    characters: [{ id: 'a', name: 'Ada', color: '#fff', provider: { providerId: 'elevenlabs', voiceId: 'v1', ttsModel: 'tm', stsModel: 'sm' }, voiceSettings: voice }],
    cues: [{ id: 'c', characterId: 'a', key: 'K', fields: {}, sourceText: '', text: 'Hello there', status: 'translated', notes: '', takes: [], ...cue }],
  }
}

describe('planLine', () => {
  it('layers the line override and the agent settings on the character and clamps them', () => {
    const p = project({ voiceSettingsOverride: { stability: 0.9 } })
    const plan = planLine(p, p.cues[0], { mode: 'tts', settings: { speed: 3, style: 0.456 } })
    expect(plan.voiceSettings).toEqual({ stability: 0.9, similarity: 0.5, style: 0.46, speed: 1.2, boost: true })
    expect(plan).toMatchObject({ text: 'Hello there', chars: 11, model: 'tm', voice: 'v1', fragment: false })
  })

  it('keeps the raw text for the request and previews and counts the text after one pass of the rules', () => {
    const p = { ...project({ text: 'A cat' }), pronunciationRules: 'A → AA' }
    const plan = planLine(p, p.cues[0], { mode: 'tts' })
    expect(plan).toMatchObject({ rawText: 'A cat', text: 'AA cat', chars: 6 })
    const sent = ttsPlan(p, p.cues[0], plan.rawText).text
    expect(sent).toBe(plan.text)
    expect(sent.length).toBe(plan.chars)
  })

  it('freezes the provider text at planning so later rule changes neither alter it nor its character count', () => {
    const p = { ...project({ text: 'A cat' }), pronunciationRules: 'A → AA' }
    const plan = planLine(p, p.cues[0], { mode: 'tts' })
    const job = { kind: 'tts' as const, cueId: 'c', text: plan.rawText, providerText: plan.text, voiceSettings: voice }
    const changed = { ...p, pronunciationRules: 'cat → kitty kitty' }
    expect(jobTtsPlan(changed, changed.cues[0], job).text).toBe('AA cat')
    expect(jobChars(job, changed.pronunciationRules)).toBe(plan.chars)
    expect(jobChars({ ...job, providerText: undefined }, changed.pronunciationRules)).toBe('A kitty kitty'.length)
    expect(jobChars({ kind: 'sts', cueId: 'c', sourceTakeId: 'r', voiceSettings: voice }, changed.pronunciationRules)).toBe(0)
  })

  it('resolves a planned job with the voice, model and language frozen at planning and a live job with the current ones', () => {
    const p = { ...project(), provider: { tts: { language: 'uk' } } }
    const plan = planLine(p, p.cues[0], { mode: 'tts' })
    expect(plan).toMatchObject({ voice: 'v1', model: 'tm', language: 'uk' })
    const planned = { characterId: 'a', voiceId: 'v1', model: 'tm', language: 'uk' }
    const job = { cueId: 'c', text: plan.rawText, voiceSettings: voice, planned }
    const [ada] = p.characters
    const changed = { ...p, provider: {}, characters: [{ ...ada, provider: { ...ada.provider, ttsModel: 'tm2', stsModel: 'sm2' } }] }
    expect(jobTtsPlan(changed, changed.cues[0], job)).toMatchObject({ voiceId: 'v1', model: 'tm', language: 'uk', text: 'Hello there' })
    expect(stsPlan(changed, changed.cues[0], { ...planned, model: 'sm' })).toMatchObject({ voiceId: 'v1', model: 'sm' })
    const live = jobTtsPlan(changed, changed.cues[0], { ...job, planned: undefined })
    expect(live).toMatchObject({ voiceId: 'v1', model: 'tm2' })
    expect(live.language).toBeUndefined()
    expect(stsPlan(changed, changed.cues[0])).toMatchObject({ voiceId: 'v1', model: 'sm2' })
  })

  it('refuses a planned job when the line changed character or voice after planning', () => {
    const p = project()
    const planned = { characterId: 'a', voiceId: 'v1', model: 'tm' }
    const job = { cueId: 'c', text: 'Hello there', voiceSettings: voice, planned }
    const [ada] = p.characters
    const revoiced = { ...p, characters: [{ ...ada, provider: { ...ada.provider, voiceId: 'v2' } }] }
    expect(() => jobTtsPlan(revoiced, revoiced.cues[0], job)).toThrow(VOICE_CHANGED)
    expect(() => stsPlan(revoiced, revoiced.cues[0], planned)).toThrow(VOICE_CHANGED)
    const moved = { ...p, characters: [...p.characters, { ...ada, id: 'b' }], cues: [{ ...p.cues[0], characterId: 'b' }] }
    expect(() => jobTtsPlan(moved, moved.cues[0], job)).toThrow(VOICE_CHANGED)
  })

  it('converts the newest live recording in sts mode and skips a line without one', () => {
    const p = project({ takes: [recording('r1'), recording('r2', { fragment: true }), recording('r3', { deletedAt: 'x' })] })
    expect(planLine(p, p.cues[0], { mode: 'sts' })).toMatchObject({ sourceTakeId: 'r2', fragment: true, model: 'sm', chars: 0, text: 'said' })
    const bare = project()
    expect(planLine(bare, bare.cues[0], { mode: 'sts' }).skip).toBe('no recording')
    const long = project({ takes: [recording('r1', { duration: 301 })] })
    expect(planLine(long, long.cues[0], { mode: 'sts' }).skip).toBe('recording longer than 5 min')
  })

  it('re-generates a clip from the words it covers and marks it to replace that clip', () => {
    const take: Take = { ...recording('t1'), kind: 'tts', words: [{ text: 'Hello', start: 0, end: 0.5 }, { text: 'there', start: 0.6, end: 1 }] }
    const p = project({ takes: [take], comp: { clips: [{ id: 'k', sourceTakeId: 't1', srcIn: 0.55, srcOut: 1, start: 0, edits: emptyEdits() }] } })
    expect(planLine(p, p.cues[0], { mode: 'tts', target: { clipId: 'k' } })).toMatchObject({ text: 'there', fragment: true, replaceClipId: 'k' })
  })

  it('names the first skip reason in a fixed order', () => {
    const p = project({ status: 'excluded' })
    expect(planLine(p, p.cues[0], { mode: 'tts', blocked: 'busy' }).skip).toBe('excluded')
    const q = project()
    expect(planLine(q, q.cues[0], { mode: 'tts', blocked: 'recording' }).skip).toBe('recording')
    const long = project({ text: 'x'.repeat(5001) })
    expect(planLine(long, long.cues[0], { mode: 'tts' }).skip).toBe('text longer than 5000 characters')
  })

  it('caps the text the provider receives after the rules expand it', () => {
    const fits = { ...project({ text: 'x'.repeat(2500) }), pronunciationRules: 'x → yy' }
    const ok = planLine(fits, fits.cues[0], { mode: 'tts' })
    expect(ok.skip).toBeUndefined()
    expect(ok.chars).toBe(5000)
    const p = { ...project({ text: 'x'.repeat(2501) }), pronunciationRules: 'x → yy' }
    const plan = planLine(p, p.cues[0], { mode: 'tts' })
    expect(plan).toMatchObject({ skip: 'text longer than 5000 characters', chars: 0 })
    expect(plan.text).toHaveLength(5002)
  })
})
