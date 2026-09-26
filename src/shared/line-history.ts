import type { Character, Cue } from './domain'
import type { ChangeSet, FieldStep, OriginalState, OutputState, PlacedCue, ProjectCommand } from './project-commands'

export type LineChange =
  | {
      kind: 'cues'
      undoRemoves: boolean
      ids: string[]
      snapshots: PlacedCue[]
      focus: string
      text?: { cueId: string; before: string; after: string }
    }
  | {
      kind: 'table'
      ids: string[]
      snapshots: PlacedCue[]
      fields: FieldStep[]
      characters: Character[]
      focus: string
    }
  | { kind: 'original'; cueId: string; takeId: string; before: OriginalState; after: OutputState }

export type LineEdit = LineChange & { at: number }

export interface LineHistory {
  undo: LineEdit[]
  redo: LineEdit[]
}

export type StepDir = 'undo' | 'redo'

export const LINE_HISTORY_LIMIT = 100

const outputStateOf = (cue: Cue): OutputState => ({
  status: cue.status,
  ...(cue.output === undefined ? {} : { output: structuredClone(cue.output) }),
  ...(cue.approval === undefined ? {} : { approval: structuredClone(cue.approval) }),
})

export const originalStateOf = (cue: Cue): OriginalState => ({
  referenceAudio: cue.referenceAudio ?? null,
  referenceDuration: cue.referenceDuration ?? null,
  ...outputStateOf(cue),
})

export function outputStateIn(changes: ChangeSet, cueId: string): OutputState {
  const cue = changes.cues?.find((item) => item.id === cueId)
  if (!cue) throw new Error('Cue not found')
  return outputStateOf(cue)
}

export function recordLineEdit(history: LineHistory, change: LineChange, at: number): void {
  history.undo.push({ ...change, at })
  if (history.undo.length > LINE_HISTORY_LIMIT) history.undo.shift()
  history.redo = []
}

export function removesLines(edit: LineEdit, dir: StepDir): boolean {
  if (edit.kind === 'table') return dir === 'undo' && edit.ids.length > 0
  return edit.kind === 'cues' && (dir === 'undo') === edit.undoRemoves
}

export function lineStepCommand(edit: LineEdit, dir: StepDir): ProjectCommand {
  if (edit.kind === 'original') {
    return dir === 'undo'
      ? { type: 'cue.restoreOriginal', cueId: edit.cueId, whenState: edit.after, ...edit.before }
      : { type: 'cue.useTakeAsOriginal', cueId: edit.cueId, takeId: edit.takeId }
  }
  if (edit.kind === 'table') {
    const undo = dir === 'undo'
    return {
      type: 'table.step',
      remove: undo ? edit.ids : [],
      restore: undo ? [] : edit.snapshots,
      fields: undo ? edit.fields.map(({ cueId, from, to }) => ({ cueId, from: to, to: from })) : edit.fields,
      addCharacters: undo ? [] : edit.characters,
      dropCharacters: undo ? edit.characters : [],
    }
  }
  return removesLines(edit, dir)
    ? { type: 'cue.delete', cueIds: edit.ids }
    : { type: 'cue.restore', cues: edit.snapshots }
}

export function steppedEdit(edit: LineEdit, dir: StepDir, changes: ChangeSet, current: Cue | undefined): LineEdit {
  if (edit.kind === 'original') {
    if (dir === 'undo' || !current) return edit
    return { ...edit, before: originalStateOf(current), after: outputStateIn(changes, edit.cueId) }
  }
  return removesLines(edit, dir) ? { ...edit, snapshots: changes.removedCues ?? [] } : edit
}

export async function runLineStep(
  history: LineHistory,
  dir: StepDir,
  apply: (edit: LineEdit) => Promise<LineEdit>
): Promise<LineEdit | null> {
  const from = dir === 'undo' ? history.undo : history.redo
  const edit = from.pop()
  if (!edit) return null
  let next: LineEdit
  try {
    next = await apply(edit)
  } catch (error) {
    from.push(edit)
    throw error
  }
  ;(dir === 'undo' ? history.redo : history.undo).push(next)
  return next
}

export interface RemovalState {
  busy: (cueId: string) => boolean
  recordingCueId: string | null
}

export function removalBlock(ids: string[], state: RemovalState): string | null {
  if (state.recordingCueId !== null && ids.includes(state.recordingCueId)) return 'Stop the recording first'
  if (ids.some((id) => state.busy(id))) return 'Line is busy'
  return null
}

export function textFieldStep(history: LineHistory, dir: StepDir, cueId: string, text: string): boolean {
  const stack = dir === 'undo' ? history.undo : history.redo
  const top = stack[stack.length - 1]
  const paste = top?.kind === 'cues' ? top.text : undefined
  return !!paste && paste.cueId === cueId && text === (dir === 'undo' ? paste.after : paste.before)
}

export function textStepCommand(edit: LineEdit, dir: StepDir): ProjectCommand | null {
  if (edit.kind !== 'cues' || !edit.text) return null
  const { cueId, before, after } = edit.text
  return dir === 'undo'
    ? { type: 'cue.saveText', cueId, text: before, ifText: after }
    : { type: 'cue.saveText', cueId, text: after, ifText: before }
}

export function afterTextStep(edit: LineEdit, dir: StepDir, changes: ChangeSet): LineEdit {
  if (edit.kind !== 'cues' || !edit.text) return edit
  const { cueId, before, after } = edit.text
  if (changes.cues?.find((cue) => cue.id === cueId)?.text === (dir === 'undo' ? before : after)) return edit
  const { text: _dropped, ...lines } = edit
  return lines
}
