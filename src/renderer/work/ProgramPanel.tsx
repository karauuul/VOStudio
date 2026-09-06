import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MutableRefObject,
} from 'react'
import type { WordTiming } from '@shared/domain'
import { mapToOriginal, subtitleAt } from '@shared/subtitles'
import { audioUrl } from '../api'
import { clipId, transport, type TransportState } from '../audio/transport'
import { useWire } from '../cue/useWire'
import { playback } from '../playback'
import { getPeaks, Wave, type Peaks } from '../Waveform'
import { timecode } from './TimelinePanel'

const STEP_SECONDS = 0.1
const GAIN_KEY = 'vo.monitor.gain'

export interface ProgramSourceView {
  takeId: string
  label: string
  duration: number
  relPath: string
  text: string
  settings: string
  color: string
  words?: WordTiming[]
}

export interface ProgramApi {
  toggle: () => boolean
  insert: () => void
  replace: () => void
}

export interface ProgramPanelProps {
  sourceText: string
  text: string
  duration: number
  referenceDuration: number
  compDuration: number
  monitorId: string | null
  source: ProgramSourceView | null
  onInsert: () => void
  onReplace: () => void
  canReplace: boolean
  programRef: MutableRefObject<ProgramApi | null>
}

function storedGain(): number {
  try {
    const v = Number(localStorage.getItem(GAIN_KEY))
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1
  } catch {
    return 1
  }
}

export function ProgramPanel({
  sourceText,
  text,
  duration,
  referenceDuration,
  compDuration,
  monitorId,
  source,
  onInsert,
  onReplace,
  canReplace,
  programRef,
}: ProgramPanelProps) {
  const [tab, setTab] = useState<'program' | 'source'>('program')
  const [shownSource, setShownSource] = useState<string | null>(null)
  const [state, setState] = useState<TransportState>(() => transport.getState())
  const [compPos, setCompPos] = useState(() => playback.getPos())
  const [loop, setLoop] = useState(() => transport.getLoop())
  const [gain, setGain] = useState(storedGain)
  const [gainOpen, setGainOpen] = useState(false)
  const [full, setFull] = useState(false)
  const [peaks, setPeaks] = useState<Peaks | null>(null)

  const sourceId = source?.takeId ?? null
  if (shownSource !== sourceId) {
    setShownSource(sourceId)
    setTab(sourceId ? 'source' : 'program')
  }

  const onSource = tab === 'source' && !!source
  const auditionId = source ? clipId.take(source.takeId) : null

  useEffect(() => setState(transport.getState()), [])
  useEffect(() => transport.subscribe(setState), [])
  useEffect(() => playback.subscribePos(setCompPos), [])

  useEffect(() => {
    transport.setMonitorGain(gain)
    try {
      localStorage.setItem(GAIN_KEY, String(gain))
    } catch {
    }
  }, [gain])

  useEffect(() => {
    setPeaks(null)
    const path = source?.relPath
    if (!path) return
    let alive = true
    void getPeaks(path).then(
      (p) => {
        if (alive) setPeaks(p)
      },
      () => {}
    )
    return () => {
      alive = false
    }
  }, [source?.relPath])

  const sourceDur = peaks?.duration || source?.duration || 0
  const sourcePos = auditionId && state.clipId === auditionId ? state.pos : 0
  const total = onSource ? sourceDur : duration
  const pos = onSource ? sourcePos : Math.min(compPos, total)
  const activeId = onSource ? auditionId : monitorId
  const playing = state.playing && !!activeId && state.clipId === activeId

  const audition = useCallback((): void => {
    if (!source || !auditionId) return
    if (state.playing && state.clipId === auditionId) {
      transport.pause()
      return
    }
    void transport.playClip({ id: auditionId, url: audioUrl(source.relPath) })
  }, [source, auditionId, state])

  const seekSource = useCallback(
    (t: number): void => {
      if (!source || !auditionId) return
      if (transport.currentClipId() !== auditionId) {
        void transport.playClip({ id: auditionId, url: audioUrl(source.relPath) }).then(() => {
          transport.pause()
          transport.seek(t)
        })
        return
      }
      transport.seek(t)
    },
    [source, auditionId]
  )

  const step = useCallback(
    (dir: -1 | 1): void => {
      if (!onSource) {
        playback.step(dir)
        return
      }
      const words = source?.words ?? []
      const edges = words.flatMap((w) => [w.start, w.end]).sort((a, b) => a - b)
      const next =
        dir < 0
          ? [...edges].reverse().find((p) => p < sourcePos - 1e-4)
          : edges.find((p) => p > sourcePos + 1e-4)
      seekSource(
        Math.max(0, Math.min(total, next ?? sourcePos + dir * STEP_SECONDS))
      )
    },
    [onSource, source, sourcePos, total, seekSource]
  )

  const api = useMemo<ProgramApi>(
    () => ({
      toggle: () => {
        if (!onSource) return false
        audition()
        return true
      },
      insert: onInsert,
      replace: onReplace,
    }),
    [onSource, audition, onInsert, onReplace]
  )
  useWire(programRef, api)

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setFull(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [full])

  useEffect(() => {
    if (!gainOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as HTMLElement).closest('.prog-vol')) setGainOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [gainOpen])

  const subtitle = useMemo(() => {
    if (onSource || !sourceText || !(referenceDuration > 0)) return null
    const played = compDuration > 0 ? compDuration : referenceDuration
    return subtitleAt(sourceText, text, mapToOriginal(pos, played, referenceDuration), referenceDuration)
  }, [onSource, sourceText, text, pos, compDuration, referenceDuration])

  const off = onSource ? false : !(total > 0)

  const frame = (
    <div className="frame">
     <div className="frame-in">
      {onSource && source ? (
        <div className="src">
          <div className="wave">
            <span className="src-io" />
            <Wave peaks={peaks} from={0} to={peaks?.duration || sourceDur} color={source.color} />
            <span
              className="tl-ph src-ph"
              style={{ left: `${total > 0 ? (pos / total) * 100 : 0}%` }}
            />
          </div>
          <div className="cap">
            {source.text}
            <small>{source.settings}</small>
          </div>
        </div>
      ) : (
        subtitle && (
          <div className="sub">
            {subtitle.original}
            {subtitle.translation && <small>{subtitle.translation}</small>}
          </div>
        )
      )}
     </div>
    </div>
  )

  return (
    <section className="panel prog">
      <div className="phd">
        {onSource ? 'Source' : 'Program'}
        <span className="n">
          {onSource && source ? `${source.label} · ${sourceDur.toFixed(2)}s` : 'no video'}
        </span>
        {source ? (
          <span className="tabs">
            <button className={onSource ? '' : 'on'} onClick={() => setTab('program')}>
              Program
            </button>
            <button className={onSource ? 'on' : ''} onClick={() => setTab('source')}>
              Source
            </button>
          </span>
        ) : (
          <span className="tabs prog-aspect">
            <span className="field mono">Fit</span>
            <span className="field mono">16:9</span>
          </span>
        )}
      </div>

      {frame}

      <div className="trn">
        <span className="tc">
          {timecode(pos)} <span>/ {timecode(total)}</span>
        </span>
        <div className="tb">
          <button
            className="ico"
            aria-label="Go to in"
            disabled={off}
            onClick={() => (onSource ? seekSource(0) : playback.goIn())}
          >
            <svg width="14" height="12" viewBox="0 0 14 12">
              <rect x="1" y="1" width="2" height="10" fill="currentColor" />
              <path d="M12 1L4 6l8 5z" fill="currentColor" />
            </svg>
          </button>
          <button className="ico" aria-label="Step back" disabled={off} onClick={() => step(-1)}>
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M10 1L2 6l8 5z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="ico play"
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={off}
            onClick={() => (onSource ? audition() : playback.toggle())}
          >
            {playing ? (
              <svg width="14" height="16" viewBox="0 0 12 14">
                <rect x="1" y="1" width="3.6" height="12" fill="currentColor" />
                <rect x="7.4" y="1" width="3.6" height="12" fill="currentColor" />
              </svg>
            ) : (
              <svg width="14" height="16" viewBox="0 0 12 14">
                <path d="M1 1l10 6-10 6z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button className="ico" aria-label="Step forward" disabled={off} onClick={() => step(1)}>
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 1l8 5-8 5z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="ico"
            aria-label="Go to out"
            disabled={off}
            onClick={() => (onSource ? seekSource(total) : playback.goOut())}
          >
            <svg width="14" height="12" viewBox="0 0 14 12">
              <path d="M2 1l8 5-8 5z" fill="currentColor" />
              <rect x="11" y="1" width="2" height="10" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div className="rt">
          <button
            className={'ico' + (loop ? ' on' : '')}
            aria-label="Loop"
            aria-pressed={loop}
            onClick={() => {
              const next = !loop
              setLoop(next)
              transport.setLoop(next)
            }}
          >
            <svg width="16" height="14" viewBox="0 0 16 14">
              <path
                d="M3 5V4a2 2 0 0 1 2-2h7M13 9v1a2 2 0 0 1-2 2H4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M10 0l3 2-3 2zM6 10l-3 2 3 2z" fill="currentColor" />
            </svg>
          </button>
          {onSource ? (
            <>
              <button className="btn sm prog-place" onClick={onInsert}>
                Insert
              </button>
              <button className="btn sm prog-place" disabled={!canReplace} onClick={onReplace}>
                Replace
              </button>
            </>
          ) : (
            <>
              <button className="ico" aria-label="Full screen" onClick={() => setFull(true)}>
                <svg width="14" height="14" viewBox="0 0 14 14">
                  <path
                    d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                </svg>
              </button>
              <span className="prog-vol">
                <button
                  className={'ico' + (gainOpen ? ' on' : '')}
                  aria-label="Monitor volume"
                  onClick={() => setGainOpen((v) => !v)}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <path d="M1 5h3l4-3v10l-4-3H1z" fill="currentColor" />
                    <path d="M10 4a4 4 0 0 1 0 6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                </button>
                {gainOpen && (
                  <span className="prog-pop">
                    <input
                      type="range"
                      className="tl-range"
                      min={0}
                      max={100}
                      value={Math.round(gain * 100)}
                      aria-label="Monitor gain"
                      onChange={(e) => setGain(Number(e.target.value) / 100)}
                    />
                  </span>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      {full && (
        <div className="prog-full" onClick={() => setFull(false)}>
          {frame}
        </div>
      )}
    </section>
  )
}
