import { changeCueSourceText, changeCueText } from './approval'
import { liveTakes, type Cue, type Project } from './domain'
import type { TemplateIssue } from './ipc'

export interface ReimportRow {
  cueId: string
  character: string
  sourceText: string
  translation: string
  exportName: string
  status: string
  durationHint: string
  note: string
  fields: Record<string, string>
}

export interface UpdatedRow<R> {
  row: R
  cue: Cue
  sourceChanged: boolean
  translationChanged: boolean
}

export interface TemplateDiff<R> {
  added: R[]
  updated: UpdatedRow<R>[]
  untouched: R[]
  orphaned: Cue[]
}

export function diffTemplate<R extends ReimportRow>(
  project: Pick<Project, 'cues'>,
  rows: R[]
): TemplateDiff<R> {
  const byKey = new Map(project.cues.map((cue) => [cue.key, cue]))
  const matched = new Set<string>()
  const added: R[] = []
  const updated: UpdatedRow<R>[] = []
  const untouched: R[] = []

  for (const row of rows) {
    const cue = byKey.get(row.cueId)
    if (!cue) {
      added.push(row)
      continue
    }
    matched.add(cue.key)
    const sourceChanged = row.sourceText !== cue.sourceText
    const translationChanged = row.translation.trim() !== '' && row.translation !== cue.text
    if (sourceChanged || translationChanged) updated.push({ row, cue, sourceChanged, translationChanged })
    else untouched.push(row)
  }

  return { added, updated, untouched, orphaned: project.cues.filter((cue) => !matched.has(cue.key)) }
}

export function applyTemplateDiff<R extends ReimportRow>(
  project: Pick<Project, 'cues'>,
  diff: TemplateDiff<R>,
  addedCues: Cue[]
): { changed: Cue[]; warnings: TemplateIssue[] } {
  const byKey = new Map(project.cues.map((cue) => [cue.key, cue]))
  const changed = new Map<string, Cue>()
  const warnings: TemplateIssue[] = []

  for (const { row, cue, sourceChanged, translationChanged } of diff.updated) {
    if (sourceChanged) Object.assign(cue, changeCueSourceText(cue, row.sourceText))
    if (translationChanged) {
      if (cue.text.trim()) cue.suggestedText = row.translation
      else {
        Object.assign(cue, changeCueText(cue, row.translation))
        if (cue.status === 'empty' && row.translation.trim()) cue.status = 'translated'
      }
    }
    cue.fields = { ...cue.fields, ...row.fields }
    changed.set(cue.id, cue)
  }

  for (const row of diff.updated.map((entry) => entry.row).concat(diff.untouched)) {
    if (row.status !== 'excluded') continue
    const cue = byKey.get(row.cueId)
    if (!cue || cue.status === 'excluded') continue
    if (liveTakes(cue).length > 0) {
      warnings.push({ row: null, reason: `Cue "${row.cueId}" has takes — status kept as "${cue.status}"` })
      continue
    }
    cue.status = 'excluded'
    changed.set(cue.id, cue)
  }

  for (const cue of addedCues) {
    project.cues.push(cue)
    changed.set(cue.id, cue)
  }

  return { changed: [...changed.values()], warnings }
}
