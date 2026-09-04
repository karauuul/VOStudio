import { useMemo, type ReactNode, type RefObject } from 'react'
import type { Cue, Term } from '@shared/domain'
import { highlightRanges, matchTerms } from '@shared/prompt'

export type CopyKind = 'source' | 'translation' | 'prompt'

interface Props {
  cue: Cue
  terms: Term[]
  textRef: RefObject<HTMLTextAreaElement>
  onText: (text: string) => void
  onCopy: (kind: CopyKind) => void
  onAcceptSuggestion: () => void
  onRejectSuggestion: () => void
  preview: string
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

export function TextBlock({
  cue,
  terms,
  textRef,
  onText,
  onCopy,
  onAcceptSuggestion,
  onRejectSuggestion,
  preview,
}: Props) {
  const matched = useMemo(
    () => matchTerms(terms, cue.sourceText, cue.text),
    [terms, cue.sourceText, cue.text]
  )
  const needles = useMemo(() => matched.map((t) => t.term), [matched])

  return (
    <div className="text-block">
      <div className="copy-bar">
        <span className="sp" />
        <button className="btn ghost" onClick={() => onCopy('source')}>
          Copy source <kbd>S</kbd>
        </button>
        <button className="btn ghost" onClick={() => onCopy('translation')}>
          Copy translation <kbd>T</kbd>
        </button>
        <button className="btn ghost" onClick={() => onCopy('prompt')}>
          Copy as prompt <kbd>P</kbd>
        </button>
      </div>

      <div className="eng">
        <Source text={cue.sourceText} needles={needles} />
      </div>

      <div className="ukr-wrap">
        <textarea
          ref={textRef}
          className="ukr"
          value={cue.text}
          onChange={(e) => onText(e.target.value)}
          placeholder="Ukrainian translation…"
          spellCheck={false}
        />
        <span className="cc" title="Characters">
          {cue.text.length}
        </span>
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

      {cue.suggestedText !== undefined && (
        <div className="sugg">
          <div className="sugg-h">
            Suggested translation
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

      {preview && preview !== cue.text && (
        <div className="rules-prev" title="Text after pronunciation rules — this is what gets voiced">
          {preview}
        </div>
      )}
    </div>
  )
}
