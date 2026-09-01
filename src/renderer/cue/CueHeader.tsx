import type { Character, Cue } from '@shared/domain'
import { approvalState } from '@shared/approval'

export function CueHeader({ cue, character }: { cue: Cue; character?: Character }) {
  const review = approvalState(cue)
  const label = cue.status === 'excluded'
    ? 'Excluded'
    : review === 'approved'
    ? 'Approved'
    : review === 'stale'
      ? 'Stale approval'
      : review === 'needs-review'
        ? 'Needs review'
        : cue.text.trim() ? 'Needs voice' : 'Empty'
  return (
    <div className="cue-head">
      <span className="ed-title" title={cue.fields['EventName'] || cue.key}>
        {cue.fields['EventName'] || cue.key}
      </span>
      <span className="ed-wem">WemId {cue.key}</span>
      {character && (
        <span className="badge char" style={{ color: character.color, borderColor: character.color }}>
          <span className="char-dot" style={{ background: character.color }} />
          {character.name}
        </span>
      )}
      <span className="sp" />
      <span className={'badge st-' + review}>{label}</span>
    </div>
  )
}
