import { useEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react'
import { GroupedVirtuoso, type GroupedVirtuosoHandle } from 'react-virtuoso'
import type { Character, Cue } from '@shared/domain'
import { lineDotColor } from '@shared/approval'
import type { TakeLookup } from '@shared/library'
import { DEFAULT_FILTER, hasPendingProposal, REVIEW_FILTER, type CueGroup } from '@shared/cue-filter'
import { regionTimecode } from '@shared/sources'
import { useContextMenu, type MenuEntry } from '../shell/ContextMenu'

interface Props {
  cues: Cue[]
  characters: Pick<Character, 'id' | 'name'>[]
  groups: CueGroup[]
  activeCueId?: string
  activeText?: string
  search: string
  onSearch: (s: string) => void
  onSelect: (cueId: string) => void
  scrollToIndex?: number
  searchRef?: RefObject<HTMLInputElement>
  scope?: { label: string; onExit: () => void }
  exported: ReadonlySet<string>
  lookup?: TakeLookup
  menu?: (cue: Cue) => MenuEntry[]
  filter: string
  review: number
  onFilter: (id: string) => void
}

export function LinesPanel({
  cues,
  characters,
  groups,
  activeCueId,
  activeText,
  search,
  onSearch,
  onSelect,
  scrollToIndex,
  searchRef,
  scope,
  exported,
  lookup,
  menu,
  filter,
  review,
  onFilter,
}: Props) {
  const vRef = useRef<GroupedVirtuosoHandle>(null)
  const pop = useContextMenu()
  const names = useMemo(() => new Map(characters.map((c) => [c.id, c.name])), [characters])
  const counts = useMemo(() => groups.map((g) => g.count), [groups])

  const absolute = useMemo(() => {
    if (scrollToIndex === undefined || scrollToIndex < 0) return -1
    let seen = 0
    for (let g = 0; g < counts.length; g++) {
      if (scrollToIndex < seen + counts[g]) return scrollToIndex + g + 1
      seen += counts[g]
    }
    return -1
  }, [scrollToIndex, counts])

  useEffect(() => {
    if (absolute < 0) return
    vRef.current?.scrollIntoView({ index: absolute, behavior: 'auto' })
  }, [absolute])

  return (
    <>
      {scope ? (
        <div className="scope">
          <span>{scope.label}</span>
          <button className="ico sm" onClick={scope.onExit} title="Exit selection">
            ✕
          </button>
        </div>
      ) : null}

      <div className="lines-q">
        <div className="search">
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8.5 8.5l3.5 3.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <input
            type="search"
            ref={searchRef}
            value={search}
            placeholder="Search"
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <span className="seg" role="group">
          {[
            { id: DEFAULT_FILTER, label: 'All' },
            { id: REVIEW_FILTER, label: `Review ${review}` },
          ].map((f) => (
            <button key={f.id} className={filter === f.id ? 'on' : ''} aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </span>
      </div>

      <GroupedVirtuoso
        ref={vRef}
        className="lines"
        groupCounts={counts}
        groupContent={(i) => (
          <div className="grp">
            <span>{groups[i]?.name.toUpperCase()}</span>
            <span>{groups[i]?.count}</span>
          </div>
        )}
        itemContent={(i) => {
          const cue = cues[i]
          if (!cue) return null
          const color = lineDotColor(cue, exported.has(cue.id), lookup)
          return (
            <div
              className={'ln' + (cue.id === activeCueId ? ' sel' : '') + (hasPendingProposal(cue) ? ' pend' : '')}
              style={color ? ({ '--c': color } as CSSProperties) : undefined}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(cue.id)}
              onContextMenu={(e) => {
                onSelect(cue.id)
                if (menu) pop.open(e, menu(cue))
              }}
              onKeyDown={(e) => {
                if (e.code === 'Enter' || e.code === 'NumpadEnter') {
                  e.preventDefault()
                  onSelect(cue.id)
                  return
                }
                if (e.code !== 'ArrowDown' && e.code !== 'ArrowUp') return
                e.preventDefault()
                const next = cues[i + (e.code === 'ArrowDown' ? 1 : -1)]
                if (next) onSelect(next.id)
              }}
            >
              <div>
                <div className="t">{cue.sourceText || (cue.id === activeCueId ? (activeText ?? cue.text) : cue.text)}</div>
                <div className="id">
                  {cue.region
                    ? `${names.get(cue.characterId) ?? 'no character'} · ${regionTimecode(cue.region.in)}`
                    : cue.fields['EventName'] || cue.key}
                </div>
              </div>
              {cue.referenceDuration !== undefined && (
                <span className="d">{cue.referenceDuration.toFixed(1)}s</span>
              )}
            </div>
          )
        }}
      />

      {pop.node}
    </>
  )
}
