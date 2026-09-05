import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { compDuration, compRenderPlan, isEmptyComp } from '@shared/comp'
import { liveTakes, type Cue, type CueComp } from '@shared/domain'
import { resolvePreview, type ResolvedPreview } from '@shared/workspace-source'
import { audioUrl } from '../api'
import { tryResolveComp } from '../audio/comp-source'
import { reportTakeDuration } from '../audio/duration-backfill'
import { clipId, transport } from '../audio/transport'
import { fmt, getPeaks, type Peaks, type WaveformHandle } from '../Waveform'
import type { EffectsTarget } from './ClipParams'
import { drawCompLane, drawRuler, drawSourceLane, type DrawClip, type DrawGhost } from './timeline-draw'
import {
  clampView,
  fitView,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  timeToX,
  xToTime,
  zoomAt,
  type TimelineView,
} from './timeline-math'
import { TimelineEditor, useTimelineEditor, type CompApi } from './TimelineEditor'
import { useLaneTransport } from './useLaneTransport'
import { useWire } from './useWire'
import { timecode } from './shared'

export type { ClipSelection, CompApi } from './TimelineEditor'

interface Props {
  cue: Cue
  preview: ResolvedPreview
  sourceHeader: ReactNode
  insertMenu: ReactNode
  timelineOpen: boolean
  onTimeline: () => void
  origRef: MutableRefObject<WaveformHandle | null>
  takeRef: MutableRefObject<WaveformHandle | null>
  abRef: MutableRefObject<(() => void) | null>
  compRef: MutableRefObject<CompApi | null>
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  onEffectsTarget: (target: EffectsTarget | null) => void
  busyClipId?: string | null
  onFragmentText: (clipId: string, text: string) => void
}

export function WaveLanes({
  cue,
  preview,
  sourceHeader,
  insertMenu,
  timelineOpen,
  onTimeline,
  origRef,
  takeRef,
  abRef,
  compRef,
  onComp,
  onStatus,
  onEffectsTarget,
  busyClipId,
  onFragmentText,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const origCanvas = useRef<HTMLCanvasElement>(null)
  const compCanvas = useRef<HTMLCanvasElement>(null)
  const headRef = useRef<HTMLSpanElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)

  const [width, setWidth] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [refWave, setRefWave] = useState<{ path: string; peaks: Peaks } | null>(null)
  const [srcPeaks, setSrcPeaks] = useState<Record<string, Peaks>>({})
  const [snapOn, setSnapOn] = useState(true)
  const [pxPerSec, setPxPerSec] = useState(100)

  const [shownCue, setShownCue] = useState(cue.id)
  if (shownCue !== cue.id) {
    setShownCue(cue.id)
    setSrcPeaks({})
    setSelected(null)
  }

  const refPath = cue.referenceAudio?.relPath
  const refPeaks = refWave && refWave.path === refPath ? refWave.peaks : null

  const take = preview.take

  const takeDur = (take && (srcPeaks[take.id]?.duration || take.duration)) || 0

  const displayComp = useMemo(
    () => resolvePreview(cue, preview.source, takeDur).comp ?? null,
    [cue.comp, cue.takes, preview.source, takeDur]
  )
  const resolved = useMemo(() => tryResolveComp(cue, displayComp), [cue.takes, displayComp])

  const editable =
    timelineOpen &&
    !!displayComp &&
    (preview.source.kind === 'comp' ||
      (!!take && take.kind !== 'recording' && isEmptyComp(cue.comp)))

  const refDur = refPeaks?.duration ?? 0
  const compDur = displayComp ? compDuration(displayComp) : 0
  const contentDur = Math.max(refDur, compDur)

  const live = useMemo(() => liveTakes(cue), [cue.takes])
  const isComp = preview.source.kind === 'comp'

  const compClipId = isComp ? clipId.comp(cue.id) : take ? clipId.take(take.id) : null

  const viewRef = useRef<TimelineView>({ pxPerSec: 100, scroll: 0 })
  const pendingRef = useRef<CueComp | null>(null)
  const ghostRef = useRef<DrawGhost | null>(null)
  const rafRef = useRef(0)
  const widthRef = useRef(0)
  widthRef.current = width
  const contentRef = useRef(0)
  contentRef.current = contentDur
  const displayRef = useRef<CueComp | null>(null)
  displayRef.current = displayComp
  const peaksRef = useRef(srcPeaks)
  peaksRef.current = srcPeaks
  const refPeaksRef = useRef(refPeaks)
  refPeaksRef.current = refPeaks
  const selRef = useRef<string | null>(null)
  selRef.current = selected
  const refDurRef = useRef(0)
  refDurRef.current = refDur
  const refPathRef = useRef<string | undefined>(undefined)
  refPathRef.current = refPath
  const busyRef = useRef<string | null>(null)
  busyRef.current = busyClipId ?? null
  const snapRef = useRef(true)
  snapRef.current = snapOn
  const editableRef = useRef(false)
  editableRef.current = editable

  const labels = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of cue.takes) {
      const i = live.findIndex((x) => x.id === t.id)
      m.set(t.id, `${t.kind} ${i >= 0 ? i + 1 : '×'}`)
    }
    return m
  }, [cue.takes])
  const labelsRef = useRef(labels)
  labelsRef.current = labels

  const paintHead = useCallback((at: number): void => {
    const h = headRef.current
    if (h) h.style.transform = `translateX(${timeToX(viewRef.current, at).toFixed(2)}px)`
    const c = timeRef.current
    if (c) c.textContent = timecode(at)
  }, [])

  const t = useLaneTransport({
    orig: {
      id: refPath ? clipId.original(refPath) : null,
      url: refPath ? audioUrl(refPath) : undefined,
      duration: refDur,
    },
    comp: {
      id: compClipId,
      comp: resolved,
      duration: compDur,
    },
    resetKey: cue.id,
    onFrame: paintHead,
  })

  const { origHandle, compHandle, posRef } = t
  useWire(origRef, origHandle)
  useWire(takeRef, compHandle)

  const draw = useCallback((): void => {
    const view = viewRef.current
    const comp = pendingRef.current ?? displayRef.current
    const busy = busyRef.current
    const plan = compRenderPlan(comp?.clips ?? [])
    const clips: DrawClip[] = (comp?.clips ?? []).map((clip, i) => ({
      clip,
      peaks: peaksRef.current[clip.sourceTakeId] ?? null,
      label: labelsRef.current.get(clip.sourceTakeId) ?? 'clip',
      busy: clip.id === busy,
      crossfade: plan[i].crossfadeOut,
    }))
    const region = comp?.region
    drawRuler(rulerRef.current, view, region)
    drawSourceLane(origCanvas.current, refPeaksRef.current, view, region)
    drawCompLane(compCanvas.current, clips, view, selRef.current, {
      pulse: busy ? (Math.sin(performance.now() / 260) + 1) / 2 : 0,
      refEnd: refDurRef.current,
      region,
      ghost: ghostRef.current,
    })
    paintHead(posRef.current)
  }, [paintHead, posRef])

  const requestDraw = useCallback((): void => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      draw()
    })
  }, [draw])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    []
  )

  useEffect(() => {
    if (!busyClipId) return
    const id = setInterval(requestDraw, 90)
    return () => clearInterval(id)
  }, [busyClipId, requestDraw])

  useEffect(() => {
    if (!refPath) {
      setRefWave(null)
      return
    }
    let alive = true
    void getPeaks(refPath)
      .then((p) => {
        if (alive) setRefWave({ path: refPath, peaks: p })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [refPath])

  useEffect(() => {
    pendingRef.current = null
  }, [cue.id])

  const needed = useMemo(() => {
    const ids = new Set<string>()
    if (take) ids.add(take.id)
    for (const c of displayComp?.clips ?? []) ids.add(c.sourceTakeId)
    return cue.takes.filter((x) => ids.has(x.id))
  }, [cue.takes, take, displayComp])

  useEffect(() => {
    let alive = true
    for (const src of needed) {
      if (srcPeaks[src.id]) continue
      void getPeaks(src.file.relPath)
        .then((p) => {
          if (!alive) return
          setSrcPeaks((m) => (m[src.id] ? m : { ...m, [src.id]: p }))
          reportTakeDuration(cue.id, src, p.duration)
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [needed, srcPeaks, cue.id])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth)
      requestDraw()
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [requestDraw])

  const FIT_TAIL = 1.04

  const fit = useCallback((): void => {
    viewRef.current = fitView(contentRef.current * FIT_TAIL, widthRef.current)
    requestDraw()
  }, [requestDraw])

  const zoomBy = useCallback(
    (factor: number): void => {
      viewRef.current = zoomAt(viewRef.current, factor, widthRef.current / 2)
      viewRef.current = clampView(viewRef.current, widthRef.current, contentRef.current)
      setPxPerSec(viewRef.current.pxPerSec)
      requestDraw()
    },
    [requestDraw]
  )

  const refReady = !refPath || refPeaks !== null

  const fittedRef = useRef<string>('')
  useEffect(() => {
    if (fittedRef.current === cue.id) return
    if (!refReady || !(contentDur > 0) || width <= 0) return
    fittedRef.current = cue.id
    fit()
    setPxPerSec(viewRef.current.pxPerSec)
  }, [cue.id, contentDur, width, refReady, fit])

  useEffect(() => {
    viewRef.current = clampView(viewRef.current, width, contentDur)
    requestDraw()
  })

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const box = el.getBoundingClientRect()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        viewRef.current = zoomAt(v, Math.exp(-e.deltaY * 0.0025), e.clientX - box.left)
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        viewRef.current = { ...v, scroll: v.scroll + d / v.pxPerSec }
      }
      viewRef.current = clampView(viewRef.current, widthRef.current, contentRef.current)
      setPxPerSec(viewRef.current.pxPerSec)
      requestDraw()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [requestDraw])

  const localX = useCallback((clientX: number): number => {
    const el = bodyRef.current
    return el ? clientX - el.getBoundingClientRect().left : 0
  }, [])

  const dragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => dragRef.current?.(), [])

  const startDrag = useCallback(
    (onMove: (ev: MouseEvent) => void, onUp: (ev: MouseEvent) => void): void => {
      const stop = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        dragRef.current = null
      }
      const move = (ev: MouseEvent): void => {
        if (ev.buttons === 0) {
          up(ev)
          return
        }
        onMove(ev)
      }
      const up = (ev: MouseEvent): void => {
        stop()
        onUp(ev)
      }
      dragRef.current = stop
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    []
  )

  const startScrub = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      t.scrubRef.current = true
      const apply = (clientX: number, exact: boolean): void => {
        t.seek(Math.max(0, xToTime(viewRef.current, localX(clientX))), exact)
        requestDraw()
      }
      startDrag(
        (ev) => apply(ev.clientX, false),
        (ev) => {
          apply(ev.clientX, true)
          t.scrubRef.current = false
        }
      )
      apply(e.clientX, true)
    },
    [t, localX, requestDraw, startDrag]
  )

  const editor = useTimelineEditor({
    cue,
    displayComp,
    selected,
    setSelected,
    editable,
    compDur,
    refs: {
      display: displayRef,
      pending: pendingRef,
      ghost: ghostRef,
      sel: selRef,
      peaks: peaksRef,
      refDur: refDurRef,
      refPath: refPathRef,
      snap: snapRef,
      editable: editableRef,
      view: viewRef,
      pos: posRef,
      canvas: compCanvas,
      ruler: rulerRef,
    },
    requestDraw,
    localX,
    startDrag,
    startScrub,
    fit,
    onComp,
    onStatus,
  })

  useWire(compRef, editor.api)

  useEffect(() => {
    if (!timelineOpen) setSelected(null)
  }, [timelineOpen])

  useEffect(() => {
    setSelected((s) => (s && !displayComp?.clips.some((c) => c.id === s) ? null : s))
  }, [displayComp])

  const selectedClip = editor.selectedClip

  const targetLabel = useMemo(() => {
    if (!selectedClip || !displayComp) return ''
    const ci = displayComp.clips.findIndex((c) => c.id === selectedClip.id)
    const ti = live.findIndex((x) => x.id === selectedClip.sourceTakeId)
    return `Composition · Clip ${ci + 1} · ${ti >= 0 ? `Take ${ti + 1}` : 'Take ×'}`
  }, [selectedClip, displayComp, live])

  useEffect(() => {
    onEffectsTarget(
      selectedClip
        ? {
            label: targetLabel,
            clip: selectedClip,
            sourceDuration: srcPeaks[selectedClip.sourceTakeId]?.duration ?? 0,
            busy: busyClipId === selectedClip.id,
          }
        : null
    )
  }, [selectedClip, targetLabel, srcPeaks, busyClipId, onEffectsTarget])

  useEffect(() => () => onEffectsTarget(null), [onEffectsTarget])

  const abCompare = useCallback(() => {
    if (!refPath) {
      compHandle.play()
      return
    }
    if (!resolved || !compClipId) {
      origHandle.play()
      return
    }
    void transport.playSplit(
      { id: clipId.original(refPath), url: audioUrl(refPath) },
      { id: compClipId, comp: resolved }
    )
  }, [refPath, resolved, compClipId, origHandle, compHandle])

  useWire(abRef, abCompare)

  const delta = refDur > 0 && compDur > 0 ? compDur - refDur : null
  const origId = refPath ? clipId.original(refPath) : null

  return (
    <div className={'tl' + (timelineOpen ? ' timeline' : '')}>
      <div className="tl-top">
        <span className="tl-top-l">{timelineOpen ? 'Output timeline' : 'Compare'}</span>
        <span className="sp" />
        <button className="btn ghost" onClick={abCompare} disabled={!cue.referenceAudio}>
          Compare <kbd>B</kbd>
        </button>
        <button className="btn ghost" onClick={onTimeline} aria-pressed={timelineOpen}>
          {timelineOpen ? 'Review' : 'Timeline'} <kbd>D</kbd>
        </button>
      </div>

      {timelineOpen && (
        <TimelineEditor
          editor={editor}
          insert={editor.canInsert ? insertMenu : null}
          snap={snapOn}
          onSnap={() => setSnapOn((v) => !v)}
          onZoomIn={() => zoomBy(1.5)}
          canZoomIn={pxPerSec < MAX_PX_PER_SEC}
          onZoomOut={() => zoomBy(1 / 1.5)}
          canZoomOut={pxPerSec > MIN_PX_PER_SEC}
          onFit={fit}
          busy={!!busyClipId}
          onFragmentText={(text) => {
            const id = selRef.current
            if (id) onFragmentText(id, text)
          }}
        />
      )}

      <div className="tl-body" ref={bodyRef}>
        <canvas
          className="tl-ruler"
          ref={rulerRef}
          onMouseDown={editor.onRulerDown}
          onDoubleClick={editor.onRulerDouble}
          title="Top strip: drag to set the render range · below: drag to scrub · double-click to fit"
        />

        <div className="tl-lane orig">
          <canvas ref={origCanvas} onMouseDown={startScrub} />
          <span className="tl-tag">ORIGINAL</span>
          <span className="tl-len">{fmt(refDur)}</span>
          {refPath ? (
            <button
              className="tl-play"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => t.origHandle.toggle()}
              title={t.playingId === origId ? 'Pause' : 'Play the reference'}
            >
              {t.playingId === origId ? '❚❚' : '▶'}
            </button>
          ) : (
            <span className="tl-none">no reference audio</span>
          )}
        </div>

        {sourceHeader}

        <div className="tl-lane comp">
          <canvas
            ref={compCanvas}
            onMouseDown={editor.onCompDown}
            onMouseMove={editor.onCompHover}
            onDoubleClick={(e) => e.stopPropagation()}
          />
          <span className="tl-len">{fmt(compDur)}</span>
          {displayComp ? (
            <button
              className="tl-play"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => t.compHandle.toggle()}
              title={t.playingId === compClipId ? 'Pause' : isComp ? 'Play the composition' : 'Play the take'}
            >
              {t.playingId === compClipId ? '❚❚' : '▶'}
            </button>
          ) : (
            <span className="tl-none">no take</span>
          )}
        </div>

        <span className="tl-head" ref={headRef} />
      </div>

      <div className="tl-foot">
        <span className="tl-time" ref={timeRef} />
        {delta !== null && (
          <span
            className={'delta' + (Math.abs(delta) > 0.5 ? ' warn' : '')}
            title="Length difference against the original"
          >
            Δ {delta >= 0 ? '+' : ''}
            {delta.toFixed(2)}s
          </span>
        )}
      </div>
    </div>
  )
}
