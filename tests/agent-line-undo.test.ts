import { describe, expect, it } from 'vitest'
import { applyProjectCommand, type ProjectCommand } from '../src/shared/project-commands'
import { emptyEdits, type Character, type Cue, type CueComp, type Project } from '../src/shared/domain'
import { lineStepCommand, recordLineEdit, runLineStep, steppedEdit, type LineHistory, type StepDir } from '../src/shared/line-history'
import { externalChanges } from '../src/shared/undo-route'

const cue = (id: string, over: Partial<Cue> = {}): Cue => ({
  id, characterId: '', key: id, fields: {}, sourceText: '', text: '', status: 'empty', notes: '', takes: [], ...over,
})

const hero: Character = {
  id: 'hero', name: 'Hero', color: '#fff', provider: { providerId: 'elevenlabs' },
  voiceSettings: { stability: 0.5, similarity: 0.75, style: 0, speed: 1, boost: true },
} as Character

const project = (cues: Cue[]): Project => ({
  id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', media: { referenceDir: '', referencePattern: '' },
  characters: [hero], cues, sessions: [], pronunciationRules: '', exportTemplate: '{EventName}.{ext}', ui: { filter: '', search: '' },
})

function agentSession(p: Project) {
  const history: LineHistory = { undo: [], redo: [] }
  let at = 0
  const agent = (command: ProjectCommand): void => {
    const before = structuredClone(p)
    const changes = applyProjectCommand(p, command)
    for (const change of externalChanges(before, changes, 'agent').lineEdits) recordLineEdit(history, change, ++at)
  }
  const step = (dir: StepDir) =>
    runLineStep(history, dir, async (edit) => steppedEdit(edit, dir, applyProjectCommand(p, lineStepCommand(edit, dir)), undefined))
  return { history, agent, step }
}

describe('agent line edits are undoable', () => {
  it('restores a line the agent deleted, with its text, and redoes the deletion', async () => {
    const p = project([cue('L1', { text: 'one' }), cue('L2', { text: 'two' })])
    const s = agentSession(p)
    s.agent({ type: 'cue.delete', cueIds: ['L1'] })
    expect(s.history.undo).toHaveLength(1)
    await s.step('undo')
    expect(p.cues.map((c) => [c.id, c.text])).toEqual([['L1', 'one'], ['L2', 'two']])
    await s.step('redo')
    expect(p.cues.map((c) => c.id)).toEqual(['L2'])
    await s.step('undo')
    expect(p.cues.map((c) => c.id)).toEqual(['L1', 'L2'])
  })

  it('keeps earlier history of a line the agent deleted', () => {
    const p = project([cue('L1')])
    const s = agentSession(p)
    const earlier = { kind: 'done' as const, cueId: 'L1', textRevision: 0, before: { status: 'empty' as const }, after: { status: 'approved' as const } }
    recordLineEdit(s.history, earlier, 0)
    s.agent({ type: 'cue.delete', cueIds: ['L1'] })
    expect(s.history.undo.map((e) => e.kind)).toEqual(['done', 'cues'])
  })

  it('removes a line the agent added', async () => {
    const p = project([cue('L1')])
    const s = agentSession(p)
    s.agent({ type: 'cue.create', afterCueId: 'L1', lines: [{ id: 'N', text: 'new' }] })
    await s.step('undo')
    expect(p.cues.map((c) => c.id)).toEqual(['L1'])
    await s.step('redo')
    expect(p.cues.map((c) => [c.id, c.text])).toEqual([['L1', ''], ['N', 'new']])
  })

  it('treats only inserted lines as added when the renderer has not seen a line yet', () => {
    const p = project([cue('L1'), cue('N')])
    const changes = applyProjectCommand(p, { type: 'cue.setCharacter', cueId: 'N', characterId: 'hero' })
    const external = externalChanges(project([cue('L1')]), changes, 'agent')
    expect(external.lineEdits).toEqual([])
    expect([...external.lines]).toEqual(['N'])
  })

  it('reverts agent text and character changes', async () => {
    const p = project([cue('L1', { text: 'before', status: 'translated' })])
    const s = agentSession(p)
    s.agent({ type: 'cue.saveText', cueId: 'L1', text: 'after' })
    s.agent({ type: 'cue.setCharacter', cueId: 'L1', characterId: 'hero' })
    await s.step('undo')
    expect(p.cues[0].characterId).toBe('')
    await s.step('undo')
    expect(p.cues[0].text).toBe('before')
    await s.step('redo')
    expect(p.cues[0].text).toBe('after')
  })

  it('reverts agent exclude', async () => {
    const p = project([cue('L1', { text: 'x', status: 'translated' })])
    const s = agentSession(p)
    s.agent({ type: 'cue.setExcluded', cueId: 'L1', excluded: true })
    expect(p.cues[0].status).toBe('excluded')
    await s.step('undo')
    expect(p.cues[0].status).toBe('translated')
    await s.step('redo')
    expect(p.cues[0].status).toBe('excluded')
  })

  it('leaves output changes caused by agent timeline and final take edits to their own history', () => {
    const take = { id: 't', kind: 'tts' as const, createdAt: 'now', file: { fileId: 't', relPath: 't.mp3', format: 'mp3' as const }, duration: 2, meta: {}, edits: emptyEdits() }
    const comp: CueComp = { clips: [{ id: 'k', sourceTakeId: 't', srcIn: 0, srcOut: 2, start: 0, edits: emptyEdits() }] }
    const p = project([cue('L1', { text: 'x', status: 'translated', takes: [take] })])
    const before = structuredClone(p)
    const placed = externalChanges(before, applyProjectCommand(p, { type: 'cue.setComp', cueId: 'L1', comp }), 'agent')
    expect(p.cues[0].status).not.toBe(before.cues[0].status)
    expect(placed.compEdits).toHaveLength(1)
    expect(placed.lineEdits).toEqual([])
    const q = project([cue('L1', { text: 'x', status: 'translated', takes: [take] })])
    const final = externalChanges(structuredClone(q), applyProjectCommand(q, { type: 'cue.setFinalTake', cueId: 'L1', takeId: 't' }), 'agent')
    expect(final.lineEdits).toEqual([])
    expect([...final.lines]).toEqual(['L1'])
  })

  it('keeps dropping line history for changes that are not from the agent', () => {
    const p = project([cue('L1', { text: 'one' })])
    const before = structuredClone(p)
    const deleted = externalChanges(before, applyProjectCommand(p, { type: 'cue.delete', cueIds: ['L1'] }))
    expect(deleted.lineEdits).toEqual([])
    expect([...deleted.lines]).toEqual(['L1'])
    const q = project([cue('L1', { text: 'one' })])
    const typed = externalChanges(structuredClone(q), applyProjectCommand(q, { type: 'cue.saveText', cueId: 'L1', text: 'two' }))
    expect(typed.lineEdits).toEqual([])
    expect([...typed.lines]).toEqual(['L1'])
  })

  it('drops instead of recording agent changes that also change characters', () => {
    const p = project([cue('L1', { text: 'one' })])
    const changes = { ...applyProjectCommand(p, { type: 'cue.saveText', cueId: 'L1', text: 'two' }), characters: [hero] }
    const external = externalChanges(project([cue('L1', { text: 'one' })]), changes, 'agent')
    expect(external.lineEdits).toEqual([])
    expect([...external.lines]).toEqual(['L1'])
  })
})
