import { describe, expect, it } from 'vitest'
import { applyChangeSet, applyProjectCommand } from '../src/shared/project-commands'
import { approvalState } from '../src/shared/approval'
import { emptyEdits, type Cue, type Project } from '../src/shared/domain'
import { settleDraft, withDraft, withSavedText, type TextDraft } from '../src/shared/text-draft'

function project(): Project {
  return {
    id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', pronunciationRules: '',
    characters: [],
    cues: [
      { id: 'c', characterId: '', key: '1', fields: {}, sourceText: 'S', text: 'T', status: 'generated', notes: '', takes: [{ id: 't', kind: 'tts', createdAt: 'now', file: { fileId: 't', relPath: 't.mp3', format: 'mp3' }, duration: 1, meta: {}, edits: emptyEdits() }], finalTakeId: 't' },
      { id: 'd', characterId: '', key: '2', fields: {}, sourceText: 'S2', text: 'T2', status: 'translated', notes: '', takes: [] },
    ],
    ui: { filter: '', search: '' },
  }
}

const cueOf = (p: Project, id: string): Cue => p.cues.find((c) => c.id === id)!

describe('text draft overlay', () => {
  it('shows the draft text on its own line only', () => {
    const p = project()
    const draft: TextDraft = { cueId: 'c', text: 'typed' }
    const shown = withDraft(cueOf(p, 'c'), draft)
    expect(shown).toEqual({ ...cueOf(p, 'c'), text: 'typed' })
    expect(cueOf(p, 'c').text).toBe('T')
    expect(withDraft(cueOf(p, 'd'), draft)).toBe(cueOf(p, 'd'))
  })

  it('keeps the stored line when there is nothing to overlay', () => {
    const cue = cueOf(project(), 'c')
    expect(withDraft(cue, null)).toBe(cue)
    expect(withDraft(cue, { cueId: 'c', text: 'T' })).toBe(cue)
    expect(withDraft(undefined, { cueId: 'c', text: 'typed' })).toBeUndefined()
  })

  it('does not touch revisions or approval while the text is only drafted', () => {
    const p = project()
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'c', approved: true, approvedAt: 'then' })
    const stored = cueOf(p, 'c')
    expect(approvalState(stored, p)).toBe('approved')
    const shown = withDraft(stored, { cueId: 'c', text: 'typed' })!
    expect(shown.textRevision).toBe(stored.textRevision)
    expect(shown.approval).toBe(stored.approval)
    expect(approvalState(shown, p)).toBe('approved')
  })
})

describe('reconciling a save whose change set arrived after a newer change', () => {
  it('puts the saved text and revision on the local line and keeps the newer changes', () => {
    const inMain = project()
    applyProjectCommand(inMain, { type: 'cue.saveText', cueId: 'c', text: 'saved' })
    const saved = cueOf(inMain, 'c')
    const local = project()
    const newer = { ...cueOf(local, 'c'), notes: 'from a job' }
    local.cues = [newer, cueOf(local, 'd')]

    const next = withSavedText(local, saved)!

    expect(cueOf(next, 'c')).toEqual({ ...newer, text: 'saved', textRevision: saved.textRevision })
    expect(cueOf(next, 'd')).toBe(cueOf(local, 'd'))
  })

  it('leaves the project untouched when the save already landed', () => {
    const p = project()
    applyProjectCommand(p, { type: 'cue.saveText', cueId: 'c', text: 'saved' })
    expect(withSavedText(p, cueOf(p, 'c'))).toBe(p)
    expect(withSavedText(null, cueOf(p, 'c'))).toBeNull()
  })
})

describe('settling a saved draft', () => {
  it('marks exactly the saved draft and keeps showing its text', () => {
    const saved: TextDraft = { cueId: 'c', text: 'typed' }
    expect(settleDraft(saved, saved)).toEqual({ cueId: 'c', text: 'typed', saved: true })
    expect(saved.saved).toBeUndefined()
    expect(settleDraft(null, saved)).toBeNull()
  })

  it('keeps text typed while the previous draft was saving', () => {
    const saved: TextDraft = { cueId: 'c', text: 'typed' }
    const newer: TextDraft = { cueId: 'c', text: 'typed more' }
    expect(settleDraft(newer, saved)).toBe(newer)
    const other: TextDraft = { cueId: 'd', text: 'next line' }
    expect(settleDraft(other, saved)).toBe(other)
  })

  it('keeps an equal but newer draft object', () => {
    const saved: TextDraft = { cueId: 'c', text: 'x' }
    const retyped: TextDraft = { cueId: 'c', text: 'x' }
    expect(settleDraft(retyped, saved)).toBe(retyped)
  })
})

describe('committing a draft', () => {
  it('bumps textRevision once per save and makes an approved line stale', () => {
    const p = project()
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'c', approved: true, approvedAt: 'then' })
    const before = cueOf(p, 'c').textRevision ?? 0
    const draft: TextDraft = { cueId: 'c', text: 'typed' }
    const changes = applyProjectCommand(p, { type: 'cue.saveText', cueId: draft.cueId, text: draft.text })
    const committed = cueOf(applyChangeSet(project(), changes), 'c')
    expect(committed.text).toBe('typed')
    expect(committed.textRevision).toBe(before + 1)
    expect(approvalState(cueOf(p, 'c'), p)).toBe('stale')
    expect(withDraft(cueOf(p, 'c'), settleDraft(draft, draft))).toBe(cueOf(p, 'c'))
  })

  it('leaves revision and approval alone when the draft equals the stored text', () => {
    const p = project()
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'c', approved: true, approvedAt: 'then' })
    const before = cueOf(p, 'c').textRevision
    applyProjectCommand(p, { type: 'cue.saveText', cueId: 'c', text: 'T' })
    expect(cueOf(p, 'c').textRevision).toBe(before)
    expect(approvalState(cueOf(p, 'c'), p)).toBe('approved')
  })
})
