import { useMemo, type ReactNode, type RefObject } from 'react'
import type { Cue, Term } from '@shared/domain'
import { highlightRanges, matchTerms } from '@shared/prompt'
import { diffWords } from '@shared/text-diff'

export type CopyKind = 'source' | 'translation' | 'prompt'

interface Props {
  cue: Cue
  terms: Term[]
  textRef: RefObject<HTMLTextAreaElement>
  onText: (text: string) => void
  onCopy: (kind: CopyKind) => void
  onAcceptSuggestion: () => void
  onRejectSuggestion: () => void
  spoken: string
}

function Source({ text, needles }: { text: string; needles: string[] }) {
  const ranges = useMemo(() => highlightRanges(text, needles), [text, needles])
  if (ranges.length === 0) return <>{text || '—'}</>
  const out: ReactNode[] = []
  let at = 0
  for (const r of ranges) {
    if (r.start > at) out.push(text.slice(at, r.start))
    out.push(
      <mark className="term" key={r.start}>
        {text.slice(r.start, r.end)}
      </mark>
    )
    at = r.end
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

function Spoken({ from, to }: { from: string; to: string }) {
  const parts = useMemo(() => diffWords(from, to), [from, to])
  return (
    <div className="spoken">
      <span className="spoken-l">Spoken</span>
      <span className="spoken-tx">
        {parts.map((p, i) =>
          p.changed ? (
            <b key={i} className="spoken-d">
              {p.text}
            </b>
          ) : (
            <span key={i}>{p.text}</span>
          )
        )}
      </span>
    </div>
  )
}

export function TextBlock({
  cue,
  terms,
  textRef,
  onText,
  onCopy,
  onAcceptSuggestion,
  onRejectSuggestion,
  spoken,
}: Props) {
  const matched = useMemo(
    () => matchTerms(terms, cue.sourceText, cue.text),
    [terms, cue.sourceText, cue.text]
  )
  const needles = useMemo(() => matched.map((t) => t.term), [matched])

  return (
    <div className="script">
      <section className="script-cell">
        <div className="script-h">
          <span className="script-l">Original</span>
          <span className="sp" />
          <button className="btn ghost script-cp" onClick={() => onCopy('source')}>
            Copy <kbd>S</kbd>
          </button>
        </div>
        <div className="script-tx">
          <Source text={cue.sourceText} needles={needles} />
        </div>
        {matched.length > 0 && (
          <div className="term-chips">
            {matched.map((t) => (
              <span className="term-chip" key={t.term + t.translation} title={t.note}>
                {t.term} → {t.translation}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="script-cell">
        <div className="script-h">
          <span className="script-l">Translation</span>
          <span className="sp" />
          <button className="btn ghost script-cp" onClick={() => onCopy('translation')}>
            Copy <kbd>T</kbd>
          </button>
          <button className="btn ghost script-cp" onClick={() => onCopy('prompt')}>
            Prompt <kbd>P</kbd>
          </button>
        </div>

        <div className="ukr-wrap">
          <textarea
            ref={textRef}
            className="ukr"
            value={cue.text}
            onChange={(e) => onText(e.target.value)}
            spellCheck={false}
          />
          <span className="cc" title="Characters">
            {cue.text.length}
          </span>
        </div>

        {cue.suggestedText !== undefined && (
          <div className="sugg">
            <div className="sugg-h">
              Suggested
              <span className="sp" />
              <button className="btn ok" onClick={onAcceptSuggestion}>
                Accept <kbd>Y</kbd>
              </button>
              <button className="btn ghost" onClick={onRejectSuggestion}>
                Reject <kbd>N</kbd>
              </button>
            </div>
            <div className="sugg-tx">{cue.suggestedText}</div>
          </div>
        )}

        {!!spoken && spoken !== cue.text && <Spoken from={cue.text} to={spoken} />}
      </section>
    </div>
  )
}
