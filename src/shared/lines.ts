import type { Cue, Project, Take } from './domain'
import type { ProjectCommand } from './project-commands'

const LINE_NAME = /^Line (\d+)$/
const LINE_KEY = /^line-(\d+)$/

export function nextLineNumber(cues: Pick<Cue, 'key' | 'fields'>[]): number {
  let max = 0
  for (const cue of cues) {
    const byName = LINE_NAME.exec(cue.fields['EventName'] ?? '')
    const byKey = LINE_KEY.exec(cue.key)
    max = Math.max(max, byName ? Number(byName[1]) : 0, byKey ? Number(byKey[1]) : 0)
  }
  return max + 1
}

export function newLineCue(id: string, n: number, text = ''): Cue {
  return {
    id,
    characterId: '',
    key: `line-${String(n).padStart(3, '0')}`,
    fields: { EventName: `Line ${n}` },
    sourceText: '',
    text,
    status: text.trim() ? 'translated' : 'empty',
    notes: '',
    takes: [],
  }
}

export function isGeneratedTake(take: Pick<Take, 'kind'>): boolean {
  return take.kind === 'tts' || take.kind === 'sts'
}

export function showsAi(cue: Cue, project: Pick<Project, 'characters' | 'provider'>): boolean {
  return (
    cue.sourceText.trim() !== '' ||
    cue.referenceAudio !== undefined ||
    cue.referenceDuration !== undefined ||
    cue.region !== undefined ||
    cue.characterId !== '' ||
    cue.takes.some(isGeneratedTake) ||
    project.characters.length > 0 ||
    project.provider !== undefined
  )
}

export function isManualProject(project: Pick<Project, 'cues' | 'characters' | 'provider'>): boolean {
  return !project.cues.some((cue) => showsAi(cue, project))
}

export function hasReference(cue: Pick<Cue, 'referenceAudio' | 'region' | 'stems'>): boolean {
  return cue.referenceAudio !== undefined || cue.region !== undefined || (cue.stems?.length ?? 0) > 0
}

export function splitParagraphs(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const separator = /\n[ \t]*\n/.test(normalized) ? /\n[ \t]*\n/ : /\n/
  return normalized
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

export function replacesWholeText(value: string, start: number, end: number): boolean {
  return value.trim().length === 0 || (start === 0 && end === value.length)
}

export const LINE_TEXT_MAX = 5000
export const CREATE_LINES_MAX = 1000

export type ScriptPaste =
  | { problem: string }
  | {
      create: Extract<ProjectCommand, { type: 'cue.create' }>
      text: Extract<ProjectCommand, { type: 'cue.saveText' }>
    }

export function planScriptPaste(cueId: string, parts: string[], newId: () => string): ScriptPaste {
  if (parts.length < 2) return { problem: 'Nothing to split' }
  if (parts.length - 1 > CREATE_LINES_MAX) return { problem: `Too many paragraphs (max ${CREATE_LINES_MAX + 1})` }
  if (parts.some((part) => part.length > LINE_TEXT_MAX)) return { problem: `Paragraph over ${LINE_TEXT_MAX} characters` }
  return {
    create: { type: 'cue.create', afterCueId: cueId, lines: parts.slice(1).map((text) => ({ id: newId(), text })) },
    text: { type: 'cue.saveText', cueId, text: parts[0] },
  }
}
