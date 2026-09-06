import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { Cue } from '@shared/domain'
import { libraryGroups, projectLibrary, type LibraryGroup, type LibraryRow } from '@shared/library'
import { fmt, getPeaks, sourceColor, Wave, type Peaks } from '../Waveform'
import { DRAG_TYPE } from './TimelinePanel'
import { useContextMenu, type MenuEntry } from '../shell/ContextMenu'

export interface LibraryPanelProps {
  cue: Cue | null
  cues: Cue[]
  selectedTakeId: string | null
  clipTakeId: string | null
  onSelect: (row: LibraryRow) => void
  onInsert: (row: LibraryRow) => void
  menu?: (row: LibraryRow) => MenuEntry[]
}

type Tab = 'line' | 'project'

export function LibraryPanel({
  cue,
  cues,
  selectedTakeId,
  clipTakeId,
  onSelect,
  onInsert,
  menu,
}: LibraryPanelProps) {
  const [tab, setTab] = useState<Tab>('line')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [peaks, setPeaks] = useState<Record<string, Peaks>>({})
  const pop = useContextMenu()
  const scrollRef = useRef<HTMLDivElement>(null)

  const groups: LibraryGroup[] = cue
    ? tab === 'line'
      ? libraryGroups(cue, { cues })
      : projectLibrary(cue, { cues })
    : []

  const q = query.trim().toLowerCase()
  const shown = q ? groups.filter((g) => g.text.toLowerCase().includes(q)) : groups

  const paths = shown.flatMap((g) => g.rows.map((r) => r.take.file.relPath))
  const pathKey = paths.join('\n')

  useEffect(() => {
    let alive = true
    for (const path of new Set(pathKey ? pathKey.split('\n') : [])) {
      void getPeaks(path)
        .then((p) => {
          if (alive) setPeaks((m) => (m[path] ? m : { ...m, [path]: p }))
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [pathKey])

  const highlight = clipTakeId && clipTakeId !== selectedTakeId ? clipTakeId : null
  useEffect(() => {
    if (!highlight) return
    scrollRef.current
      ?.querySelector(`[data-take="${CSS.escape(highlight)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
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
      </div>

      <div className="lib-scroll" ref={scrollRef}>
        {shown.map((group, gi) => (
          <div key={`${group.lineId ?? ''}:${gi}:${group.text}`}>
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
            {[...group.rows].reverse().map((row) => (
              <Row
                key={row.take.id}
                row={row}
                peaks={peaks[row.take.file.relPath] ?? null}
                selected={row.take.id === selectedTakeId}
                highlighted={row.take.id === highlight}
                onSelect={onSelect}
                onInsert={onInsert}
                onMenu={(row, e) => menu && pop.open(e, menu(row))}
              />
            ))}
          </div>
        ))}
      </div>

      {pop.node}
    </section>
  )
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
  peaks,
  selected,
  highlighted,
  onSelect,
  onInsert,
  onMenu,
}: {
  row: LibraryRow
  peaks: Peaks | null
  selected: boolean
  highlighted: boolean
  onSelect: (row: LibraryRow) => void
  onInsert: (row: LibraryRow) => void
  onMenu: (row: LibraryRow, e: ReactMouseEvent) => void
}) {
  const cls =
    'it' + (row.used ? ' used' : '') + (selected ? ' sel' : '') + (highlighted ? ' hi' : '')
  return (
    <div
      className={cls}
      data-take={row.take.id}
      tabIndex={-1}
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
