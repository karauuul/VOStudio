import type { Term } from './domain'

export type TermFields = Pick<Term, 'term' | 'translation'> & { note: string }

export const termFields = (term?: Term): TermFields => ({
  term: term?.term ?? '',
  translation: term?.translation ?? '',
  note: term?.note ?? '',
})

export const filledFields = (fields: TermFields): boolean => fields.term.trim() !== '' && fields.translation.trim() !== ''

export const fieldsTerm = (fields: TermFields, proposed: boolean): Term => ({
  term: fields.term.trim(),
  translation: fields.translation.trim(),
  ...(fields.note.trim() ? { note: fields.note.trim() } : {}),
  ...(proposed ? { proposed: true as const } : {}),
})

export const acceptedTerm = (term: Term, draft: TermFields): Term => fieldsTerm(filledFields(draft) ? draft : termFields(term), false)
