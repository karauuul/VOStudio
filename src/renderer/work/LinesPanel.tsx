import { useEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react'
import { GroupedVirtuoso, type GroupedVirtuosoHandle } from 'react-virtuoso'
import type { Cue } from '@shared/domain'
import { hasValidVoicedOutput } from '@shared/approval'
import type { CueGroup } from '@shared/cue-filter'

interface Props {
  cues: Cue[]
  groups: CueGroup[]
  activeCueId?: string
  search: string
  onSearch: (s: string) => void
  onSelect: (cueId: string) => void
  scrollToIndex?: number
  searchRef?: RefObject<HTMLInputElement>
  scope?: { label: string; onExit: () => void }
  exported: ReadonlySet<string>
}

function dotColor(cue: Cue, exported: ReadonlySet<string>): string | undefined {
  if (exported.has(cue.id)) return 'var(--ok)'
  return hasValidVoicedOutput(cue) ? 'var(--warn)' : undefined
}

export function LinesPanel({
  cues,
  groups,
  activeCueId,
  search,
  onSearch,
  onSelect,
  scrollToIndex,
  searchRef,
  scope,
  exported,
}: Props) {
  const vRef = useRef<GroupedVirtuosoHandle>(null)
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

      <GroupedVirtuoso
        ref={vRef}
        className="lines"
        groupCounts={counts}
        groupContent={(i) => <div className="grp">{groups[i]?.name.toUpperCase()}</div>}
        itemContent={(i) => {
          const cue = cues[i]
          if (!cue) return null
          const color = dotColor(cue, exported)
          return (
            <div
              className={'ln' + (cue.id === activeCueId ? ' sel' : '')}
              style={color ? ({ '--c': color } as CSSProperties) : undefined}
              onClick={() => onSelect(cue.id)}
            >
              <div>
                <div className="t">{cue.sourceText || cue.text}</div>
                <div className="id">{cue.fields['EventName'] || cue.key}</div>
              </div>
              {cue.referenceDuration !== undefined && (
                <span className="d">{cue.referenceDuration.toFixed(1)}s</span>
              )}
            </div>
          )
        }}
      />
    </>
  )
}
