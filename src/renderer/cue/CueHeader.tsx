import type { Character, Cue } from '@shared/domain'
import { approvalState } from '@shared/approval'

interface Props {
  cue: Cue
  character?: Character
  characters: Character[]
  onCharacter: (characterId: string) => void
}

export function CueHeader({ cue, character, characters, onCharacter }: Props) {
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
      {character && <span className="char-dot" style={{ background: character.color }} />}
      <select
        aria-label="Character"
        value={cue.characterId}
        onChange={(e) => onCharacter(e.target.value)}
        style={character ? { color: character.color } : undefined}
      >
        <option value="">Unassigned</option>
        {cue.characterId && !character && <option value={cue.characterId}>{cue.characterId}</option>}
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span className="sp" />
      <span className={'badge st-' + review}>{label}</span>
    </div>
  )
}
