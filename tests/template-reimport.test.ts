import { describe, expect, it } from 'vitest'
import { approvalState, approveCue, changeCompOutput } from '../src/shared/approval'
import { emptyEdits, type Cue, type CueComp, type Project, type Take } from '../src/shared/domain'
import { applyChangeSet } from '../src/shared/project-commands'
import { applyTemplateDiff, diffTemplate, type ReimportRow } from '../src/shared/template-reimport'

const take = (id = 't1'): Take => ({
  id,
  kind: 'tts',
  createdAt: '2026-08-30T00:00:00.000Z',
  file: { fileId: id, relPath: `${id}.mp3`, format: 'mp3' },
  duration: 1,
  meta: {},
  edits: emptyEdits(),
})

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: `cue-${over.key ?? '1'}`,
  characterId: 'ada',
  key: '1',
  fields: { WemId: '1', EventName: 'VO_ADA_001', exportName: 'VO_ADA_001' },
  sourceText: 'Source',
  text: 'Переклад',
  status: 'generated',
  notes: '',
  takes: [take()],
  finalTakeId: 't1',
  ...over,
})

const project = (cues: Cue[]): Project => ({
  id: 'p',
  schemaVersion: 1,
  createdAt: 'now',
  name: 'P',
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues,
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '{EventName}__{WemId}.{ext}',
  ui: { filter: '', search: '' },
})

function row({ fields, ...over }: Partial<ReimportRow> = {}): ReimportRow {
  const base = {
    cueId: '1',
    character: 'ADA',
    sourceText: 'Source',
    translation: 'Переклад',
    exportName: 'VO_ADA_001',
    status: '',
    durationHint: '',
    note: '',
    ...over,
  }
  return {
    ...base,
    fields: fields ?? {
      cueId: base.cueId,
      sourceText: base.sourceText,
      translation: base.translation,
      exportName: base.exportName,
    },
  }
}

const newCue = (key: string): Cue =>
  cue({ id: `cue-${key}`, key, takes: [], finalTakeId: undefined, status: 'empty', text: '' })

describe('diffTemplate', () => {
  it('classifies an unknown cueId as added', () => {
    const diff = diffTemplate(project([cue()]), [row(), row({ cueId: '2' })])
    expect(diff.added.map((r) => r.cueId)).toEqual(['2'])
    expect(diff.untouched.map((r) => r.cueId)).toEqual(['1'])
    expect(diff.updated).toEqual([])
    expect(diff.orphaned).toEqual([])
  })

  it('records which of sourceText and translation changed', () => {
    const p = project([cue()])
    const source = diffTemplate(p, [row({ sourceText: 'New source' })])
    expect(source.updated).toMatchObject([{ sourceChanged: true, translationChanged: false }])

    const translation = diffTemplate(p, [row({ translation: 'Новий переклад' })])
    expect(translation.updated).toMatchObject([{ sourceChanged: false, translationChanged: true }])

    const both = diffTemplate(p, [row({ sourceText: 'New source', translation: 'Новий переклад' })])
    expect(both.updated).toMatchObject([{ sourceChanged: true, translationChanged: true }])
  })

  it('never treats an empty file translation as a change', () => {
    const diff = diffTemplate(project([cue()]), [row({ translation: '   ' })])
    expect(diff.updated).toEqual([])
    expect(diff.untouched).toHaveLength(1)
  })

  it('reports project cues missing from the file as orphaned', () => {
    const diff = diffTemplate(project([cue(), cue({ id: 'cue-9', key: '9' })]), [row()])
    expect(diff.orphaned.map((c) => c.key)).toEqual(['9'])
  })

  it('handles a mixed file in one pass', () => {
    const p = project([cue(), cue({ id: 'cue-2', key: '2' }), cue({ id: 'cue-3', key: '3' })])
    const diff = diffTemplate(p, [
      row(),
      row({ cueId: '2', sourceText: 'New source' }),
      row({ cueId: '4' }),
    ])
    expect(diff.added.map((r) => r.cueId)).toEqual(['4'])
    expect(diff.updated.map((u) => u.row.cueId)).toEqual(['2'])
    expect(diff.untouched.map((r) => r.cueId)).toEqual(['1'])
    expect(diff.orphaned.map((c) => c.key)).toEqual(['3'])
  })
})

describe('applyTemplateDiff', () => {
  const apply = (p: Project, rows: ReimportRow[], added: Cue[] = []) =>
    applyTemplateDiff(p, diffTemplate(p, rows), added)

  it('leaves a project byte-identical when the diff is empty', () => {
    const p = project([cue(), cue({ id: 'cue-2', key: '2', fields: { Legacy: 'kept', MsgKey: 'x' } })])
    const before = JSON.stringify(p)
    const { changed, warnings } = apply(p, [row(), row({ cueId: '2' })])
    expect(changed).toEqual([])
    expect(warnings).toEqual([])
    expect(JSON.stringify(p)).toBe(before)
  })

  it('keeps takes, comp and approval while marking the approval stale on a source change', () => {
    const comp: CueComp = { clips: [{ id: 'c1', sourceTakeId: 't1', srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }] }
    const approved = approveCue(changeCompOutput(cue({ comp }), comp), '2026-08-30T01:00:00.000Z')
    const p = project([approved])
    apply(p, [row({ sourceText: 'New source' })])
    const after = p.cues[0]
    expect(after.sourceText).toBe('New source')
    expect(after.takes).toEqual(approved.takes)
    expect(after.comp).toEqual(comp)
    expect(after.finalTakeId).toBe('t1')
    expect(after.output).toEqual(approved.output)
    expect(after.approval).toEqual(approved.approval)
    expect(approvalState(after)).toBe('stale')
  })

  it('offers a changed translation as a suggestion when the cue is already translated', () => {
    const p = project([cue()])
    apply(p, [row({ translation: 'Новий переклад' })])
    expect(p.cues[0].text).toBe('Переклад')
    expect(p.cues[0].suggestedText).toBe('Новий переклад')
    expect(p.cues[0].textRevision).toBeUndefined()
  })

  it('writes a translation directly when the cue has none', () => {
    const p = project([cue({ text: '', status: 'empty', takes: [], finalTakeId: undefined })])
    apply(p, [row({ translation: 'Новий переклад' })])
    expect(p.cues[0].text).toBe('Новий переклад')
    expect(p.cues[0].suggestedText).toBeUndefined()
    expect(p.cues[0].status).toBe('translated')
  })

  it('merges file columns into cue fields without dropping project-only ones', () => {
    const p = project([cue({ fields: { WemId: '1', EventName: 'VO_ADA_001', Notes: 'approved' } })])
    apply(p, [row({ sourceText: 'New source' })])
    expect(p.cues[0].fields).toEqual({
      WemId: '1',
      EventName: 'VO_ADA_001',
      Notes: 'approved',
      cueId: '1',
      sourceText: 'New source',
      translation: 'Переклад',
      exportName: 'VO_ADA_001',
    })
  })

  it('excludes a matched cue only when it has no live takes', () => {
    const withTakes = project([cue()])
    const blocked = apply(withTakes, [row({ status: 'excluded' })])
    expect(withTakes.cues[0].status).toBe('generated')
    expect(blocked.changed).toEqual([])
    expect(blocked.warnings).toHaveLength(1)

    const free = project([cue({ takes: [], finalTakeId: undefined, status: 'translated' })])
    const applied = apply(free, [row({ status: 'excluded' })])
    expect(free.cues[0].status).toBe('excluded')
    expect(applied.changed).toHaveLength(1)
    expect(applied.warnings).toEqual([])
  })

  it('leaves local status alone when the file status column is empty', () => {
    const p = project([cue({ status: 'excluded', takes: [], finalTakeId: undefined })])
    apply(p, [row()])
    expect(p.cues[0].status).toBe('excluded')
  })

  it('appends built cues and reports every touched cue once', () => {
    const p = project([cue()])
    const added = newCue('2')
    const result = apply(p, [row({ sourceText: 'New source', status: 'excluded' }), row({ cueId: '2' })], [added])
    expect(p.cues.map((c) => c.key)).toEqual(['1', '2'])
    expect(result.changed.map((c) => c.key)).toEqual(['1', '2'])
    expect(result.warnings).toHaveLength(1)
  })

  it('lands added cues in the renderer through the change set', () => {
    const p = project([cue()])
    const mirror = structuredClone(p)
    const { changed } = apply(p, [row(), row({ cueId: '2' })], [newCue('2')])
    expect(applyChangeSet(mirror, { cues: structuredClone(changed) }).cues.map((c) => c.key)).toEqual(['1', '2'])
  })
})
