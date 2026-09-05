import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { compDuration, isEmptyComp } from '@shared/comp'
import { liveTakes, MAX_STS_SECONDS, type Cue, type Take } from '@shared/domain'
import { approvalState } from '@shared/approval'
import { outputSource, sameSource, type PreviewSource } from '@shared/workspace-source'
import { fmt } from '../Waveform'
import { credits } from './shared'
import { takeDrag } from './take-drag'

const DRAG_SLOP = 5

const STATE_LABEL = {
  approved: 'Approved',
  stale: 'Stale approval',
  'needs-review': 'Needs review',
  unvoiced: 'Needs review',
}

interface Entry {
  source: PreviewSource
  label: string
  kind: string
  duration: number
  final: boolean
  take?: Take
}

interface Props {
  cue: Cue
  source: PreviewSource
  label?: string
  variant?: 'insert'
  onInsert?: (take: Take) => void
  onSelect: (source: PreviewSource) => void
  onGenerate: () => void
  onDetails: () => void
  onDelete: (takeId: string) => void
  onReconvert: (take: Take) => void
  converting: boolean
  genDisabled: boolean
  genTitle: string
  noVoiceReason: string
}

function buildEntries(cue: Cue): Entry[] {
  const takes = liveTakes(cue)
  const output = outputSource(cue)
  const entries: Entry[] = takes.map((take, i) => ({
    source: { kind: 'take', takeId: take.id },
    label: `Take ${i + 1}`,
    kind: take.kind === 'recording' ? 'Recording' : take.kind.toUpperCase(),
    duration: take.duration,
    final: !!output && output.kind === 'take' && output.takeId === take.id,
    take,
  }))
  const comp = cue.comp
  if (comp && !isEmptyComp(comp)) {
    entries.push({
      source: { kind: 'comp' },
      label: 'Composition',
      kind: '',
      duration: compDuration(comp),
      final: output?.kind === 'comp',
    })
  }
  return entries
}

function sourceLabel(entries: Entry[], source: PreviewSource): string {
  const entry = entries.find((e) => sameSource(e.source, source))
  if (!entry) return 'No take'
  return [entry.label, entry.kind, entry.duration > 0 ? fmt(entry.duration) : '']
    .filter(Boolean)
    .join(' · ')
}

export function activeSourceLabel(cue: Cue, source: PreviewSource): string {
  return sourceLabel(buildEntries(cue), source)
}

function finalLabel(cue: Cue, entries: Entry[]): string {
  const output = outputSource(cue)
  if (!output) return 'No output'
  const entry = entries.find((e) => sameSource(e.source, output))
  return `Final: ${entry?.label ?? 'Output'} · ${STATE_LABEL[approvalState(cue)]}`
}

export function TakeSourceMenu({
  cue,
  source,
  label,
  variant,
  onInsert,
  onSelect,
  onGenerate,
  onDetails,
  onDelete,
  onReconvert,
  converting,
  genDisabled,
  genTitle,
  noVoiceReason,
}: Props) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState({ left: 0, top: 0 })
  const [cursor, setCursor] = useState(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const dragged = useRef(false)

  const insert = variant === 'insert'
  const all = buildEntries(cue)
  const entries = insert ? all.filter((e) => !!e.take && e.take.kind !== 'recording') : all
  const current = insert ? -1 : entries.findIndex((e) => sameSource(e.source, source))
  const selected = entries[current]
  const raw = selected?.take?.kind === 'recording' ? selected.take : null

  const close = useCallback(() => {
    setOpen(false)
    dragged.current = false
    takeDrag.cancel()
    btnRef.current?.focus()
  }, [])

  useEffect(() => setOpen(false), [cue.id])

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = btnRef.current?.getBoundingClientRect()
      if (r) setBox({ left: r.left, top: r.bottom + 4 })
    }
    place()
    const onDown = (e: MouseEvent): void => {
      if (popRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
      takeDrag.cancel()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (open) popRef.current?.focus()
  }, [open])

  const startDrag = useCallback(
    (e: ReactPointerEvent, entry: Entry): void => {
      if (e.button !== 0 || !entry.take || entry.take.kind === 'recording' || !(entry.duration > 0)) return
      const take = entry.take
      const el = e.currentTarget as HTMLElement
      const x0 = e.clientX
      const y0 = e.clientY
      let armed = false
      dragged.current = false

      const move = (ev: PointerEvent): void => {
        if (!armed) {
          if (Math.abs(ev.clientX - x0) < DRAG_SLOP && Math.abs(ev.clientY - y0) < DRAG_SLOP) return
          armed = true
          dragged.current = true
          takeDrag.start({
            takeId: take.id,
            duration: entry.duration,
            label: entry.label,
            x: ev.clientX,
            y: ev.clientY,
          })
        } else {
          takeDrag.move(ev.clientX, ev.clientY)
        }
      }
      const stop = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', cancel)
      }
      const up = (ev: PointerEvent): void => {
        stop()
        if (!armed) return
        takeDrag.drop(ev.clientX, ev.clientY)
        close()
      }
      const cancel = (): void => {
        stop()
        takeDrag.cancel()
      }
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', cancel)
    },
    [close]
  )

  const pick = useCallback(
    (entry: Entry): void => {
      if (insert) {
        if (entry.take) onInsert?.(entry.take)
      } else {
        onSelect(entry.source)
      }
      close()
    },
    [insert, onInsert, onSelect, close]
  )

  const remove = useCallback(
    (entry: Entry | undefined): void => {
      if (entry?.take && !entry.final) onDelete(entry.take.id)
    },
    [onDelete]
  )

  const onKey = useCallback(
    (e: ReactKeyboardEvent): void => {
      if (e.code === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        close()
        return
      }
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        e.stopPropagation()
        e.preventDefault()
        if (entries.length === 0) return
        const d = e.code === 'ArrowDown' ? 1 : -1
        setCursor((c) => (c + d + entries.length) % entries.length)
        return
      }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.stopPropagation()
        if (e.target instanceof HTMLElement && e.target.closest('button')) return
        e.preventDefault()
        const entry = entries[cursor]
        if (entry) pick(entry)
        return
      }
      if (e.code === 'Delete') {
        e.stopPropagation()
        e.preventDefault()
        if (!insert) remove(entries[cursor])
      }
    },
    [entries, cursor, pick, close, remove, insert]
  )

  return (
    <div className={insert ? 'tlb-menu' : 'tl-src'}>
      {!insert && <span className="tl-src-l">ACTIVE SOURCE</span>}
      <button
        ref={btnRef}
        className={insert ? 'tlb-btn' : 'src-btn'}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={insert && entries.length === 0}
        onMouseDown={insert ? (e) => e.preventDefault() : undefined}
        onClick={() => {
          setCursor(current < 0 ? 0 : current)
          setOpen((v) => !v)
        }}
        onKeyDown={(e) => {
          if (insert || e.code !== 'Delete') return
          e.stopPropagation()
          e.preventDefault()
          remove(selected)
        }}
      >
        {insert ? <span className="tlb-l">Insert</span> : label ?? sourceLabel(entries, source)}
        <span className="src-caret">▾</span>
      </button>
      {!insert && <span className="tl-src-final">{finalLabel(cue, entries)}</span>}

      {open && (
        <div
          ref={popRef}
          className="src-pop"
          role="menu"
          tabIndex={-1}
          style={{ left: box.left, top: box.top }}
          onKeyDown={onKey}
        >
          {entries.map((entry, i) => (
            <div
              key={entry.label}
              role="menuitemradio"
              aria-checked={i === current}
              className={
                'src-row' + (i === current ? ' on' : '') + (i === cursor ? ' cur' : '')
              }
              onPointerDown={(e) => startDrag(e, entry)}
              onMouseEnter={() => setCursor(i)}
              onClick={() => {
                if (dragged.current) {
                  dragged.current = false
                  return
                }
                pick(entry)
              }}
            >
              <span className="src-row-n">{entry.label}</span>
              <span className="src-row-k">{entry.kind}</span>
              <span className="src-row-d">{entry.duration > 0 ? fmt(entry.duration) : ''}</span>
              <span className="src-row-f">{entry.final ? '★ Final' : ''}</span>
            </div>
          ))}
          {entries.length === 0 && <div className="src-none">No take</div>}

          {!insert && (
            <>
          <div className="src-sep" />
          <button
            className="menu-item"
            role="menuitem"
            disabled={genDisabled}
            title={genTitle}
            onClick={() => {
              close()
              onGenerate()
            }}
          >
            New take
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!selected}
            onClick={() => {
              close()
              onDetails()
            }}
          >
            Details
          </button>
          {raw && (
            <button
              className="menu-item"
              role="menuitem"
              disabled={converting || !!noVoiceReason || raw.duration > MAX_STS_SECONDS}
              title={
                noVoiceReason ||
                (raw.duration > MAX_STS_SECONDS
                  ? 'Recording is longer than 5 min — STS will reject it'
                  : `≈${credits(raw.duration)} credits`)
              }
              onClick={() => {
                close()
                onReconvert(raw)
              }}
            >
              Convert
            </button>
          )}
          <button
            className="menu-item danger"
            role="menuitem"
            disabled={!selected?.take || selected.final}
            title={selected?.final ? 'The final take cannot be deleted' : undefined}
            onClick={() => {
              const entry = selected
              close()
              remove(entry)
            }}
          >
            Delete
          </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
