import { useEffect, useRef, useState } from 'react'
import type { Character, Cue } from '@shared/domain'
import { approvalState } from '@shared/approval'
import { cueDecision, setFinalEligible, type PreviewSource } from '@shared/workspace-source'

interface Props {
  cue: Cue
  character?: Character
  characters: Character[]
  onCharacter: (characterId: string) => void
  source: PreviewSource
  onApprove: (approved: boolean) => void
  onApproveNext: () => void
  onSetFinal: () => void
}

export function CueHeader({
  cue,
  character,
  characters,
  onCharacter,
  source,
  onApprove,
  onApproveNext,
  onSetFinal,
}: Props) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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

  const decision = cueDecision(cue, source)
  const canSetFinal = setFinalEligible(cue, source)

  useEffect(() => setMenu(false), [cue.id, decision])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menu])

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
        onChange={(e) => {
          e.currentTarget.blur()
          onCharacter(e.target.value)
        }}
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

      <div className="decide" ref={menuRef}>
        {decision === 'set-final' && (
          <button
            className="btn primary"
            onClick={onSetFinal}
            disabled={!canSetFinal}
            title={canSetFinal ? undefined : 'A raw recording cannot be final — convert it first'}
          >
            Set final <kbd>F</kbd>
          </button>
        )}

        {decision === 'approve' && (
          <>
            <button className="btn primary" onClick={onApproveNext}>
              Approve &amp; Next <kbd>Shift+A</kbd>
            </button>
            <button
              className="btn ghost menu-btn"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              ⋯
            </button>
            {menu && (
              <div className="menu-pop" role="menu">
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    onApprove(true)
                  }}
                >
                  Approve <kbd>A</kbd>
                </button>
                {review === 'stale' && (
                  <button
                    className="menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false)
                      onApprove(false)
                    }}
                  >
                    Remove approval
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {decision === 'approved' && (
          <>
            <button className="btn ok" disabled>
              Approved
            </button>
            <button
              className="btn ghost menu-btn"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              ⋯
            </button>
            {menu && (
              <div className="menu-pop" role="menu">
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false)
                    onApprove(false)
                  }}
                >
                  Remove approval
                </button>
              </div>
            )}
          </>
        )}

        {decision === 'none' && (
          <button className="btn ghost" disabled>
            No output
          </button>
        )}
      </div>
    </div>
  )
}
