import { type RefObject } from 'react'
import type { Cue } from '@shared/domain'

interface Props {
  cue: Cue
  textRef: RefObject<HTMLTextAreaElement>
  onText: (text: string) => void
  onAcceptSuggestion: () => void
  onRejectSuggestion: () => void
  preview: string
}

export function TextBlock({
  cue,
  textRef,
  onText,
  onAcceptSuggestion,
  onRejectSuggestion,
  preview,
}: Props) {
  return (
    <div className="text-block">
      <div className="eng">{cue.sourceText || '—'}</div>

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
