import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { liveTakes, type Character, type Cue, type Project } from '@shared/domain'
import { compDuration } from '@shared/comp'
import {
  ALL_CHARACTERS,
  FILTERS,
  filterCounts,
  filterCues,
  reviewGeneration,
  reviewLabel,
  type GenerateReview,
} from '@shared/cue-filter'
import { exportName, outputTakeOf } from '@shared/export-plan'
import { outputSource } from '@shared/workspace-source'
import { isCueBusyNow } from './jobs/store'
import { useWire } from './cue/useWire'

export interface GridApi {
  move: (delta: number) => void
  open: () => void
  toggle: () => void
  selectAll: () => void
}

interface Column {
  id: string
  label: string
  width: string
  optional?: true
}

const COLUMNS: Column[] = [
  { id: 'sel', label: '', width: '36px' },
  { id: 'cue', label: 'Cue', width: '190px' },
  { id: 'character', label: 'Character', width: '120px' },
  { id: 'original', label: 'Original', width: 'minmax(160px, 1fr)' },
  { id: 'translation', label: 'Translation', width: 'minmax(160px, 1fr)' },
  { id: 'output', label: 'Output', width: '150px' },
  { id: 'review', label: 'Review', width: '130px' },
  { id: 'reference', label: 'Reference', width: '90px', optional: true },
  { id: 'delta', label: 'Δ', width: '90px', optional: true },
  { id: 'export', label: 'Export name', width: '200px', optional: true },
  { id: 'note', label: 'Note', width: '200px', optional: true },
]

const ROW_H = 56

function outputLabel(cue: Cue): string {
  const source = outputSource(cue)
  if (!source || source.kind === 'none') return 'None'
  if (source.kind === 'comp') return 'Composition'
  const takes = liveTakes(cue)
  const index = takes.findIndex((t) => t.id === source.takeId)
  const take = takes[index]
  if (!take) return 'None'
  return `Take ${index + 1} · ${take.kind === 'recording' ? 'Recording' : take.kind.toUpperCase()}`
}

function outputDuration(cue: Cue): number | undefined {
  const source = outputSource(cue)
  if (!source || source.kind === 'none') return undefined
  if (source.kind === 'comp') return cue.comp ? compDuration(cue.comp) : undefined
  return cue.takes.find((t) => t.id === source.takeId)?.duration
}

function deltaLabel(cue: Cue): string {
  const reference = cue.referenceDuration
  const actual = outputDuration(cue)
  if (reference === undefined || actual === undefined) return 'n/a'
  const d = actual - reference
  return `${d >= 0 ? '+' : ''}${d.toFixed(2)}`
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

interface Props {
  hidden: boolean
  project: Project
  filter: string
  search: string
  characterFilter: string
  onFilter: (id: string) => void
  onSearch: (s: string) => void
  onCharacterFilter: (id: string) => void
  searchRef: RefObject<HTMLInputElement>
  gridRef: MutableRefObject<GridApi | null>
  onOpenCue: (cueId: string) => void
  onReviewSelection: (cueIds: string[]) => void
  onGenerate: (cues: Cue[]) => void
  onAssignCharacter: (cueIds: string[], characterId: string) => void
  onOverlay: (open: boolean) => void
}

export function ProjectTable({
  hidden,
  project,
  filter,
  search,
  characterFilter,
  onFilter,
  onSearch,
  onCharacterFilter,
  searchRef,
  gridRef,
  onOpenCue,
  onReviewSelection,
  onGenerate,
  onAssignCharacter,
  onOverlay,
}: Props) {
  const [sel, setSel] = useState<ReadonlySet<string>>(() => new Set())
  const [focus, setFocus] = useState(0)
  const [optional, setOptional] = useState<ReadonlySet<string>>(() => new Set())
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [review, setReview] = useState<GenerateReview | null>(null)
  const vRef = useRef<VirtuosoHandle>(null)
  const columnsRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)

  const rows = useMemo(
    () => filterCues(project.cues, filter, search, characterFilter),
    [project.cues, filter, search, characterFilter]
  )
  const counts = useMemo(
    () => filterCounts(project.cues, search, characterFilter),
    [project.cues, search, characterFilter]
  )
  const characterById = useMemo(
    () => new Map(project.characters.map((c) => [c.id, c])),
    [project.characters]
  )
  const selected = useMemo(() => rows.filter((c) => sel.has(c.id)), [rows, sel])

  useEffect(() => {
    setSel(new Set())
  }, [filter, search, characterFilter])

  useEffect(() => {
    setFocus((f) => (f < rows.length ? f : Math.max(0, rows.length - 1)))
  }, [rows.length])

  const columns = useMemo(
    () => COLUMNS.filter((c) => !c.optional || optional.has(c.id)),
    [optional]
  )
  const template = columns.map((c) => c.width).join(' ')

  const focusRow = useCallback(
    (index: number) => {
      setFocus(index)
      vRef.current?.scrollIntoView({ index, behavior: 'auto' })
    },
    []
  )

  const api = useMemo<GridApi>(
    () => ({
      move: (delta) => {
        if (rows.length === 0) return
        focusRow(clamp(focus + delta, 0, rows.length - 1))
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

  useEffect(() => {
    if (hidden) setReview(null)
  }, [hidden])

  useEffect(() => {
    if (!columnsOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!columnsRef.current?.contains(e.target as Node)) setColumnsOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [columnsOpen])

  const openReview = useCallback(() => {
    submittingRef.current = false
    setReview(reviewGeneration(selected, project.characters, isCueBusyNow))
    onOverlay(true)
  }, [selected, project.characters, onOverlay])

  const closeReview = useCallback(() => {
    setReview(null)
    onOverlay(false)
  }, [onOverlay])

  const submitReview = useCallback(() => {
    if (submittingRef.current) return
    submittingRef.current = true
    const eligible = review?.eligible ?? []
    closeReview()
    if (eligible.length > 0) onGenerate(eligible)
  }, [review, closeReview, onGenerate])

  const cell = (cue: Cue, column: Column, index: number): ReactNode => {
    switch (column.id) {
      case 'sel':
        return (
          <input
            type="checkbox"
            aria-label="Select cue"
            checked={sel.has(cue.id)}
            onChange={() =>
              setSel((prev) => {
                const next = new Set(prev)
                if (!next.delete(cue.id)) next.add(cue.id)
                return next
              })
            }
            onClick={(e) => {
              e.stopPropagation()
              setFocus(index)
            }}
          />
        )
      case 'cue':
        return (
          <div className="pt-cue">
            <span className="pt-ev">{cue.fields['EventName'] || cue.key}</span>
            <span className="pt-id">{cue.key}</span>
          </div>
        )
      case 'character':
        return <span className="pt-char">{characterById.get(cue.characterId)?.name ?? '—'}</span>
      case 'original':
        return <span className="pt-tx">{cue.sourceText}</span>
      case 'translation':
        return <span className={'pt-tx' + (cue.text.trim() ? '' : ' none')}>{cue.text || '—'}</span>
      case 'output':
        return <span className="pt-out">{outputLabel(cue)}</span>
      case 'review':
        return <span className="pt-review">{reviewLabel(cue)}</span>
      case 'reference':
        return (
          <span className="pt-num">
            {cue.referenceDuration === undefined ? 'n/a' : cue.referenceDuration.toFixed(2)}
          </span>
        )
      case 'delta':
        return <span className="pt-num">{deltaLabel(cue)}</span>
      case 'export': {
        const take = outputTakeOf(cue)
        return <span className="pt-tx one">{take ? exportName(project, cue, take) : '—'}</span>
      }
      case 'note':
        return <span className="pt-tx">{cue.notes || '—'}</span>
      default:
        return null
    }
  }

  const knownFilter = FILTERS.some((f) => f.id === filter)

  return (
    <div className="ptable" style={hidden ? { display: 'none' } : undefined}>
      <div className="pt-filters">
        <input
          type="search"
          className="search pt-search"
          ref={searchRef}
          value={search}
          placeholder="Search — EventName, text, WemId"
          onChange={(e) => onSearch(e.target.value)}
        />
        <select aria-label="Status" value={filter} onChange={(e) => onFilter(e.target.value)}>
          {!knownFilter && <option value={filter}>{filter || 'All'}</option>}
          {FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label} {counts[f.id]}
            </option>
          ))}
        </select>
        <select
          aria-label="Character"
          value={characterFilter}
          onChange={(e) => onCharacterFilter(e.target.value)}
        >
          <option value={ALL_CHARACTERS}>All characters</option>
          {project.characters.map((c: Character) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="menu" ref={columnsRef}>
          <button
            className="btn ghost"
            aria-haspopup="menu"
            aria-expanded={columnsOpen}
            onClick={() => setColumnsOpen((v) => !v)}
          >
            Columns ▾
          </button>
          {columnsOpen && (
            <div className="menu-pop" role="menu">
              {COLUMNS.filter((c) => c.optional).map((c) => (
                <label key={c.id} className="menu-item">
                  <input
                    type="checkbox"
                    checked={optional.has(c.id)}
                    onChange={() =>
                      setOptional((prev) => {
                        const next = new Set(prev)
                        if (!next.delete(c.id)) next.add(c.id)
                        return next
                      })
                    }
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="pt-count">
        <span>
          {rows.length} results
          {selected.length > 0 && <span className="pt-sel-n"> · {selected.length} selected</span>}
        </span>
        {selected.length > 0 && (
          <button className="btn ghost" onClick={() => setSel(new Set())}>
            Clear selection
          </button>
        )}
      </div>

      {selected.length > 0 && (
        <div className="pt-bulk">
          <button
            className="btn primary"
            onClick={() => onReviewSelection(selected.map((c) => c.id))}
          >
            Review selection
          </button>
          <button className="btn" onClick={openReview}>
            Generate selected
          </button>
          <select
            aria-label="Assign character"
            value=""
            onChange={(e) => {
              const characterId = e.target.value
              e.currentTarget.blur()
              if (characterId) onAssignCharacter(selected.map((c) => c.id), characterId)
            }}
          >
            <option value="">Assign character ▾</option>
            {project.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="pt-head" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <span key={c.id}>{c.label}</span>
        ))}
      </div>

      <Virtuoso
        ref={vRef}
        className="pt-scroll"
        data={rows}
        fixedItemHeight={ROW_H}
        computeItemKey={(_i, cue) => cue.id}
        itemContent={(index, cue) => (
          <div
            className={'pt-row' + (index === focus ? ' focus' : '') + (sel.has(cue.id) ? ' on' : '')}
            style={{ gridTemplateColumns: template }}
            role="row"
            tabIndex={-1}
            onClick={() => setFocus(index)}
            onDoubleClick={() => onOpenCue(cue.id)}
          >
            {columns.map((c) => (
              <div key={c.id} className={'pt-cell pt-' + c.id}>
                {cell(cue, c, index)}
              </div>
            ))}
          </div>
        )}
      />

      {review && (
        <div className="modal-bg">
          <div className="modal pt-modal" role="dialog" aria-label="Generate selected">
            <div className="modal-head">Generate selected</div>
            <div className="modal-body">
              <div className="stats-row">
                <div className="stat">
                  Eligible <b>{review.eligible.length}</b>
                </div>
                <div className="stat">
                  Already busy <b>{review.busy}</b>
                </div>
                <div className="stat">
                  Missing text <b>{review.missingText}</b>
                </div>
                <div className="stat">
                  Missing voice <b>{review.missingVoice}</b>
                </div>
                {review.excluded > 0 && (
                  <div className="stat">
                    Excluded <b>{review.excluded}</b>
                  </div>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={closeReview}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={review.eligible.length === 0}
                onClick={submitReview}
              >
                Generate {review.eligible.length}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
