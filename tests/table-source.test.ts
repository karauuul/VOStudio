import { describe, expect, it } from 'vitest'
import { approvalState } from '../src/shared/approval'
import { LINE_TEXT_MAX } from '../src/shared/lines'
import {
  applyTable,
  assignColumn,
  commitTable,
  detectMapping,
  parseTableFile,
  previewTable,
  tableMapping,
  type TableOptions,
  TABLE_ROWS_MAX,
  CUE_KEY_MAX,
  CHARACTER_ID_MAX,
} from '../src/shared/import-table'
import { emptyEdits, type Character, type Cue, type Project, type Take } from '../src/shared/domain'
import { newLineCue } from '../src/shared/lines'
import {
  applyChangeSet,
  applyProjectCommand,
  audioWithinRoots,
  commandAudioPaths,
  type ChangeSet,
  type ProjectCommand,
} from '../src/shared/project-commands'
import {
  lineStepCommand,
  recordLineEdit,
  removesLines,
  runLineStep,
  steppedEdit,
  type LineEdit,
  type LineHistory,
  type StepDir,
} from '../src/shared/line-history'
import { projectCommandSchema, tableImportSchema } from '../src/main/schemas'

const cue = (id: string, over: Partial<Cue> = {}): Cue => ({
  id,
  characterId: '',
  key: id,
  fields: {},
  sourceText: '',
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
  ...over,
})

const take = (id: string, relPath: string): Take => ({
  id,
  kind: 'recording',
  createdAt: 'now',
  file: { fileId: id, relPath, format: 'wav' },
  duration: 1,
  meta: {},
  edits: emptyEdits(),
})

const project = (cues: Cue[], characters: Character[] = []): Project => ({
  id: 'p',
  schemaVersion: 1,
  createdAt: 'now',
  name: 'P',
  media: { referenceDir: '', referencePattern: '' },
  characters,
  cues,
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '{EventName}.{ext}',
  ui: { filter: '', search: '' },
})

const csv = (...lines: string[]) => parseTableFile('t.csv', lines.join('\n') + '\n')

const options = (mapping: TableOptions['mapping'], over: Partial<TableOptions> = {}): TableOptions => ({
  mapping,
  rule: 'id',
  replaceTranslations: false,
  keepOriginal: false,
  ...over,
})

const fieldsOf = (p: Project) => p.cues.map(({ id, key, sourceText, text, characterId }) => ({ id, key, sourceText, text, characterId }))

function run(p: Project, command: ProjectCommand): ChangeSet {
  const before = structuredClone(p)
  const changes = applyProjectCommand(p, projectCommandSchema.parse(command) as ProjectCommand)
  const mirrored = applyChangeSet(before, changes)
  expect(mirrored.cues).toEqual(p.cues)
  expect(mirrored.characters).toEqual(p.characters)
  return changes
}

function importInto(p: Project, table: ReturnType<typeof csv>, o: TableOptions) {
  const before = structuredClone(p)
  const committed = commitTable(p, table.rows, o)
  if (committed.changes) expect(applyChangeSet(before, committed.changes).cues).toEqual(p.cues)
  const history: LineHistory = { undo: [], redo: [] }
  const { ids, fields, characters } = committed.undo
  recordLineEdit(history, { kind: 'table', ids, snapshots: [], fields, characters, focus: ids[0] ?? fields[0]?.cueId ?? '' }, 1)
  const step = (dir: StepDir) =>
    runLineStep(history, dir, async (edit: LineEdit) => steppedEdit(edit, dir, run(p, lineStepCommand(edit, dir)), undefined))
  return { committed, history, step }
}

describe('parseTableFile', () => {
  it('reads a .txt without a tab in the first line as a script of paragraphs', () => {
    const file = parseTableFile('script.txt', '\uFEFFFirst paragraph,\nstill first.\n\nSecond one.\n')
    expect(file).toEqual({ script: true, headers: [], rows: [['First paragraph,\nstill first.'], ['Second one.']] })
  })

  it('splits a script without blank lines by line', () => {
    expect(parseTableFile('s.TXT', 'One\r\nTwo\r\n').rows).toEqual([['One'], ['Two']])
  })

  it('keeps a tab-separated .txt as a table', () => {
    expect(parseTableFile('t.txt', 'id\ttext\nA\thello, world\n')).toEqual({
      script: false,
      headers: ['id', 'text'],
      rows: [['A', 'hello, world']],
    })
  })

  it('reads csv and tsv by extension and refuses an empty table', () => {
    expect(parseTableFile('t.csv', 'Text\nHi\n').rows).toEqual([['Hi']])
    expect(parseTableFile('t.tsv', 'a\tb\n1\t2\n').rows).toEqual([['1', '2']])
    expect(() => parseTableFile('t.csv', '')).toThrow('no header row')
    expect(parseTableFile('t.txt', '')).toEqual({ script: true, headers: [], rows: [] })
  })
})

describe('tableMapping', () => {
  const quick = [newLineCue('a', 1, 'typed')]
  const template = [cue('a', { sourceText: 'Hello' })]

  it('maps a single text column to the line text when no line has original text', () => {
    expect(tableMapping(csv('Text', 'x'), quick)).toEqual({ translation: 0 })
    expect(tableMapping(csv('Text', 'x'), [])).toEqual({ translation: 0 })
    expect(tableMapping(csv('EventName,Text,Character', 'A,x,Bo'), [])).toEqual({ id: 0, translation: 1, character: 2 })
  })

  it('keeps the old guess once any line has original text', () => {
    for (const headers of [['Text'], ['EventName', 'Original', 'Speaker'], ['cueId', 'character', 'sourceText', 'translation']]) {
      expect(tableMapping(csv(headers.join(','), ''), template)).toEqual(detectMapping(headers))
    }
  })

  it('keeps two text columns as original and text', () => {
    expect(tableMapping(csv('Original,Translation', 'a,b'), [])).toEqual({ text: 0, translation: 1 })
  })

  it('falls back to position only for a single unknown column', () => {
    expect(tableMapping(csv('Κείμενο', 'x'), [])).toEqual({ translation: 0 })
    expect(tableMapping(csv('Κείμενο', 'x'), template)).toEqual({ text: 0 })
    expect(tableMapping(csv('Κλειδί,Κείμενο,Ρόλος', 'a,b,c'), [])).toEqual({})
  })

  it('uses the requested mapping and forces the line text for scripts', () => {
    expect(tableMapping(csv('Text', 'x'), [], { text: 0 })).toEqual({ text: 0 })
    expect(tableMapping(parseTableFile('s.txt', 'a\n\nb'), template, { id: 0 })).toEqual({ translation: 0 })
  })
})

describe('assignColumn', () => {
  it('moves a field to one column and frees the column it replaces', () => {
    expect(assignColumn({ id: 0, text: 1 }, 2, 'text')).toEqual({ id: 0, text: 2 })
    expect(assignColumn({ id: 0, text: 1 }, 0, 'text')).toEqual({ text: 0 })
    expect(assignColumn({ id: 0, text: 1 }, 1, null)).toEqual({ id: 0 })
  })
})

describe('keyless import', () => {
  it('continues the Line N numbering after existing lines', () => {
    const p = project([newLineCue('a', 1, 'one'), newLineCue('b', 4, 'four')])
    const r = applyTable(p, csv('Text', 'five', '', 'six').rows, { translation: 0 }, 'id', false)
    expect(r.summary).toEqual({ added: 2, updated: 0, unchanged: 0, skipped: 1 })
    expect(p.cues.slice(2).map((c) => [c.key, c.fields['EventName'], c.text, c.status])).toEqual([
      ['line-005', 'Line 5', 'five', 'translated'],
      ['line-006', 'Line 6', 'six', 'translated'],
    ])
    expect(p.cues.slice(2).every((c) => c.sourceText === '')).toBe(true)
  })

  it('turns a script into lines with the text as line text', () => {
    const p = project([])
    const file = parseTableFile('s.txt', 'Hello there.\n\nGeneral Kenobi.')
    commitTable(p, file.rows, options(tableMapping(file, p.cues)))
    expect(p.cues.map((c) => [c.key, c.text])).toEqual([
      ['line-001', 'Hello there.'],
      ['line-002', 'General Kenobi.'],
    ])
  })

  it('skips rows with only a character', () => {
    const p = project([])
    const r = applyTable(p, csv('Text,Character', ',Bo').rows, { translation: 0, character: 1 }, 'id', false)
    expect(r.summary.skipped).toBe(1)
    expect(p.cues).toEqual([])
    expect(p.characters).toEqual([])
  })
})

describe('keyed import options', () => {
  const table = csv('id,orig,text', 'A,New source,New text')
  const mapping = { id: 0, text: 1, translation: 2 }

  it('keeps a non-empty original when asked and still fills an empty one', () => {
    const p = project([cue('a', { key: 'A', sourceText: 'Old source' }), cue('b', { key: 'B' })])
    applyTable(p, [...table.rows, ['B', 'Filled', '']], mapping, 'id', false, true)
    expect(p.cues[0].sourceText).toBe('Old source')
    expect(p.cues[1].sourceText).toBe('Filled')
  })

  it('replaces existing text only when asked', () => {
    const p = project([cue('a', { key: 'A', text: 'Old text' })])
    expect(previewTable(p, table.rows, options(mapping)).updated).toBe(1)
    expect(previewTable(p, table.rows, options({ id: 0, translation: 2 })).unchanged).toBe(1)
    expect(previewTable(p, table.rows, options({ id: 0, translation: 2 }, { replaceTranslations: true })).updated).toBe(1)
  })
})

describe('dry run', () => {
  const table = csv('EventName,Text,Character', 'A,Alpha,Bo', 'B,Beta,', 'Z,Zeta,Cy', ',Orphan,', 'A,Alpha,Bo')

  it('counts the same rows the commit changes and leaves the project untouched', () => {
    const p = project([cue('a', { key: 'A', text: 'Alpha' }), cue('b', { key: 'B', text: 'Old' })])
    const o = options({ id: 0, translation: 1, character: 2 }, { replaceTranslations: true })
    const before = structuredClone(p)
    const summary = previewTable(p, table.rows, o)
    expect(p).toEqual(before)
    expect(summary).toEqual({ added: 1, updated: 2, unchanged: 1, skipped: 1 })
    expect(commitTable(p, table.rows, o).summary).toEqual(summary)
  })

  it('reports nothing to commit when the table matches the project', () => {
    const p = project([cue('a', { key: 'A', text: 'Alpha' })])
    const result = commitTable(p, csv('EventName,Text', 'A,Alpha').rows, options({ id: 0, translation: 1 }))
    expect(result.summary).toEqual({ added: 0, updated: 0, unchanged: 1, skipped: 0 })
    expect(result.changes).toBeNull()
    expect(result.undo).toEqual({ ids: [], fields: [], characters: [] })
  })

  it('a second import of the same keyed table changes nothing', () => {
    const p = project([])
    const o = options(tableMapping(table, p.cues))
    commitTable(p, table.rows, o)
    expect(previewTable(p, table.rows, o)).toEqual({ added: 0, updated: 0, unchanged: 4, skipped: 1 })
  })
})

describe('template projects', () => {
  it('commits exactly what applyTable did before for the same mapping and options', () => {
    const base = project(
      [cue('a', { key: 'A', sourceText: 'Old', text: 'Stary', textRevision: 3 }), cue('b', { key: 'B', characterId: 'x' })],
      []
    )
    const table = csv('cueId,character,sourceText,translation', 'A,Ada,New,Novyi', 'B,,Bee,Bi', 'C,Cy,See,')
    const mapping = detectMapping(table.headers)
    for (const replace of [false, true]) {
      const viaCommit = structuredClone(base)
      const direct = structuredClone(base)
      commitTable(viaCommit, table.rows, options(mapping, { replaceTranslations: replace }))
      applyTable(direct, table.rows, mapping, 'id', replace)
      const strip = (p: Project) => ({ ...p, cues: p.cues.map(({ id: _id, ...rest }) => rest) })
      expect(strip(viaCommit)).toEqual(strip(direct))
      expect(tableMapping(table, base.cues)).toEqual(mapping)
    }
  })
})

describe('import undo', () => {
  const bo: Character = {
    id: 'bo',
    name: 'Bo',
    color: '#fff',
    provider: { providerId: 'elevenlabs', voiceId: 'v', ttsModel: 't', stsModel: 's' },
    voiceSettings: { stability: 0.5, similarity: 0.5, style: 0, speed: 1, boost: false },
  }
  const table = csv('EventName,Original,Text,Character', 'A,Src A,Text A,Bo', 'B,,Text B,Ada', 'N,New src,New text,Cy')
  const mapping = { id: 0, text: 1, translation: 2, character: 3 }
  const start = () =>
    project(
      [
        cue('a', { key: 'A', sourceText: 'Old A', text: 'Old text A', characterId: '' }),
        cue('b', { key: 'B', text: '', characterId: 'bo' }),
        cue('c', { key: 'C', text: 'untouched' }),
      ],
      [bo]
    )

  it('one undo removes new lines, restores fields and drops created characters; redo brings it back', async () => {
    const p = start()
    const before = fieldsOf(p)
    const { committed, step, history } = importInto(p, table, options(mapping, { replaceTranslations: true }))
    const after = fieldsOf(p)
    const afterCharacters = structuredClone(p.characters)
    expect(committed.undo.ids).toHaveLength(1)
    expect(committed.undo.fields).toEqual([
      { cueId: 'a', from: { sourceText: 'Old A', text: 'Old text A', characterId: '' }, to: { sourceText: 'Src A', text: 'Text A', characterId: 'bo' } },
      { cueId: 'b', from: { text: '', characterId: 'bo' }, to: { text: 'Text B', characterId: 'Ada' } },
    ])
    expect(committed.undo.characters.map((c) => c.name)).toEqual(['Ada', 'Cy'])
    expect(removesLines(history.undo[0], 'undo')).toBe(true)
    expect(removesLines(history.undo[0], 'redo')).toBe(false)

    await step('undo')
    expect(fieldsOf(p)).toEqual(before)
    expect(p.characters).toEqual([bo])
    expect(p.cues.find((c) => c.id === 'a')!.status).toBe('translated')

    await step('redo')
    expect(fieldsOf(p)).toEqual(after)
    expect(p.characters).toEqual(afterCharacters)

    await step('undo')
    expect(fieldsOf(p)).toEqual(before)
  })

  it('invalidates approved output when the import or its undo changes the character', async () => {
    const p = start()
    Object.assign(p.cues.find((c) => c.id === 'c')!, {
      status: 'generated',
      takes: [{ ...take('t', 't.mp3'), kind: 'tts' as const, file: { fileId: 't', relPath: 't.mp3', format: 'mp3' as const } }],
      finalTakeId: 't',
    })
    run(p, { type: 'cue.approve', cueId: 'c', approved: true, approvedAt: 'then' })
    const revision = p.cues.find((c) => c.id === 'c')!.output?.revision ?? 0
    const { step } = importInto(p, csv('EventName,Character', 'C,Ada'), options({ id: 0, character: 1 }))
    const imported = p.cues.find((c) => c.id === 'c')!
    expect(imported.characterId).toBe('Ada')
    expect(imported.output?.revision).toBe(revision + 1)
    expect(approvalState(imported)).toBe('stale')
    run(p, { type: 'cue.approve', cueId: 'c', approved: true, approvedAt: 'later' })
    await step('undo')
    const undone = p.cues.find((c) => c.id === 'c')!
    expect(undone.characterId).toBe('')
    expect(approvalState(undone)).toBe('stale')
  })

  it('keeps edits made after the import and characters that were configured or used', async () => {
    const p = start()
    const { step } = importInto(p, table, options(mapping, { replaceTranslations: true }))
    run(p, { type: 'cue.saveText', cueId: 'a', text: 'Typed later' })
    run(p, { type: 'character.setProvider', characterId: 'Ada', voiceId: 'voice' })
    run(p, { type: 'cue.setCharacter', cueId: 'c', characterId: 'Cy' })
    await step('undo')
    const a = p.cues.find((c) => c.id === 'a')!
    expect([a.sourceText, a.text, a.characterId]).toEqual(['Old A', 'Typed later', ''])
    expect(p.cues.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(p.characters.map((c) => c.id)).toEqual(['bo', 'Ada', 'Cy'])
  })

  it('undoes an update-only import without touching the line list', async () => {
    const p = start()
    const { committed, history, step } = importInto(p, csv('EventName,Text', 'C,Changed'), options({ id: 0, translation: 1 }, { replaceTranslations: true }))
    expect(committed.undo.ids).toEqual([])
    expect(removesLines(history.undo[0], 'undo')).toBe(false)
    await step('undo')
    expect(p.cues.map((c) => [c.id, c.text])).toEqual([
      ['a', 'Old text A'],
      ['b', ''],
      ['c', 'untouched'],
    ])
  })

  it('does not jam when a created line is already gone', () => {
    const p = start()
    const { committed } = importInto(p, table, options(mapping))
    run(p, { type: 'cue.delete', cueIds: committed.undo.ids })
    const changes = run(p, {
      type: 'table.step',
      remove: committed.undo.ids,
      restore: [],
      fields: [],
      addCharacters: [],
      dropCharacters: [],
    })
    expect(changes).toEqual({})
  })
})

describe('table.step validation', () => {
  it('parses a step and rejects unknown fields', () => {
    const command: ProjectCommand = {
      type: 'table.step',
      remove: ['a'],
      restore: [{ cue: cue('n'), index: 0 }],
      fields: [{ cueId: 'a', from: { text: 'x' }, to: { text: '' } }],
      addCharacters: [],
      dropCharacters: [],
    }
    expect(projectCommandSchema.parse(command)).toEqual(command)
    expect(() => projectCommandSchema.parse({ ...command, fields: [{ cueId: 'a', from: { status: 'x' }, to: {} }] })).toThrow()
    expect(() => projectCommandSchema.parse({ ...command, remove: [''] })).toThrow()
  })

  it('checks audio of restored lines against the trusted roots', () => {
    const restored = cue('n', { takes: [take('t', '/elsewhere/t.wav')] })
    const command: ProjectCommand = {
      type: 'table.step',
      remove: [],
      restore: [{ cue: restored, index: 0 }],
      fields: [],
      addCharacters: [],
      dropCharacters: [],
    }
    expect(commandAudioPaths(command)).toEqual(['/elsewhere/t.wav'])
    expect(audioWithinRoots(command, ['/root/P.vostudio'])).toBe(false)
    expect(audioWithinRoots({ ...command, restore: [] }, ['/root/P.vostudio'])).toBe(true)
  })
})

describe('tableImportSchema', () => {
  it('accepts a request with mapping and options', () => {
    const req = { path: '/tmp/t.csv', rule: 'id', mapping: { id: 0, translation: 2 }, replaceTranslations: true, keepOriginal: true }
    expect(tableImportSchema.parse(req)).toEqual(req)
    expect(tableImportSchema.parse({ path: '/tmp/t.csv', rule: 'exportName' })).toEqual({ path: '/tmp/t.csv', rule: 'exportName' })
  })

  it('rejects relative paths, bad rules and bad columns', () => {
    expect(() => tableImportSchema.parse({ path: 't.csv', rule: 'id' })).toThrow()
    expect(() => tableImportSchema.parse({ path: '/t.csv', rule: 'nope' })).toThrow()
    expect(() => tableImportSchema.parse({ path: '/t.csv', rule: 'id', mapping: { id: -1 } })).toThrow()
    expect(() => tableImportSchema.parse({ path: '/t.csv', rule: 'id', mapping: { id: 1.5 } })).toThrow()
    expect(() => tableImportSchema.parse({ path: '/t.csv', rule: 'id', keepOriginal: 'yes' })).toThrow()
  })
})

describe('table size bound', () => {
  it('rejects tables whose undo would not fit the history command', () => {
    const rows = Array.from({ length: TABLE_ROWS_MAX + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(() => parseTableFile('big.csv', `Text\n${rows}\n`)).toThrow(/more than/)
    expect(parseTableFile('ok.csv', 'Text\nOne\n').rows).toHaveLength(1)
  })
})

describe('table cell bounds', () => {
  it('skips rows whose key or character would not survive the undo and redo commands', () => {
    const project = { cues: [], characters: [] }
    const rows = [
      ['k'.repeat(CUE_KEY_MAX + 1), 'Too long key', ''],
      ['ok', 'Fine', 'c'.repeat(CHARACTER_ID_MAX + 1)],
      ['good', 'Kept', 'Hero'],
    ]
    const result = applyTable(project, rows, { id: 0, translation: 1, character: 2 }, 'id', false)
    expect(result.summary).toEqual({ added: 1, updated: 0, unchanged: 0, skipped: 2 })
    expect(project.cues.map((cue) => cue.key)).toEqual(['good'])
  })

  it('skips rows whose text would exceed the editor limit', () => {
    const project = { cues: [], characters: [] }
    const rows = [['x'.repeat(LINE_TEXT_MAX + 1)], ['Short line']]
    const result = applyTable(project, rows, { translation: 0 }, 'id', false)
    expect(result.summary).toEqual({ added: 1, updated: 0, unchanged: 0, skipped: 1 })
    const script = parseTableFile('script.txt', `${'y'.repeat(LINE_TEXT_MAX + 1)}\n\nFine\n`)
    const fromScript = applyTable({ cues: [], characters: [] }, script.rows, tableMapping(script, []), 'id', false)
    expect(fromScript.summary.skipped).toBe(1)
    expect(fromScript.summary.added).toBe(1)
  })
})
