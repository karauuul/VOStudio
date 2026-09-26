import { describe, expect, it } from 'vitest'
import { applyProjectCommand, type ChangeSet, type ProjectCommand } from '../src/shared/project-commands'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'
import { approvalState, isDone } from '../src/shared/approval'
import { CREATE_LINES_MAX, LINE_TEXT_MAX, PARAGRAPH_TOO_LONG, pasteOverflows, planScriptPaste } from '../src/shared/lines'
import { projectCommandSchema } from '../src/main/schemas'
import {
  doneChange,
  lineStepCommand,
  originalStateOf,
  outputStateIn,
  recordLineEdit,
  refuseWorkRemoval,
  removalBlock,
  runLineStep,
  steppedEdit,
  textFieldStep,
  textStepCommand,
  afterTextStep,
  type LineHistory,
  type StepDir,
} from '../src/shared/line-history'

const cue = (id: string, over: Partial<Cue> = {}): Cue => ({
  id, characterId: '', key: id, fields: {}, sourceText: '', text: '', status: 'empty', notes: '', takes: [], ...over,
})

const project = (cues: Cue[]): Project => ({
  id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', media: { referenceDir: '', referencePattern: '' },
  characters: [], cues, sessions: [], pronunciationRules: '', exportTemplate: '{EventName}.{ext}', ui: { filter: '', search: '' },
})

function session(p: Project) {
  const history: LineHistory = { undo: [], redo: [] }
  const edit = (command: ProjectCommand): ChangeSet => {
    const changes = applyProjectCommand(p, command)
    history.redo = []
    return changes
  }
  const step = (dir: StepDir) =>
    runLineStep(history, dir, async (entry) => {
      const owner = entry.kind === 'original' ? p.cues.find((c) => c.id === entry.cueId) : undefined
      const current = owner ? structuredClone(owner) : undefined
      const next = steppedEdit(entry, dir, applyProjectCommand(p, lineStepCommand(entry, dir)), current)
      const textCommand = textStepCommand(next, dir)
      return textCommand ? afterTextStep(next, dir, applyProjectCommand(p, textCommand)) : next
    })
  return { history, edit, step }
}

const ids = (p: Project): string[] => p.cues.map((c) => c.id)

describe('line history', () => {
  it('create, edit, undo, redo keeps the edits made after creation', async () => {
    const p = project([cue('a'), cue('b')])
    const s = session(p)
    s.edit({ type: 'cue.create', afterCueId: 'a', lines: [{ id: 'n', text: '' }] })
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: true, ids: ['n'], snapshots: [], focus: 'n' }, 1)
    s.edit({ type: 'cue.saveText', cueId: 'n', text: 'typed later' })
    const edited = structuredClone(p.cues[1])
    await s.step('undo')
    expect(ids(p)).toEqual(['a', 'b'])
    await s.step('redo')
    expect(ids(p)).toEqual(['a', 'n', 'b'])
    expect(p.cues[1]).toEqual(edited)
    expect(p.cues[1].text).toBe('typed later')
  })

  it('delete, undo, edit clears redo so the edited line cannot be deleted by a stale redo', async () => {
    const p = project([cue('a'), cue('b', { text: 'old' })])
    const s = session(p)
    const changes = s.edit({ type: 'cue.delete', cueIds: ['b'] })
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: false, ids: ['b'], snapshots: changes.removedCues ?? [], focus: 'b' }, 1)
    await s.step('undo')
    expect(ids(p)).toEqual(['a', 'b'])
    expect(s.history.redo).toHaveLength(1)
    s.edit({ type: 'cue.saveText', cueId: 'b', text: 'new' })
    expect(s.history.redo).toHaveLength(0)
    expect(await s.step('redo')).toBeNull()
    expect(p.cues[1].text).toBe('new')
  })

  it('redo of a delete takes a fresh snapshot, so a later undo brings back the current line', async () => {
    const p = project([cue('a'), cue('b', { text: 'old' })])
    const s = session(p)
    const changes = s.edit({ type: 'cue.delete', cueIds: ['b'] })
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: false, ids: ['b'], snapshots: changes.removedCues ?? [], focus: 'b' }, 1)
    await s.step('undo')
    applyProjectCommand(p, { type: 'cue.saveText', cueId: 'b', text: 'kept' })
    await s.step('redo')
    await s.step('undo')
    expect(p.cues[1].text).toBe('kept')
  })

  it('a multi-line undo blocked by one line changes nothing and keeps the entry', async () => {
    const p = project([cue('a'), cue('n1'), cue('n2')])
    const s = session(p)
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: true, ids: ['n1', 'n2'], snapshots: [], focus: 'a' }, 1)
    p.cues[2].takes.push({ id: 't', kind: 'tts', createdAt: 'now', file: { fileId: 't', relPath: '/p/t.wav', format: 'wav' }, duration: 1, meta: {}, edits: emptyEdits(), pinned: true })
    p.cues[0].comp = { clips: [{ id: 'c', sourceTakeId: 't', srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() }] }
    const before = structuredClone(p)
    const entry = structuredClone(s.history.undo[0])
    await expect(s.step('undo')).rejects.toThrow('used on another line')
    expect(p).toEqual(before)
    expect(s.history.undo).toEqual([entry])
    expect(s.history.redo).toEqual([])
  })

  it('undoes and redoes Use as original with the reference current at each step', async () => {
    const ref = { fileId: 'r', relPath: '/p/r.wav', format: 'wav' as const }
    const p = project([cue('a', { referenceAudio: ref, referenceDuration: 3, takes: [{ id: 't', kind: 'imported', createdAt: 'now', file: { fileId: 't', relPath: '/p/t.wav', format: 'wav' }, duration: 1, meta: {}, edits: emptyEdits() }] })])
    const s = session(p)
    const before = originalStateOf(p.cues[0])
    const changes = s.edit({ type: 'cue.useTakeAsOriginal', cueId: 'a', takeId: 't' })
    recordLineEdit(s.history, { kind: 'original', cueId: 'a', takeId: 't', before, after: outputStateIn(changes, 'a') }, 1)
    await s.step('undo')
    expect(p.cues[0].referenceAudio).toEqual(ref)
    expect(p.cues[0].referenceDuration).toBe(3)
    await s.step('redo')
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/t.wav')
    expect(p.cues[0].referenceDuration).toBe(1)
    await s.step('undo')
    expect(p.cues[0].referenceAudio).toEqual(ref)
  })

  it('undo, redo, undo of Use as original keeps an exclusion made after the action', async () => {
    const take = { id: 't', kind: 'imported' as const, createdAt: 'now', file: { fileId: 't', relPath: '/p/t.wav', format: 'wav' as const }, duration: 1, meta: {}, edits: emptyEdits() }
    const p = project([cue('a', { text: 'T', status: 'generated', referenceAudio: { fileId: 'r', relPath: '/p/r.wav', format: 'wav' }, takes: [take], finalTakeId: 't' })])
    const s = session(p)
    const before = originalStateOf(p.cues[0])
    const changes = s.edit({ type: 'cue.useTakeAsOriginal', cueId: 'a', takeId: 't' })
    recordLineEdit(s.history, { kind: 'original', cueId: 'a', takeId: 't', before, after: outputStateIn(changes, 'a') }, 1)
    applyProjectCommand(p, { type: 'cue.setExcluded', cueId: 'a', excluded: true })
    await s.step('undo')
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/r.wav')
    expect(p.cues[0].status).toBe('excluded')
    await s.step('redo')
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/t.wav')
    await s.step('undo')
    expect(p.cues[0].referenceAudio?.relPath).toBe('/p/r.wav')
    expect(p.cues[0].status).toBe('excluded')
  })

  it('caps the undo stack and clears redo on every new entry', () => {
    const history: LineHistory = { undo: [], redo: [{ kind: 'cues', undoRemoves: true, ids: ['x'], snapshots: [], focus: 'x', at: 0 }] }
    for (let i = 0; i < 105; i++) recordLineEdit(history, { kind: 'cues', undoRemoves: true, ids: [`n${i}`], snapshots: [], focus: `n${i}` }, i)
    expect(history.undo).toHaveLength(100)
    expect(history.undo[0].at).toBe(5)
    expect(history.redo).toEqual([])
  })
})

describe('undoing Done', () => {
  const take = (id: string): Take => ({ id, kind: 'tts', createdAt: 'now', file: { fileId: id, relPath: `/p/${id}.wav`, format: 'wav' }, duration: 1, meta: {}, edits: emptyEdits() })
  const voiced = (): Cue => cue('a', { text: 'T', status: 'generated', takes: [take('t'), take('u')], finalTakeId: 't' })

  function toggled(p: Project, s: ReturnType<typeof session>, approved: boolean): Cue {
    const before = structuredClone(p.cues[0])
    const change = doneChange(before, s.edit({ type: 'cue.approve', cueId: 'a', approved, approvedAt: 'then' }))
    if (change) recordLineEdit(s.history, change, 1)
    return before
  }

  it('undoes and redoes Done exactly, keeping the approval time', async () => {
    const p = project([voiced()])
    const s = session(p)
    const before = toggled(p, s, true)
    const done = structuredClone(p.cues[0])
    expect(isDone(done, p)).toBe(true)
    await s.step('undo')
    expect(p.cues[0]).toEqual(before)
    expect(p.cues[0]).not.toHaveProperty('output')
    await s.step('redo')
    expect(p.cues[0]).toEqual(done)
    await s.step('undo')
    expect(p.cues[0]).toEqual(before)
  })

  it('undo of Not done brings back the earlier approval, not a fresh one', async () => {
    const p = project([voiced()])
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'a', approved: true, approvedAt: 'earlier' })
    const s = session(p)
    const before = toggled(p, s, false)
    expect(isDone(p.cues[0], p)).toBe(false)
    await s.step('undo')
    expect(p.cues[0]).toEqual(before)
    expect(p.cues[0].approval?.approvedAt).toBe('earlier')
    await s.step('redo')
    expect(isDone(p.cues[0], p)).toBe(false)
    expect(p.cues[0]).not.toHaveProperty('approval')
  })

  it('leaves a line alone whose output or approval changed after the step', async () => {
    const later: ProjectCommand[] = [
      { type: 'cue.setFinalTake', cueId: 'a', takeId: 'u' },
      { type: 'cue.approve', cueId: 'a', approved: false },
      { type: 'cue.approve', cueId: 'a', approved: true, approvedAt: 'later' },
    ]
    for (const command of later) {
      const p = project([voiced()])
      const s = session(p)
      toggled(p, s, true)
      applyProjectCommand(p, command)
      const current = structuredClone(p.cues[0])
      await s.step('undo')
      expect(p.cues[0]).toEqual(current)
      await s.step('redo')
      expect(p.cues[0]).toEqual(current)
    }
    const p = project([voiced()])
    const s = session(p)
    toggled(p, s, true)
    applyProjectCommand(p, { type: 'cue.setFinalTake', cueId: 'a', takeId: 'u' })
    await s.step('undo')
    expect(approvalState(p.cues[0], p)).toBe('stale')
  })

  it('refuses to bring back an approval for text edited after the step', async () => {
    const p = project([voiced()])
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'a', approved: true, approvedAt: 'earlier' })
    const s = session(p)
    toggled(p, s, false)
    applyProjectCommand(p, { type: 'cue.saveText', cueId: 'a', text: 'edited' })
    const current = structuredClone(p.cues[0])
    await s.step('undo')
    expect(p.cues[0]).toEqual(current)
    expect(isDone(p.cues[0], p)).toBe(false)
  })

  it('records no step when another edit landed between the snapshot and the toggle', () => {
    const concurrent: ProjectCommand[] = [
      { type: 'cue.setFinalTake', cueId: 'a', takeId: 'u' },
      { type: 'cue.saveText', cueId: 'a', text: 'edited' },
    ]
    for (const [approved, command] of [true, false].flatMap((a) => concurrent.map((c) => [a, c] as const))) {
      const p = project([voiced()])
      if (!approved) applyProjectCommand(p, { type: 'cue.approve', cueId: 'a', approved: true, approvedAt: 'earlier' })
      const stale = structuredClone(p.cues[0])
      applyProjectCommand(p, command)
      expect(doneChange(stale, applyProjectCommand(p, { type: 'cue.approve', cueId: 'a', approved, approvedAt: 'then' }))).toBeNull()
    }
  })

  it('records nothing when the toggle changed nothing', () => {
    const p = project([voiced()])
    const before = structuredClone(p.cues[0])
    expect(doneChange(before, applyProjectCommand(p, { type: 'cue.approve', cueId: 'a', approved: false }))).toBeNull()
  })

  it('sends undo and redo through the command schema unchanged', () => {
    const p = project([voiced()])
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'a', approved: true, approvedAt: 'earlier' })
    const before = structuredClone(p.cues[0])
    const change = doneChange(before, applyProjectCommand(p, { type: 'cue.approve', cueId: 'a', approved: false }))
    if (!change) throw new Error('no change')
    for (const dir of ['undo', 'redo'] as const) {
      const command = lineStepCommand({ ...change, at: 1 }, dir)
      expect(projectCommandSchema.parse(command)).toEqual(command)
    }
  })
})

describe('line removal guard', () => {
  const idle = { busy: () => false, recordingCueId: null }

  it('allows idle lines', () => {
    expect(removalBlock(['a', 'b'], idle)).toBeNull()
  })

  it('refuses when any line has a pending job', () => {
    expect(removalBlock(['a', 'b'], { ...idle, busy: (id) => id === 'b' })).toBe('Line is busy')
  })

  it('refuses when one of the lines is recording or holds an unsaved recording', () => {
    expect(removalBlock(['a', 'b'], { ...idle, recordingCueId: 'a' })).toBe('Stop the recording first')
    expect(removalBlock(['b'], { ...idle, recordingCueId: 'a' })).toBeNull()
  })
})

describe('script paste validation', () => {
  let n = 0
  const id = (): string => `n${++n}`

  it('plans line creation and the first-line text within the command limits', () => {
    const parts = ['x'.repeat(LINE_TEXT_MAX), ...Array.from({ length: CREATE_LINES_MAX }, (_, i) => `p${i}`)]
    const plan = planScriptPaste('a', parts, id)
    if ('problem' in plan) throw new Error(plan.problem)
    expect(projectCommandSchema.parse(plan.create)).toEqual(plan.create)
    expect(projectCommandSchema.parse(plan.text)).toEqual(plan.text)
    expect(plan.create.afterCueId).toBe('a')
    expect(plan.create.lines.map((l) => l.text)).toEqual(parts.slice(1))
  })

  it('refuses too many paragraphs or a paragraph over the length limit', () => {
    expect(planScriptPaste('a', Array.from({ length: CREATE_LINES_MAX + 2 }, () => 'p'), id)).toHaveProperty('problem')
    expect(planScriptPaste('a', ['ok', 'x'.repeat(LINE_TEXT_MAX + 1)], id)).toHaveProperty('problem')
    expect(planScriptPaste('a', ['x'.repeat(LINE_TEXT_MAX + 1), 'ok'], id)).toHaveProperty('problem')
    expect(() => projectCommandSchema.parse({ type: 'cue.saveText', cueId: 'a', text: 'x'.repeat(LINE_TEXT_MAX + 1) })).toThrow()
  })

  it('a paste over the limit leaves the line text and the project unchanged', () => {
    const p = project([cue('a', { text: 'keep me' }), cue('b')])
    const before = structuredClone(p)
    const plan = planScriptPaste('a', ['first', 'y'.repeat(LINE_TEXT_MAX + 1)], id)
    if (!('problem' in plan)) {
      applyProjectCommand(p, plan.create)
      applyProjectCommand(p, plan.text)
    }
    expect(p).toEqual(before)
    expect(p.cues[0].text).toBe('keep me')
  })

  it('reports an over-long paragraph with the same status as a single-paragraph overflow', () => {
    expect(planScriptPaste('a', ['ok', 'x'.repeat(LINE_TEXT_MAX + 1)], id)).toEqual({ problem: PARAGRAPH_TOO_LONG })
    expect(PARAGRAPH_TOO_LONG).toBe('Paragraph over 5000 characters')
  })
})

describe('single-paragraph paste limit', () => {
  it('allows a paste that lands exactly on the limit and refuses one character more', () => {
    expect(pasteOverflows('', 0, 0, 'x'.repeat(LINE_TEXT_MAX))).toBe(false)
    expect(pasteOverflows('', 0, 0, 'x'.repeat(LINE_TEXT_MAX + 1))).toBe(true)
    expect(pasteOverflows('', 0, 0, 'x'.repeat(5100))).toBe(true)
  })

  it('counts the existing text around the caret', () => {
    const value = 'a'.repeat(4000)
    expect(pasteOverflows(value, 4000, 4000, 'b'.repeat(1000))).toBe(false)
    expect(pasteOverflows(value, 4000, 4000, 'b'.repeat(1001))).toBe(true)
    expect(pasteOverflows(value, 2000, 2000, 'b'.repeat(1001))).toBe(true)
  })

  it('subtracts the selection the paste replaces', () => {
    const value = 'a'.repeat(4500)
    expect(pasteOverflows(value, 0, 4500, 'b'.repeat(LINE_TEXT_MAX))).toBe(false)
    expect(pasteOverflows(value, 1000, 2000, 'b'.repeat(1500))).toBe(false)
    expect(pasteOverflows(value, 1000, 1400, 'b'.repeat(1000))).toBe(true)
  })

  it('counts a CRLF or lone CR line break as one character, as the text field stores it', () => {
    const lines = 'x'.repeat(LINE_TEXT_MAX - 2)
    expect(pasteOverflows('', 0, 0, `${lines}\r\n.`)).toBe(false)
    expect(pasteOverflows('', 0, 0, `${lines}\r.`)).toBe(false)
    expect(pasteOverflows('', 0, 0, `${lines}\r\n..`)).toBe(true)
  })

  it('refuses any insertion into text already over the limit but allows a paste that shrinks it back under', () => {
    const value = 'a'.repeat(LINE_TEXT_MAX + 10)
    expect(pasteOverflows(value, 0, 0, 'b')).toBe(true)
    expect(pasteOverflows(value, 0, 100, 'b')).toBe(false)
  })
})

describe('undo and redo from the text field', () => {
  const paste = { kind: 'cues' as const, undoRemoves: true, ids: ['n1'], snapshots: [], focus: 'a', text: { cueId: 'a', before: 'old', after: 'One.' }, at: 1 }

  it('undoes a split paste only while the line still shows the pasted text', () => {
    const history: LineHistory = { undo: [paste], redo: [] }
    expect(textFieldStep(history, 'undo', 'a', 'One.')).toBe(true)
    expect(textFieldStep(history, 'undo', 'a', 'One. typed')).toBe(false)
    expect(textFieldStep(history, 'undo', 'b', 'One.')).toBe(false)
    expect(textFieldStep(history, 'redo', 'a', 'old')).toBe(false)
  })

  it('redoes it only while the line still shows the text from before the paste', () => {
    const history: LineHistory = { undo: [], redo: [paste] }
    expect(textFieldStep(history, 'redo', 'a', 'old')).toBe(true)
    expect(textFieldStep(history, 'redo', 'a', 'old!')).toBe(false)
    expect(textFieldStep(history, 'redo', 'b', 'old')).toBe(false)
    expect(textFieldStep(history, 'undo', 'a', 'One.')).toBe(false)
  })

  it('leaves the field alone for other line changes', () => {
    const plain = { kind: 'cues' as const, undoRemoves: true, ids: ['n1'], snapshots: [], focus: 'n1', at: 1 }
    expect(textFieldStep({ undo: [plain], redo: [plain] }, 'undo', 'n1', '')).toBe(false)
    expect(textFieldStep({ undo: [plain], redo: [plain] }, 'redo', 'n1', '')).toBe(false)
  })
})

describe('undoing a split paste never overwrites later edits', () => {
  function pasted() {
    const p = project([cue('a', { text: 'old' }), cue('b')])
    const s = session(p)
    s.edit({ type: 'cue.create', afterCueId: 'a', lines: [{ id: 'n1', text: 'Two.' }, { id: 'n2', text: 'Three.' }] })
    s.edit({ type: 'cue.saveText', cueId: 'a', text: 'One.' })
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: true, ids: ['n1', 'n2'], snapshots: [], focus: 'a', text: { cueId: 'a', before: 'old', after: 'One.' } }, 1)
    return { p, s }
  }

  it('restores the old text and removes the lines when the first line is untouched', async () => {
    const { p, s } = pasted()
    await s.step('undo')
    expect(ids(p)).toEqual(['a', 'b'])
    expect(p.cues[0].text).toBe('old')
    await s.step('redo')
    expect(ids(p)).toEqual(['a', 'n1', 'n2', 'b'])
    expect(p.cues[0].text).toBe('One.')
  })

  it('keeps an edited first line, removes only the new lines, and redo brings back only the lines', async () => {
    const { p, s } = pasted()
    applyProjectCommand(p, { type: 'cue.saveText', cueId: 'a', text: 'One. And more.' })
    await s.step('undo')
    expect(ids(p)).toEqual(['a', 'b'])
    expect(p.cues[0].text).toBe('One. And more.')
    expect(s.history.redo[0]).not.toHaveProperty('text')
    await s.step('redo')
    expect(ids(p)).toEqual(['a', 'n1', 'n2', 'b'])
    expect(p.cues[0].text).toBe('One. And more.')
    await s.step('undo')
    expect(p.cues[0].text).toBe('One. And more.')
  })

  it('redo leaves a first line alone if it changed after the undo', async () => {
    const { p, s } = pasted()
    await s.step('undo')
    applyProjectCommand(p, { type: 'cue.saveText', cueId: 'a', text: 'rewritten' })
    await s.step('redo')
    expect(ids(p)).toEqual(['a', 'n1', 'n2', 'b'])
    expect(p.cues[0].text).toBe('rewritten')
  })

  it('a conditional text save changes nothing when the text moved on', () => {
    const p = project([cue('a', { text: 'now' })])
    const before = structuredClone(p)
    applyProjectCommand(p, { type: 'cue.saveText', cueId: 'a', text: 'x', ifText: 'then' })
    expect(p).toEqual(before)
  })
})

describe('history never removes lines that hold work', () => {
  const take = (id: string, over: Partial<Take> = {}): Take => ({ id, kind: 'recording', createdAt: 'now', file: { fileId: id, relPath: `/p/${id}.wav`, format: 'wav' }, duration: 1, meta: {}, edits: emptyEdits(), ...over })
  const clip = (takeId: string) => ({ id: `c-${takeId}`, sourceTakeId: takeId, srcIn: 0, srcOut: 1, start: 0, edits: emptyEdits() })

  function pasted() {
    const p = project([cue('a', { text: 'old' }), cue('b')])
    const s = session(p)
    s.edit({ type: 'cue.create', afterCueId: 'b', lines: [{ id: 'x', text: 'Earlier.' }] })
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: true, ids: ['x'], snapshots: [], focus: 'x' }, 1)
    s.edit({ type: 'cue.create', afterCueId: 'a', lines: [{ id: 'n1', text: 'Two.' }, { id: 'n2', text: 'Three.' }] })
    s.edit({ type: 'cue.saveText', cueId: 'a', text: 'One.' })
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: true, ids: ['n1', 'n2'], snapshots: [], focus: 'a', text: { cueId: 'a', before: 'old', after: 'One.' } }, 2)
    return { p, s }
  }

  it('refuses a paste undo once a pasted line has a take, drops the entry and reaches the older one next', async () => {
    const { p, s } = pasted()
    p.cues[2].takes.push(take('t'))
    const before = structuredClone(p)
    expect(refuseWorkRemoval(s.history, 'undo', p.cues)).toBe(true)
    expect(p).toEqual(before)
    expect(s.history.undo.map((e) => e.at)).toEqual([1])
    expect(s.history.redo).toEqual([])
    expect(refuseWorkRemoval(s.history, 'undo', p.cues)).toBe(false)
    await s.step('undo')
    expect(ids(p)).toEqual(['a', 'n1', 'n2', 'b'])
    expect(p.cues[2].takes).toHaveLength(1)
  })

  it('refuses when a pasted line only has clips on its timeline', () => {
    const { p, s } = pasted()
    p.cues[0].takes.push(take('t', { pinned: true }))
    p.cues[1].comp = { clips: [clip('t')] }
    expect(refuseWorkRemoval(s.history, 'undo', p.cues)).toBe(true)
    expect(ids(p)).toEqual(['a', 'n1', 'n2', 'b', 'x'])
  })

  it('still undoes the paste when the pasted lines were left untouched', async () => {
    const { p, s } = pasted()
    p.cues[0].takes.push(take('t'))
    p.cues[0].comp = { clips: [clip('t')] }
    p.cues[1].takes.push(take('gone', { deletedAt: 'then' }))
    expect(refuseWorkRemoval(s.history, 'undo', p.cues)).toBe(false)
    expect(s.history.undo).toHaveLength(2)
    await s.step('undo')
    expect(ids(p)).toEqual(['a', 'b', 'x'])
    expect(p.cues[0].text).toBe('old')
    expect(p.cues[0].takes).toHaveLength(1)
  })

  it('lets redo repeat an explicit delete of a line holding work', async () => {
    const p = project([cue('a'), cue('b', { takes: [take('t')] })])
    const s = session(p)
    const changes = s.edit({ type: 'cue.delete', cueIds: ['b'] })
    recordLineEdit(s.history, { kind: 'cues', undoRemoves: false, ids: ['b'], snapshots: changes.removedCues ?? [], focus: 'b' }, 1)
    expect(refuseWorkRemoval(s.history, 'undo', p.cues)).toBe(false)
    await s.step('undo')
    expect(ids(p)).toEqual(['a', 'b'])
    expect(refuseWorkRemoval(s.history, 'redo', p.cues)).toBe(false)
    await s.step('redo')
    expect(ids(p)).toEqual(['a'])
  })

  it('refuses a table undo that would remove imported lines holding work', () => {
    const p = project([cue('a'), cue('m', { takes: [take('t')] })])
    const history: LineHistory = { undo: [{ kind: 'table', ids: ['m'], snapshots: [], fields: [], characters: [], focus: 'm', at: 1 }], redo: [] }
    expect(refuseWorkRemoval(history, 'undo', p.cues)).toBe(true)
    expect(history.undo).toEqual([])
  })

  it('leaves steps alone that remove nothing', () => {
    const p = project([cue('a', { takes: [take('t')] })])
    const history: LineHistory = {
      undo: [{ kind: 'done', cueId: 'a', textRevision: 0, before: { status: 'empty' }, after: { status: 'generated' }, at: 1 }],
      redo: [{ kind: 'cues', undoRemoves: true, ids: ['a'], snapshots: [], focus: 'a', at: 2 }],
    }
    expect(refuseWorkRemoval(history, 'undo', p.cues)).toBe(false)
    expect(refuseWorkRemoval(history, 'redo', p.cues)).toBe(false)
    expect(refuseWorkRemoval({ undo: [], redo: [] }, 'undo', p.cues)).toBe(false)
    expect(history.undo).toHaveLength(1)
    expect(history.redo).toHaveLength(1)
  })
})
