import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import type { Term } from '@shared/domain'
import { Overlay } from './Overlay'

type Fields = Pick<Term, 'term' | 'translation'> & { note: string }

const fieldsOf = (term?: Term): Fields => ({
  term: term?.term ?? '',
  translation: term?.translation ?? '',
  note: term?.note ?? '',
})

const sameFields = (a: Fields, b: Fields): boolean =>
  a.term.trim() === b.term.trim() && a.translation.trim() === b.translation.trim() && a.note.trim() === b.note.trim()

const toTerm = (fields: Fields, proposed: boolean): Term => ({
  term: fields.term.trim(),
  translation: fields.translation.trim(),
  ...(fields.note.trim() ? { note: fields.note.trim() } : {}),
  ...(proposed ? { proposed: true as const } : {}),
})

const TrashIcon = () => (
  <svg width="12" height="13" viewBox="0 0 12 13" aria-hidden="true">
    <path d="M1 3h10M4 3V1h4v2M2 3l1 9h6l1-9" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

function TermRow({
  term,
  onCommit,
  onAccept,
  onRemove,
}: {
  term?: Term
  onCommit: (term: Term | null) => void
  onAccept?: () => void
  onRemove?: () => void
}) {
  const stored = fieldsOf(term)
  const [draft, setDraft] = useState<Fields>(stored)

  const leave = (e: FocusEvent<HTMLDivElement>): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    const filled = draft.term.trim() !== '' && draft.translation.trim() !== ''
    if (!term) {
      if (filled) onCommit(toTerm(draft, false))
      else if (!draft.term.trim() && !draft.translation.trim() && !draft.note.trim()) onCommit(null)
      return
    }
    if (!filled) setDraft(stored)
    else if (!sameFields(draft, stored)) onCommit(toTerm(draft, term.proposed === true))
  }

  const key = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return
    e.preventDefault()
    e.currentTarget.blur()
  }

  const input = (field: keyof Fields, autoFocus = false) => (
    <input
      className="gls-in"
      value={draft[field]}
      spellCheck={false}
      autoFocus={autoFocus}
      aria-label={field}
      onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
      onKeyDown={key}
    />
  )

  return (
    <div className={'gls-row' + (term?.proposed ? ' prop' : '')} onBlur={leave}>
      {input('term', !term)}
      {input('translation')}
      {input('note')}
      <span className="gls-acts">
        {term?.proposed ? (
          <>
            <span className="gls-st">Proposed</span>
            <button className="btn ghost" onClick={onAccept}>
              Accept
            </button>
            <button className="btn ghost" onClick={onRemove}>
              Reject
            </button>
          </>
        ) : (
          term && (
            <button className="ico sm" aria-label="Delete term" onClick={onRemove}>
              <TrashIcon />
            </button>
          )
        )}
      </span>
    </div>
  )
}

interface Props {
  terms: Term[]
  onCommit: (terms: Term[]) => void
  onClose: () => void
}

export function GlossaryDialog({ terms, onCommit, onClose }: Props) {
  const [adding, setAdding] = useState(false)
  const latest = useRef(terms)
  const proposed = terms.filter((t) => t.proposed).length

  useEffect(() => {
    latest.current = terms
  }, [terms])

  const apply = (next: Term[]): void => {
    latest.current = next
    onCommit(next)
  }

  const replace = (term: Term, next: Term | null): void =>
    apply(next ? latest.current.map((t) => (t === term ? next : t)) : latest.current.filter((t) => t !== term))

  return (
    <Overlay label="Glossary" onClose={onClose} drawer wide title="Glossary">
      <div className="modal-body gls">
        <div className="gls-row gls-head">
          <span>Term</span>
          <span>Translation</span>
          <span>Note</span>
          <span />
        </div>
        {terms.map((term, i) => (
          <TermRow
            key={`${i}:${term.term}:${term.translation}:${term.note ?? ''}:${term.proposed ? 1 : 0}`}
            term={term}
            onCommit={(next) => replace(term, next)}
            onAccept={() => replace(term, toTerm(fieldsOf(term), false))}
            onRemove={() => replace(term, null)}
          />
        ))}
        {adding && (
          <TermRow
            onCommit={(next) => {
              setAdding(false)
              if (next) apply([...latest.current, next])
            }}
          />
        )}
      </div>

      <div className="modal-foot">
        <span className="dim mono">
          {terms.length} {terms.length === 1 ? 'term' : 'terms'}
          {proposed > 0 ? ` · ${proposed} proposed` : ''}
        </span>
        <button className="btn ghost" autoFocus disabled={adding} onClick={() => setAdding(true)}>
          + Term
        </button>
      </div>
    </Overlay>
  )
}
