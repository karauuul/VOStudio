import { describe, expect, it } from 'vitest'
import { planLine } from '../src/shared/agent-generate'
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
})
