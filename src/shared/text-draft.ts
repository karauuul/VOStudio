import type { Cue, Project } from './domain'

export interface TextDraft {
  cueId: string
  text: string
  saved?: true
}

export function withDraft<T extends Cue | undefined>(cue: T, draft: TextDraft | null): T {
  return cue && draft?.cueId === cue.id && draft.text !== cue.text ? { ...cue, text: draft.text } : cue
}

export function settleDraft(current: TextDraft | null, saved: TextDraft): TextDraft | null {
  return current === saved ? { ...saved, saved: true } : current
}

export function withSavedText(project: Project | null, saved: Cue): Project | null {
  const cue = project?.cues.find((c) => c.id === saved.id)
  if (!project || !cue || cue.text === saved.text) return project
  const textRevision = saved.textRevision === undefined ? {} : { textRevision: saved.textRevision }
  return { ...project, cues: project.cues.map((c) => (c === cue ? { ...c, text: saved.text, ...textRevision } : c)) }
}
