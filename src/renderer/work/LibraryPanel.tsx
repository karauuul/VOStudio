import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Cue } from '@shared/domain'
import { libraryGroups, projectLibrary, type LibraryGroup, type LibraryRow } from '@shared/library'
import { cachedPeaks, fmt, getPeaks, sourceColor, Wave, type Peaks } from '../Waveform'
import { DRAG_TYPE } from './TimelinePanel'
import { useContextMenu, type MenuEntry } from '../shell/ContextMenu'

export interface LibraryPanelProps {
  cue: Cue | null
  cues: Cue[]
  selectedTakeId: string | null
  clipTakeId: string | null
  onSelect: (row: LibraryRow) => void
  onInsert: (row: LibraryRow) => void
  onImport?: () => void
  menu?: (row: LibraryRow) => MenuEntry[]
}

type Tab = 'line' | 'project'

type Item =
  | { kind: 'group'; key: string; group: LibraryGroup }
  | { kind: 'row'; key: string; row: LibraryRow }

export function LibraryPanel({
  cue,
  cues,
  selectedTakeId,
  clipTakeId,
  onSelect,
  onInsert,
  onImport,
  menu,
}: LibraryPanelProps) {
  const [tab, setTab] = useState<Tab>('line')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const pop = useContextMenu()
  const listRef = useRef<VirtuosoHandle>(null)

  const groups = useMemo<LibraryGroup[]>(
    () =>
      cue ? (tab === 'line' ? libraryGroups(cue, { cues }) : projectLibrary(cue, { cues })) : [],
    [cue, cues, tab]
  )

  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out: Item[] = []
    groups.forEach((group, gi) => {
      if (q && !group.text.toLowerCase().includes(q)) return
      out.push({ kind: 'group', key: `${group.lineId ?? ''}:${gi}:${group.text}`, group })
      for (let i = group.rows.length - 1; i >= 0; i--) {
        const row = group.rows[i]
        out.push({ kind: 'row', key: row.take.id, row })
      }
    })
    return out
  }, [groups, query])
  const itemsRef = useRef(items)
  itemsRef.current = items

  const highlight = clipTakeId && clipTakeId !== selectedTakeId ? clipTakeId : null
  useEffect(() => {
    if (!highlight) return
    const index = itemsRef.current.findIndex((it) => it.kind === 'row' && it.row.take.id === highlight)
    if (index >= 0) listRef.current?.scrollIntoView({ index, behavior: 'auto' })
  }, [highlight, tab])

  return (
    <section className="panel lib">
      <div className="phd">
        Library
        <span className="tabs">
          <button className={tab === 'line' ? 'on' : ''} onClick={() => setTab('line')}>
            This line
          </button>
          <button className={tab === 'project' ? 'on' : ''} onClick={() => setTab('project')}>
            Project
          </button>
        </span>
        {searching ? (
          <input
            className="lib-q"
            type="search"
            autoFocus
            value={query}
            placeholder="Search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            onBlur={() => {
              if (!query) setSearching(false)
            }}
          />
        ) : (
          <button className="ico sm" aria-label="Search the library" onClick={() => setSearching(true)}>
            <svg width="13" height="13" viewBox="0 0 13 13">
              <circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="M8.5 8.5l3.5 3.5" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        )}
        <button
          className="ico sm"
          data-hint="Import audio"
          aria-label="Import audio"
          disabled={!cue}
          onClick={onImport}
        >
          <svg width="13" height="13" viewBox="0 0 13 13">
            <path d="M6.5 1.5v7M3.5 5.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M1.5 9v2.5h10V9" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      </div>

      <Virtuoso
        ref={listRef}
        className="lib-scroll"
        data={items}
        computeItemKey={(_, item) => item.key}
        itemContent={(_, item) =>
          item.kind === 'group' ? (
            <GroupHeader group={item.group} />
          ) : (
            <Row
              row={item.row}
              selected={item.row.take.id === selectedTakeId}
              highlighted={item.row.take.id === highlight}
              onSelect={onSelect}
              onInsert={onInsert}
              onMenu={(row, e) => menu && pop.open(e, menu(row))}
            />
          )
        }
      />

      {pop.node}
    </section>
  )
}

function GroupHeader({ group }: { group: LibraryGroup }) {
  return (
    <div className="grp">
      <span className="lab">{group.text}</span>
      {group.pinned && (
        <span className="pin">
          <PinIcon />
          {group.useCount ?? 0}&times;
        </span>
      )}
      {group.lineId && <span className="lid">{group.lineId}</span>}
    </div>
  )
}

function usePeaks(path: string): Peaks | null {
  const [peaks, setPeaks] = useState(() => cachedPeaks(path))
  useEffect(() => {
    const ctl = new AbortController()
    getPeaks(path, { background: true, signal: ctl.signal }).then(setPeaks, () => {})
    return () => ctl.abort()
  }, [path])
  return peaks
}

function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
      <path d="M6.5 1l3.5 3.5-2 .5-2 2 .5 3L4 7.5 1.5 10 1 9.5 3.5 7 1 4.5l3-.5 2-2z" fill="currentColor" />
    </svg>
  )
}

function Row({
  row,
  selected,
  highlighted,
  onSelect,
  onInsert,
  onMenu,
}: {
  row: LibraryRow
  selected: boolean
  highlighted: boolean
  onSelect: (row: LibraryRow) => void
  onInsert: (row: LibraryRow) => void
  onMenu: (row: LibraryRow, e: ReactMouseEvent) => void
}) {
  const peaks = usePeaks(row.take.file.relPath)
  const cls =
    'it' + (row.used ? ' used' : '') + (selected ? ' sel' : '') + (highlighted ? ' hi' : '')
  return (
    <div
      className={cls}
      data-take={row.take.id}
      onContextMenu={(e) => {
        if (!selected) onSelect(row)
        onMenu(row, e)
      }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy'
        e.dataTransfer.setData(DRAG_TYPE, row.take.id)
        e.dataTransfer.setDragImage(e.currentTarget, 24, 20)
      }}
      onClick={() => onSelect(row)}
      onDoubleClick={() => onInsert(row)}
    >
      <span className="v">{row.label}</span>
      <div>
        <Wave
          peaks={peaks}
          from={0}
          to={peaks?.duration || row.take.duration || 1}
          color={sourceColor(row.take.kind)}
        />
      </div>
      <span className="d">{fmt(peaks?.duration || row.take.duration)}</span>
      <button
        className="ico sm"
        aria-label="Source menu"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (!selected) onSelect(row)
          onMenu(row, e)
        }}
      >
        &#8942;
      </button>
    </div>
  )
}
