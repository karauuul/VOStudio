import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { Cue, Project } from '@shared/domain'
import { matchesSearch } from '@shared/cue-filter'
import {
  IMPORT_TABS,
  importCounts,
  lineDot,
  matchesImportTab,
  type ImportTab,
  type TableColumn,
  type TableMapping,
} from '@shared/import-table'
import { useContextMenu, type MenuEntry } from '../shell/ContextMenu'
import { useWire } from '../cue/useWire'

export interface GridApi {
  move: (delta: number) => void
  open: () => void
  toggle: () => void
  selectAll: () => void
}

export interface TableSource {
  path: string
  name: string
  headers: string[]
  mapping: TableMapping
  rows: number
  matched: number
  unmatched: number
}

const COLUMNS = '56px 250px 64px minmax(160px, 1fr) minmax(160px, 1fr) 110px'
const ROW_H = 34
const MAP_COLUMNS: TableColumn[] = ['id', 'text', 'translation', 'character']

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const nnn = (n: number): string => n.toLocaleString('en-US')

const Caret = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

interface Props {
  project: Project
  search: string
  onSearch: (s: string) => void
  searchRef: RefObject<HTMLInputElement>
  gridRef: MutableRefObject<GridApi | null>
  table: TableSource | null
  onMapping: (mapping: TableMapping) => void
  onImportText: (replaceTranslations: boolean) => void
  onTranscribe: (cueIds: string[], overwrite: boolean) => void
  onOpenCue: (cueId: string) => void
  menu: (cues: Cue[]) => MenuEntry[]
}

export function LinesTable({
  project,
  search,
  onSearch,
  searchRef,
  gridRef,
  table,
  onMapping,
  onImportText,
  onTranscribe,
  onOpenCue,
  menu,
}: Props) {
  const [tab, setTab] = useState<ImportTab>('all')
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())
  const [focus, setFocus] = useState(0)
  const [pending, setPending] = useState<{ ids: string[]; overwrite: boolean } | null>(null)
  const vRef = useRef<VirtuosoHandle>(null)
  const anchorRef = useRef(0)
  const pop = useContextMenu()

  const scoped = useMemo(
    () => project.cues.filter((c) => matchesSearch(c, search)),
    [project.cues, search]
  )
  const rows = useMemo(() => scoped.filter((c) => matchesImportTab(c, tab)), [scoped, tab])
  const counts = useMemo(() => importCounts(scoped), [scoped])
  const total = useMemo(() => importCounts(project.cues), [project.cues])
  const characterById = useMemo(
    () => new Map(project.characters.map((c) => [c.id, c])),
    [project.characters]
  )

  useEffect(() => {
    setSel(new Set())
    setPending(null)
  }, [tab, search])

  useEffect(() => {
    setFocus((f) => (f < rows.length ? f : Math.max(0, rows.length - 1)))
  }, [rows.length])

  const focusRow = useCallback((index: number) => {
    setFocus(index)
    vRef.current?.scrollIntoView({ index, behavior: 'auto' })
  }, [])

  const api = useMemo<GridApi>(
    () => ({
      move: (delta) => {
        if (rows.length === 0) return
        const next = clamp(focus + delta, 0, rows.length - 1)
        anchorRef.current = next
        focusRow(next)
        setSel(new Set([rows[next].id]))
      },
      open: () => {
        const cue = rows[focus]
        if (cue) onOpenCue(cue.id)
      },
      toggle: () => {
        const cue = rows[focus]
        if (!cue) return
        setSel((prev) => {
          const next = new Set(prev)
          if (!next.delete(cue.id)) next.add(cue.id)
          return next
        })
      },
      selectAll: () => setSel(new Set(rows.map((c) => c.id))),
    }),
    [rows, focus, focusRow, onOpenCue]
  )

  useWire(gridRef, api)

  const selected = useMemo(() => rows.filter((c) => sel.has(c.id)), [rows, sel])

  const click = (index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void => {
    const cue = rows[index]
    if (!cue) return
    setFocus(index)
    setPending(null)
    if (e.shiftKey) {
      const [from, to] = anchorRef.current <= index ? [anchorRef.current, index] : [index, anchorRef.current]
      setSel(new Set(rows.slice(from, to + 1).map((c) => c.id)))
      return
    }
    anchorRef.current = index
    if (e.ctrlKey || e.metaKey) {
      setSel((prev) => {
        const next = new Set(prev)
        if (!next.delete(cue.id)) next.add(cue.id)
        return next
      })
      return
    }
    setSel(new Set([cue.id]))
  }

  const arm = (ids: string[], overwrite: boolean): void => {
    if (ids.length > 0) setPending({ ids, overwrite })
  }

  const missing = (): string[] =>
    scoped.filter((c) => c.referenceAudio && !c.sourceText.trim()).map((c) => c.id)

  const targets = (cues: Cue[], overwrite: boolean): string[] =>
    cues.filter((c) => c.referenceAudio && (overwrite || !c.sourceText.trim())).map((c) => c.id)

  const transcribeClick = (): void => {
    if (pending) {
      const { ids, overwrite } = pending
      setPending(null)
      onTranscribe(ids, overwrite)
      return
    }
    arm(selected.length > 0 ? targets(selected, false) : missing(), false)
  }

  const transcribeMenu: MenuEntry[] = [
    {
      label: 'Selected',
      disabled: targets(selected, false).length === 0,
      onClick: () => arm(targets(selected, false), false),
    },
    { label: 'All without transcript', onClick: () => arm(missing(), false) },
    {
      label: 'Overwrite selected',
      disabled: targets(selected, true).length === 0,
      onClick: () => arm(targets(selected, true), true),
    },
  ]

  const source = project.languages ? project.languages.source.toUpperCase() : ''
  const target = project.languages ? project.languages.target.toUpperCase() : ''

  return (
    <section className="panel">
      <div className="phd">
        Lines <span className="n">{nnn(total.lines)}</span>
        <span className="tabs">
          {IMPORT_TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? 'on' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'all' ? '' : ` ${counts[t.id]}`}
            </button>
          ))}
        </span>
      </div>

      <div className="tbar">
        <span className="search imp-search">
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
        </span>
        <span className="sp" />
        <span className="split">
          <button className="btn ghost" disabled title="Milestone 11">
            Detect lines
          </button>
          <button className="btn ghost caret-btn" disabled aria-label="Detect lines options">
            <Caret />
          </button>
        </span>
        <span className="split">
          <button className="btn ghost" onClick={transcribeClick}>
            {pending ? `Transcribe ${pending.ids.length}` : 'Transcribe'}
          </button>
          <button
            className="btn ghost caret-btn"
            aria-label="Transcribe options"
            onClick={(e) => pop.open(e, transcribeMenu)}
          >
            <Caret />
          </button>
        </span>
        <span className="tbar-sep" />
        <span className="split">
          <button className="btn ghost" onClick={() => onImportText(false)}>
            Import text
          </button>
          <button
            className="btn ghost caret-btn"
            aria-label="Import text options"
            onClick={(e) =>
              pop.open(e, [
                { label: 'Import text', onClick: () => onImportText(false) },
                { label: 'Replace translations', onClick: () => onImportText(true) },
              ])
            }
          >
            <Caret />
          </button>
        </span>
      </div>

      {table && (
        <div className="tbar map">
          <span className="lab">{table.name}</span>
          {MAP_COLUMNS.map((column) => (
            <label key={column} className="imp-map">
              <span>{column}</span>
              <select
                value={table.mapping[column] ?? -1}
                onChange={(e) => {
                  const index = Number(e.target.value)
                  const next = { ...table.mapping }
                  if (index < 0) delete next[column]
                  else next[column] = index
                  onMapping(next)
                }}
              >
                <option value={-1}>—</option>
                {table.headers.map((h, i) => (
                  <option key={`${h}-${i}`} value={i}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      <div className="imp-head" style={{ gridTemplateColumns: COLUMNS }}>
        <span>#</span>
        <span>Source</span>
        <span>Length</span>
        <span>{source ? `Original · ${source}` : 'Original'}</span>
        <span>{target ? `Translation · ${target}` : 'Translation'}</span>
        <span>Character</span>
      </div>

      <Virtuoso
        ref={vRef}
        className="imp-scroll"
        data={rows}
        fixedItemHeight={ROW_H}
        computeItemKey={(_i, cue) => cue.id}
        itemContent={(index, cue) => (
          <div
            className={'imp-row' + (sel.has(cue.id) ? ' on' : '') + (index === focus ? ' focus' : '')}
            style={{ gridTemplateColumns: COLUMNS }}
            role="row"
            tabIndex={-1}
            onClick={(e) => click(index, e)}
            onDoubleClick={() => onOpenCue(cue.id)}
            onContextMenu={(e) => {
              if (!sel.has(cue.id)) click(index, { shiftKey: false, ctrlKey: false, metaKey: false })
              pop.open(e, menu(sel.has(cue.id) && selected.length > 0 ? selected : [cue]))
            }}
          >
            <span className="imp-n">
              <i className={'dot ' + lineDot(cue)} />
              {index + 1}
            </span>
            <span className="imp-id">{cue.fields['EventName'] || cue.key}</span>
            <span className="imp-len">
              {cue.referenceDuration === undefined ? '' : `${cue.referenceDuration.toFixed(2)}s`}
            </span>
            <span className={'imp-tx' + (cue.sourceText.trim() ? '' : ' none')}>
              {cue.sourceText.trim() || 'no transcript'}
            </span>
            <span className={'imp-tx dim' + (cue.text.trim() ? '' : ' none')}>
              {cue.text.trim() || '—'}
            </span>
            <span className="imp-char">{characterById.get(cue.characterId)?.name ?? ''}</span>
          </div>
        )}
      />

      <div className="foot">
        <b>{nnn(total.lines)}</b> lines · <b>{nnn(total.transcribed)}</b> transcribed ·{' '}
        <b>{nnn(total.translated)}</b> translated · <b>{nnn(total.unmatched)}</b> unmatched
        <span className="sp" />
        <button
          className="btn primary"
          disabled={rows.length === 0}
          onClick={() => onOpenCue((selected[0] ?? rows[focus] ?? rows[0]).id)}
        >
          Open in Work
        </button>
      </div>

      {pop.node}
    </section>
  )
}
