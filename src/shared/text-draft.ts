import type { Cue } from './domain'

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
