import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { compDuration } from '@shared/comp'
import { liveTakes, MAX_STS_SECONDS, type Cue, type Take } from '@shared/domain'
import type { PreviewSource } from '@shared/workspace-source'
import { reportTakeDuration } from '../audio/duration-backfill'
import { takeIdOf, transport } from '../audio/transport'
import { fmt, MiniWave } from '../Waveform'
import { credits, REC_COLOR, stamp, TAKE_COLOR } from './shared'
import { takeDrag } from './take-drag'

const DRAG_SLOP = 5

interface Props {
  cue: Cue
  source: PreviewSource
  onSelect: (source: PreviewSource) => void
  onAudition: (take: Take) => void
  onReconvert: (take: Take) => void
  converting: boolean
  noVoiceReason: string
}

export function TakesStrip({
  cue,
  source,
  onSelect,
  onAudition,
  onReconvert,
  converting,
  noVoiceReason,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null)
  const [durs, setDurs] = useState<Record<string, number>>({})

  const painted = useRef<{ id: string; head: HTMLElement | null; prog: HTMLElement | null } | null>(
    null
  )
  const shown = useRef<string | null>(null)

  useEffect(() => {
    const els = (takeId: string): { head: HTMLElement | null; prog: HTMLElement | null } => {
      const c = painted.current
      if (c && c.id === takeId && (c.head?.isConnected ?? false)) return c
      const root = stripRef.current
      const next = {
        id: takeId,
        head: root?.querySelector<HTMLElement>(`[data-head="${takeId}"]`) ?? null,
        prog: root?.querySelector<HTMLElement>(`[data-prog="${takeId}"]`) ?? null,
      }
      painted.current = next
      return next
    }
    const hide = (takeId: string): void => {
      const e = els(takeId)
      if (e.head) e.head.style.display = 'none'
      if (e.prog) e.prog.style.width = '0%'
    }
    return transport.subscribe((s) => {
      const id = takeIdOf(s.clipId)
      if (shown.current && shown.current !== id) {
        hide(shown.current)
        shown.current = null
      }
      if (!id) return
      const e = els(id)
      const f = s.dur > 0 ? Math.min(1, s.pos / s.dur) : 0
      if (e.head) {
        e.head.style.display = s.playing ? 'block' : 'none'
        e.head.style.left = `${f * 100}%`
      }
      if (e.prog) e.prog.style.width = `${(s.playing ? f : 0) * 100}%`
      shown.current = id
    })
  }, [])

  const takes = liveTakes(cue)
  const comp = cue.comp && cue.comp.clips.length > 0 ? cue.comp : null

  const dragged = useRef(false)

  const startDrag = useCallback(
    (e: ReactPointerEvent, take: Take, duration: number, label: string): void => {
      if (e.button !== 0) return
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
          takeDrag.start({ takeId: take.id, duration, label, x: ev.clientX, y: ev.clientY })
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
        if (armed) takeDrag.drop(ev.clientX, ev.clientY)
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
    []
  )

  if (takes.length === 0 && !comp) {
    return (
      <div className="takes empty" ref={stripRef}>
        <span className="takes-none">no takes yet</span>
      </div>
    )
  }

  return (
    <div className="takes" ref={stripRef}>
      {takes.map((t, i) => {
        const final = t.id === cue.finalTakeId
        const selected = source.kind === 'take' && source.takeId === t.id
        const d = durs[t.id] ?? t.duration
        const raw = t.kind === 'recording'
        const dur = raw ? t.duration : d
        const tooLong = raw && t.duration > MAX_STS_SECONDS
        const blocked =
          noVoiceReason || (tooLong ? 'Recording is longer than 5 min — STS will reject it' : '')
        return (
          <div
            key={t.id}
            className={
              'take' + (final ? ' final' : '') + (raw ? ' raw' : '') + (selected ? ' sel' : '')
            }
            title={`${raw ? 'raw recording' : t.kind} · ${stamp(t.createdAt)}\nClick to select · double-click to play${raw ? '' : ' · F makes it final · drag onto COMP to insert'} · Del removes it`}
            onPointerDown={(e) => {
              if (raw || !(dur > 0)) return
              startDrag(e, t, dur, `${t.kind} ${i + 1}`)
            }}
            onClick={() => {
              if (dragged.current) {
                dragged.current = false
                return
              }
              onSelect({ kind: 'take', takeId: t.id })
            }}
            onDoubleClick={() => onAudition(t)}
          >
            <MiniWave
              absPath={t.file.relPath}
              color={raw ? REC_COLOR : TAKE_COLOR}
              onDuration={(v) => {
                setDurs((p) => (p[t.id] === v ? p : { ...p, [t.id]: v }))
                reportTakeDuration(cue.id, t, v)
              }}
            />
            {}
            <span className="take-head" data-head={t.id} style={{ display: 'none' }} />
            <span className="take-prog" data-prog={t.id} style={{ width: 0 }} />
            <span className="take-meta">
              <span className="take-top">
                <span className="take-n">{i + 1}</span>
                {}
                {t.fragment && <span className="take-frag">frag</span>}
                <span className="t-ok">{final ? '★' : ''}</span>
              </span>
              <span className="take-bot">
                <span>{raw ? '● raw' : t.kind}</span>
                <span>{dur ? fmt(dur) : ''}</span>
              </span>
            </span>
            {raw && (
              <button
                className="take-conv"
                disabled={converting || !!blocked}
                title={blocked || `Convert again (≈${credits(t.duration)} credits)`}
                onClick={(e) => {
                  e.stopPropagation()
                  onReconvert(t)
                }}
              >
                ⟳ ≈{credits(t.duration)}
              </button>
            )}
          </div>
        )
      })}
      {comp && (
        <div
          className={'take' + (source.kind === 'comp' ? ' sel' : '')}
          title="Composition"
          onClick={() => onSelect({ kind: 'comp' })}
        >
          <span className="take-meta">
            <span className="take-top">
              <span className="take-n">C</span>
            </span>
            <span className="take-bot">
              <span>comp</span>
              <span>{fmt(compDuration(comp))}</span>
            </span>
          </span>
        </div>
      )}
    </div>
  )
}
