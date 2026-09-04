import { useEffect, useMemo, useRef } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Character, Cue } from '@shared/domain'
import { approvalState, hasValidVoicedOutput } from '@shared/approval'

export const DEFAULT_FILTER = 'work'
export const ALL_CHARACTERS = 'all'
export const PRIMARY_CHARACTER = 'ada'

export const FILTERS: { id: string; label: string }[] = [
  { id: 'work', label: 'Active' },
  { id: 'notgen', label: 'Not voiced' },
  { id: 'review', label: 'Review' },
  { id: 'gen', label: 'Voiced' },
  { id: 'appr', label: 'Approved' },
  { id: 'sugg', label: 'Suggestions' },
  { id: 'excluded', label: 'Excluded' },
  { id: 'all', label: 'All' },
]

export function matchesFilter(cue: Cue, filter: string): boolean {
  switch (filter) {
    case 'work':
      return cue.status !== 'excluded'
    case 'translated':
      return cue.status === 'translated'
    case 'gen':
      return hasValidVoicedOutput(cue)
    case 'notgen':
      return !hasValidVoicedOutput(cue) && cue.status !== 'excluded'
    case 'review':
      return hasValidVoicedOutput(cue) && cue.status !== 'excluded' && approvalState(cue) !== 'approved'
    case 'appr':
      return cue.status !== 'excluded' && approvalState(cue) === 'approved'
    case 'sugg':
      return cue.suggestedText !== undefined
    case 'excluded':
      return cue.status === 'excluded'
    default:
      return true
  }
}

export function matchesCharacter(cue: Cue, characterId: string): boolean {
  return characterId === ALL_CHARACTERS || cue.characterId === characterId
}

export function matchesSearch(cue: Cue, search: string): boolean {
  if (!search) return true
  const q = search.toLowerCase()
  return (
    (cue.fields['EventName'] ?? '').toLowerCase().includes(q) ||
    cue.text.toLowerCase().includes(q) ||
    cue.sourceText.toLowerCase().includes(q) ||
    cue.key.toLowerCase().includes(q)
  )
}

export function filterCues(
  cues: Cue[],
  filter: string,
  search: string,
  characterId: string = ALL_CHARACTERS
): Cue[] {
  return cues.filter(
    (c) => matchesFilter(c, filter) && matchesCharacter(c, characterId) && matchesSearch(c, search)
  )
}

export function dotClass(cue: Cue): string {
  if (cue.status === 'excluded') return 'excluded'
  const review = approvalState(cue)
  if (review === 'approved') return 'approved'
  if (review === 'stale') return 'stale'
  if (hasValidVoicedOutput(cue)) return 'filled'
  if (cue.status === 'translated' || cue.text.trim()) return 'translated'
  return 'empty'
}

interface Props {
  cues: Cue[]
  allCues: Cue[]
  activeCueId?: string
  filter: string
  search: string
  characters: Character[]
  characterFilter: string
  onFilter: (f: string) => void
  onSearch: (s: string) => void
  onCharacterFilter: (id: string) => void
  onSelect: (cueId: string) => void
  scrollToIndex?: number
}

export function CueList({
  cues,
  allCues,
  activeCueId,
  filter,
  search,
  characters,
  characterFilter,
  onFilter,
  onSearch,
  onCharacterFilter,
  onSelect,
  scrollToIndex,
}: Props) {
  const vRef = useRef<VirtuosoHandle>(null)
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters])
  const counts = useMemo(() => {
    const inScope = allCues.filter((c) => matchesCharacter(c, characterFilter))
    return Object.fromEntries(
      FILTERS.map((f) => [f.id, inScope.filter((c) => matchesFilter(c, f.id)).length])
    )
  }, [allCues, characterFilter])

  useEffect(() => {
    if (scrollToIndex === undefined || scrollToIndex < 0) return
    vRef.current?.scrollIntoView({ index: scrollToIndex, behavior: 'auto' })
  }, [scrollToIndex])

  return (
    <div className="sidebar">
      <div className="side-head">
        <input
          type="search"
          className="search"
          value={search}
          placeholder="Search — EventName, text, WemId"
          onChange={(e) => onSearch(e.target.value)}
        />
        <div className="seg" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={filter === f.id ? 'on' : ''}
              onClick={() => onFilter(f.id)}
            >
              {f.label}
              <span className="seg-n">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        {characters.length > 1 && (
          <div className="seg" role="tablist">
            <button
              role="tab"
              aria-selected={characterFilter === ALL_CHARACTERS}
              className={characterFilter === ALL_CHARACTERS ? 'on' : ''}
              onClick={() => onCharacterFilter(ALL_CHARACTERS)}
            >
              All characters
            </button>
            {characters.map((ch) => (
              <button
                key={ch.id}
                role="tab"
                aria-selected={characterFilter === ch.id}
                className={characterFilter === ch.id ? 'on' : ''}
                onClick={() => onCharacterFilter(ch.id)}
              >
                {ch.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="side-count">
        {cues.length} / {allCues.length}
      </div>

      <Virtuoso
        ref={vRef}
        className="cue-scroll"
        data={cues}
        itemContent={(_i, cue) => {
          const preview = (cue.text || cue.sourceText || '').trim()
          const cls = dotClass(cue)
          const character = byId.get(cue.characterId)
          return (
            <div
              className={'cue-row' + (cue.id === activeCueId ? ' active' : '')}
              onClick={() => onSelect(cue.id)}
            >
              <span className={'dot ' + cls} title={approvalState(cue)}>
                {cls === 'approved' ? '✓' : ''}
              </span>
              {character && character.id !== PRIMARY_CHARACTER && (
                <span
                  className="dot char"
                  style={{ background: character.color }}
                  title={character.name}
                />
              )}
              <div className="cue-main">
                <div className="cue-ev">{cue.fields['EventName'] || cue.key}</div>
                <div className={'cue-tx' + (preview ? '' : ' none')}>{preview || 'no text'}</div>
              </div>
              {cue.suggestedText !== undefined && (
                <span className="sugg-dot" title="Has a translation suggestion" />
              )}
              {cue.referenceDuration !== undefined && (
                <span className="cue-dur">{cue.referenceDuration.toFixed(1)}s</span>
              )}
            </div>
          )
        }}
      />
    </div>
  )
}
