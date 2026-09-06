import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
const METER_DECAY = 0.86

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

export interface ProgramVideo {
  url: string
  base: number
  duration: number
  aspect: string
}

export interface ProgramApi {
  toggle: () => boolean
  insert: () => void
  replace: () => void
  showTab: (tab: 'program' | 'source') => void
}

export interface ProgramPanelProps {
  sourceText: string
  text: string
  duration: number
  referenceDuration: number
  compDuration: number
  monitorId: string | null
  video: ProgramVideo | null
  source: ProgramSourceView | null
  onInsert: () => void
  onReplace: () => void
  onHoverPlace?: (kind: 'insert' | 'replace' | null) => void
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
  video,
  source,
  onInsert,
  onReplace,
  onHoverPlace,
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
  const [fill, setFill] = useState(false)
  const [aspect, setAspect] = useState('source')
  const videoRef = useRef<HTMLVideoElement>(null)
  const meterRef = useRef<HTMLElement>(null)

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
    if (transport.currentClipId() === auditionId) {
      transport.play()
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
      showTab: (next) => {
        if (next === 'program' || source) setTab(next)
      },
    }),
    [onSource, source, audition, onInsert, onReplace]
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

  useEffect(() => {
    const level = (v: number): void => {
      const el = meterRef.current
      if (el) el.style.transform = `scaleX(${v.toFixed(3)})`
    }
    if (!state.playing) {
      level(0)
      return
    }
    let raf = 0
    let held = 0
    const loop = (): void => {
      held = Math.min(1, Math.max(transport.monitorPeak(), held * METER_DECAY))
      level(held)
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [state.playing])

  const subtitle = useMemo(() => {
    if (onSource || !sourceText || !(referenceDuration > 0)) return null
    const played = compDuration > 0 ? compDuration : referenceDuration
    return subtitleAt(sourceText, text, mapToOriginal(pos, played, referenceDuration), referenceDuration)
  }, [onSource, sourceText, text, pos, compDuration, referenceDuration])

  const showVideo = !!video && !onSource
  const videoBase = video?.base ?? 0
  const videoAt = video ? videoBase + pos : 0

  useEffect(() => {
    const el = videoRef.current
    if (!el || !showVideo || playing) return
    if (Math.abs(el.currentTime - videoAt) > 0.04) el.currentTime = videoAt
  }, [showVideo, playing, videoAt])

  useEffect(() => {
    const el = videoRef.current
    if (!el || !showVideo) return
    if (!playing) {
      el.pause()
      return
    }
    el.currentTime = videoBase + playback.getPos()
    void el.play().catch(() => {})
    let raf = 0
    let frame = 0
    const withFrames = (
      el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    ).requestVideoFrameCallback?.bind(el)
    const loop = (): void => {
      const want = videoBase + playback.getPos()
      if (Math.abs(el.currentTime - want) > 0.04) el.currentTime = want
      if (withFrames) frame = withFrames(loop)
      else raf = window.requestAnimationFrame(loop)
    }
    loop()
    return () => {
      el.pause()
      if (raf) window.cancelAnimationFrame(raf)
      const cancel = (
        el as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }
      ).cancelVideoFrameCallback?.bind(el)
      if (frame && cancel) cancel(frame)
    }
  }, [showVideo, playing, videoBase])

  const off = onSource ? false : !(total > 0)

  const frame = (
    <div className="frame">
     <div
       className="frame-in"
       style={{
         aspectRatio:
           aspect === 'source' ? (video ? video.aspect.replace(':', ' / ') : '16 / 9') : aspect,
       }}
     >
      {showVideo && video && (
        <>
          <video
            ref={videoRef}
            className={'prog-video' + (fill ? ' fill' : '')}
            src={video.url}
            muted
            playsInline
            preload="metadata"
          />
          <span className="prog-tc">{timecode(videoAt)}</span>
        </>
      )}
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
          {onSource && source
            ? `${source.label} · ${sourceDur.toFixed(2)}s`
            : video
              ? timecode(videoAt)
              : 'no video'}
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
            <select
              className="field mono"
              aria-label="Frame fit"
              data-hint="Frame fit"
              value={fill ? 'fill' : 'fit'}
              onChange={(e) => setFill(e.target.value === 'fill')}
            >
              <option value="fit">Fit</option>
              <option value="fill">Fill</option>
            </select>
            <select
              className="field mono"
              aria-label="Aspect"
              data-hint="Aspect"
              value={aspect}
              onChange={(e) => setAspect(e.target.value)}
            >
              <option value="source">{video ? video.aspect : '16:9'}</option>
              <option value="16 / 9">16:9</option>
              <option value="4 / 3">4:3</option>
              <option value="1 / 1">1:1</option>
            </select>
          </span>
        )}
      </div>

      {frame}

      <div className="trn">
        <span className="tc">
          {timecode(video ? videoAt : pos)}{' '}
          <span>/ {timecode(video ? video.duration : total)}</span>
        </span>
        <div className="tb">
          <button
            className="ico"
            aria-label="Go to in"
            data-hk="goIn"
            disabled={off}
            onClick={() => (onSource ? seekSource(0) : playback.goIn())}
          >
            <svg width="14" height="12" viewBox="0 0 14 12">
              <rect x="1" y="1" width="2" height="10" fill="currentColor" />
              <path d="M12 1L4 6l8 5z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="ico"
            aria-label="Step back"
            data-hint="Step back"
            disabled={off}
            onClick={() => step(-1)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M10 1L2 6l8 5z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="ico play"
            aria-label={playing ? 'Pause' : 'Play'}
            data-hk="playPause"
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
          <button
            className="ico"
            aria-label="Step forward"
            data-hint="Step forward"
            disabled={off}
            onClick={() => step(1)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 1l8 5-8 5z" fill="currentColor" />
            </svg>
          </button>
          <button
            className="ico"
            aria-label="Go to out"
            data-hk="goOut"
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
            data-hint="Loop"
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
              <button
                className="btn sm prog-place"
                data-hk="insertSource"
                onClick={onInsert}
                onMouseEnter={() => onHoverPlace?.('insert')}
                onMouseLeave={() => onHoverPlace?.(null)}
              >
                Insert
              </button>
              <button
                className="btn sm prog-place"
                data-hk="replaceSource"
                disabled={!canReplace}
                onClick={onReplace}
                onMouseEnter={() => canReplace && onHoverPlace?.('replace')}
                onMouseLeave={() => onHoverPlace?.(null)}
              >
                Replace
              </button>
            </>
          ) : (
            <>
              <button
                className="ico"
                aria-label="Full screen"
                data-hint="Full screen"
                onClick={() => setFull(true)}
              >
                <svg width="14" height="14" viewBox="0 0 14 14">
                  <path
                    d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                </svg>
              </button>
              <span className="prog-meter" aria-hidden="true">
                <i ref={meterRef} />
              </span>
              <span className="prog-vol">
                <button
                  className={'ico' + (gainOpen ? ' on' : '')}
                  aria-label={gain === 0 ? 'Monitor volume, muted' : 'Monitor volume'}
                  data-hint="Volume"
                  onClick={() => setGainOpen((v) => !v)}
                >
                  <svg width="14" height="14" viewBox="0 0 14 14">
                    <path d="M1 5h3l4-3v10l-4-3H1z" fill="currentColor" />
                    {gain === 0 ? (
                      <path
                        d="M10 4.5l3.2 5M13.2 4.5l-3.2 5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                    ) : (
                      <>
                        <path
                          d="M9.8 5.2a2.6 2.6 0 0 1 0 3.6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.4"
                        />
                        {gain >= 0.5 && (
                          <path
                            d="M11.9 3.4a5.2 5.2 0 0 1 0 7.2"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                          />
                        )}
                      </>
                    )}
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
