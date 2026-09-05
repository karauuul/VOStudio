import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import {
  canHeal,
  clipEnd,
  clipTimelineDuration,
  compDuration,
  compRenderPlan,
  DEFAULT_CROSSFADE,
  effectiveCrossfade,
  findInsertSlot,
  healableAt,
  healCut,
  insertClipFromTake,
  maxCrossfade,
  moveClip,
  removeClip,
  replaceClipSource,
  setClipEdits,
  setCrossfade,
  setRegion,
  setRegionEdge,
  isEmptyComp,
  splitClipAt,
  trimClipEdge,
} from '@shared/comp'
import { liveTakes, type ClipEdits, type Cue, type CueComp } from '@shared/domain'
import { toggleEffect } from '@shared/effects'
import { resolvePreview, type ResolvedPreview } from '@shared/workspace-source'
import { audioUrl } from '../api'
import { tryResolveComp } from '../audio/comp-source'
import { reportTakeDuration } from '../audio/duration-backfill'
import { clipId, transport } from '../audio/transport'
import { fmt, getPeaks, type Peaks, type WaveformHandle } from '../Waveform'
import { ClipParams } from './ClipParams'
import { drawCompLane, drawRuler, drawSourceLane, type DrawClip, type DrawGhost } from './timeline-draw'
import {
  clampView,
  clipAt,
  FADE_ZONE_PX,
  fitView,
  hitTest,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  REGION_BAND_PX,
  regionHit,
  snap,
  SNAP_PX,
  snapDelta,
  snapTargets,
  timeToX,
  xToTime,
  zoomAt,
  type HitClip,
  type TimelineView,
} from './timeline-math'
import { takeDrag, type TakeDrag } from './take-drag'
import { TimelineBar } from './TimelineBar'
import { sameComp, useCompEdit } from './useCompEdit'
import { useLaneTransport } from './useLaneTransport'
import { useWire } from './useWire'
import { timecode } from './shared'

export interface ClipSelection {
  clipId: string
  start: number
  end: number
  reference: { id: string; url: string; from: number; to: number } | null
}

export interface CompApi {
  deleteSelected: () => boolean
  split: () => void
  heal: () => void
  crossfade: () => void
  undo: () => void
  redo: () => void
  selection: () => ClipSelection | null
  promptFragment: () => boolean
  replaceSource: (clipId: string, takeId: string, duration: number) => boolean
}

interface Props {
  cue: Cue
  preview: ResolvedPreview
  origRef: MutableRefObject<WaveformHandle | null>
  takeRef: MutableRefObject<WaveformHandle | null>
  abRef: MutableRefObject<(() => void) | null>
  compRef: MutableRefObject<CompApi | null>
  onComp: (cueId: string, comp: CueComp | null) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  busyClipId?: string | null
  onFragmentText: (clipId: string, text: string) => void
}

export function WaveLanes({
  cue,
  preview,
  origRef,
  takeRef,
  abRef,
  compRef,
  onComp,
  onStatus,
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
  const [prompt, setPrompt] = useState(false)
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
  const editable = preview.source.kind === 'comp' || (preview.source.kind === 'take' && isEmptyComp(cue.comp))

  const takeDur = (take && (srcPeaks[take.id]?.duration || take.duration)) || 0

  const displayComp = useMemo(
    () => resolvePreview(cue, preview.source, takeDur).comp ?? null,
    [cue.comp, cue.takes, preview.source, takeDur]
  )
  const resolved = useMemo(() => tryResolveComp(cue, displayComp), [cue.takes, displayComp])

  const refDur = refPeaks?.duration ?? 0
  const compDur = displayComp ? compDuration(displayComp) : 0
  const contentDur = Math.max(refDur, compDur)

  const live = useMemo(() => liveTakes(cue), [cue.takes])
  const takeNumber = take ? live.findIndex((t) => t.id === take.id) + 1 : 0
  const isComp = preview.source.kind === 'comp'
  const laneTag = isComp ? 'COMP' : takeNumber > 0 ? `TAKE ${takeNumber}` : 'TAKE'

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
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

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

  const onProblem = useCallback(
    (p: string) => onStatus('err', `Composition rejected: ${p}`),
    [onStatus]
  )
  const edit = useCompEdit(cue.id, cue.comp, onComp, onProblem)
  const editRef = useRef(edit)
  editRef.current = edit

  const commit = useCallback((next: CueComp | null, base: CueComp | null): void => {
    if (!editableRef.current) return
    const value = next && next.clips.length > 0 ? next : null
    if (sameComp(value, base)) return
    editRef.current.commit(value)
  }, [])

  const localX = useCallback((clientX: number): number => {
    const el = bodyRef.current
    return el ? clientX - el.getBoundingClientRect().left : 0
  }, [])

  const hitClips = useCallback((comp: CueComp | null): HitClip[] => {
    const clips = comp?.clips ?? []
    return clips.map((c, i) => ({
      id: c.id,
      start: c.start,
      end: clipEnd(c),
      fadeIn: c.edits.fadeIn.duration,
      fadeOut: c.edits.fadeOut.duration,
      crossfade: effectiveCrossfade(c, clips[i + 1]),
    }))
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

  const onRulerDown = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0) return
      const base = displayRef.current
      const canvas = rulerRef.current
      if (!base || !canvas || !editableRef.current || e.nativeEvent.offsetY > REGION_BAND_PX) {
        startScrub(e)
        return
      }
      e.preventDefault()
      const view = viewRef.current
      const at = Math.max(0, xToTime(view, localX(e.clientX)))
      const grab = regionHit(base.region, at, view.pxPerSec)
      const targets = snapTargets(hitClips(base), null, [t.posRef.current, refDurRef.current])
      const anchor =
        grab === 'in' && base.region ? base.region.out : grab === 'out' && base.region ? base.region.in : at
      let next: CueComp = base

      const apply = (clientX: number, alt: boolean): void => {
        const v = viewRef.current
        const tol = alt || !snapRef.current ? 0 : SNAP_PX / v.pxPerSec
        const raw = Math.max(0, xToTime(v, localX(clientX)))
        const edge = snap(raw, targets, tol)
        next = setRegion(base, { in: Math.min(anchor, edge), out: Math.max(anchor, edge) })
        pendingRef.current = next
        requestDraw()
      }

      startDrag(
        (ev) => apply(ev.clientX, ev.altKey),
        (ev) => {
          apply(ev.clientX, ev.altKey)
          pendingRef.current = null
          commit(next, base)
          requestDraw()
        }
      )
      apply(e.clientX, e.altKey)
    },
    [startScrub, localX, hitClips, t, snapRef, requestDraw, startDrag, commit]
  )

  const onRulerDouble = useCallback(
    (e: ReactMouseEvent): void => {
      const base = displayRef.current
      if (editableRef.current && base?.region && e.nativeEvent.offsetY <= REGION_BAND_PX) {
        const at = Math.max(0, xToTime(viewRef.current, localX(e.clientX)))
        if (at >= base.region.in && at <= base.region.out) {
          commit(setRegion(base, null), base)
          requestDraw()
          return
        }
      }
      fit()
    },
    [localX, commit, requestDraw, fit]
  )

  const onCompDown = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0) return
      const base = displayRef.current
      const canvas = compCanvas.current
      if (!base || !canvas || !editableRef.current) {
        startScrub(e)
        return
      }
      const box = canvas.getBoundingClientRect()
      const view = viewRef.current
      const at = xToTime(view, e.clientX - box.left)
      const hits = hitClips(base)
      const hit = hitTest(hits, at, view.pxPerSec, e.clientY - box.top <= FADE_ZONE_PX)
      if (!hit) {
        setSelected(null)
        startScrub(e)
        return
      }
      setSelected(hit.id)
      selRef.current = hit.id
      const clip = base.clips.find((c) => c.id === hit.id)
      if (!clip) return
      e.preventDefault()

      const x0 = e.clientX
      const targets = snapTargets(hits, hit.id, [t.posRef.current, refDurRef.current])
      const srcDur = peaksRef.current[clip.sourceTakeId]?.duration ?? Infinity
      const tl = clipTimelineDuration(clip)
      const xf0 = hits.find((h) => h.id === hit.id)?.crossfade ?? 0
      let next: CueComp = base

      const onMove = (ev: MouseEvent): void => {
        const pps = viewRef.current.pxPerSec
        const raw = (ev.clientX - x0) / pps
        const tol = ev.altKey || !snapRef.current ? 0 : SNAP_PX / pps
        if (hit.kind === 'crossfade') {
          next = setCrossfade(base, hit.id, xf0 - raw)
        } else if (hit.kind === 'clip') {
          const d = snapDelta([clip.start, clipEnd(clip)], raw, targets, tol)
          next = moveClip(base, hit.id, clip.start + d)
        } else if (hit.kind === 'trimStart' || hit.kind === 'trimEnd') {
          const edge = hit.kind === 'trimStart' ? 'start' : 'end'
          const anchor = edge === 'start' ? clip.start : clipEnd(clip)
          const d = snapDelta([anchor], raw, targets, tol)
          next = trimClipEdge(base, hit.id, edge, d, srcDur)
        } else if (hit.kind === 'fadeIn') {
          const d = Math.max(0, Math.min(tl, clip.edits.fadeIn.duration + raw))
          next = setClipEdits(base, hit.id, { fadeIn: { ...clip.edits.fadeIn, duration: d } })
        } else {
          const d = Math.max(0, Math.min(tl, clip.edits.fadeOut.duration - raw))
          next = setClipEdits(base, hit.id, { fadeOut: { ...clip.edits.fadeOut, duration: d } })
        }
        pendingRef.current = next
        requestDraw()
      }

      startDrag(onMove, () => {
        pendingRef.current = null
        commit(next, base)
        requestDraw()
      })
    },
    [startScrub, hitClips, t, requestDraw, startDrag, commit]
  )

  const onCompHover = useCallback(
    (e: ReactMouseEvent): void => {
      const canvas = compCanvas.current
      const base = pendingRef.current ?? displayRef.current
      if (!canvas || !base) return
      if (!editableRef.current) {
        canvas.style.cursor = 'pointer'
        return
      }
      const box = canvas.getBoundingClientRect()
      const view = viewRef.current
      const hit = hitTest(
        hitClips(base),
        xToTime(view, e.clientX - box.left),
        view.pxPerSec,
        e.clientY - box.top <= FADE_ZONE_PX
      )
      canvas.style.cursor = !hit
        ? 'pointer'
        : hit.kind === 'clip'
          ? 'grab'
          : hit.kind === 'fadeIn' || hit.kind === 'fadeOut'
            ? 'crosshair'
            : hit.kind === 'crossfade'
              ? 'col-resize'
              : 'ew-resize'
    },
    [hitClips]
  )

  const selectedClip = useMemo(
    () => displayComp?.clips.find((c) => c.id === selected) ?? null,
    [displayComp, selected]
  )

  const onClipEdit = useCallback(
    (patch: Partial<ClipEdits>, doCommit: boolean): void => {
      const base = displayRef.current
      const id = selRef.current
      if (!base || !id) return
      const next = setClipEdits(base, id, patch)
      if (doCommit) {
        pendingRef.current = null
        commit(next, base)
      } else {
        pendingRef.current = next
      }
      requestDraw()
    },
    [commit, requestDraw]
  )

  const removeSelected = useCallback((): boolean => {
    const base = displayRef.current
    const id = selRef.current
    if (!base || !id || !base.clips.some((c) => c.id === id)) return false
    commit(removeClip(base, id), base)
    setSelected(null)
    return true
  }, [commit])

  const splitAtHead = useCallback((): void => {
    const base = displayRef.current
    if (!base) return
    const at = t.posRef.current
    const sel = base.clips.find((c) => c.id === selRef.current)
    const target =
      sel && at > sel.start && at < clipEnd(sel)
        ? sel.id
        : clipAt(
            base.clips.map((c) => ({ id: c.id, start: c.start, end: clipEnd(c) })),
            at
          )
    if (!target) return
    commit(splitClipAt(base, target, at), base)
  }, [commit, t])

  const canHealAny = useMemo(
    () => !!displayComp && displayComp.clips.some((c) => canHeal(displayComp, c.id)),
    [displayComp]
  )

  const healSelected = useCallback((): void => {
    const base = displayRef.current
    if (!base) return
    const id =
      selRef.current && canHeal(base, selRef.current)
        ? selRef.current
        : healableAt(base, t.posRef.current, Infinity)
    if (!id) return
    commit(healCut(base, id), base)
    setSelected(id)
    selRef.current = id
  }, [commit, t])

  const xfRoom = useMemo(
    () => (displayComp && selected ? maxCrossfade(displayComp, selected) : 0),
    [displayComp, selected]
  )
  const xfNow = useMemo(() => {
    if (!displayComp || !selected) return 0
    const i = displayComp.clips.findIndex((c) => c.id === selected)
    return i < 0 ? 0 : effectiveCrossfade(displayComp.clips[i], displayComp.clips[i + 1])
  }, [displayComp, selected])

  const toggleCrossfade = useCallback((): void => {
    const base = displayRef.current
    const id = selRef.current
    if (!base || !id) return
    const i = base.clips.findIndex((c) => c.id === id)
    if (i < 0) return
    const on = effectiveCrossfade(base.clips[i], base.clips[i + 1]) > 0
    commit(setCrossfade(base, id, on ? 0 : DEFAULT_CROSSFADE), base)
  }, [commit])

  const toggleFx = useCallback(
    (which: 'reverb' | 'delay' | 'pitch'): void => {
      const base = displayRef.current
      const id = selRef.current
      if (!base || !id) return
      const clip = base.clips.find((c) => c.id === id)
      if (!clip) return
      const on = !!clip.edits.effects?.[which]
      const effects = toggleEffect(clip.edits.effects, which, !on)
      commit(setClipEdits(base, id, { effects }), base)
      requestDraw()
    },
    [commit, requestDraw]
  )

  const insertable = take && take.kind !== 'recording' && takeDur > 0 ? take : null

  const insertAtHead = useCallback((): void => {
    const base = displayRef.current
    if (!base || !insertable) return
    const next = insertClipFromTake(base, insertable.id, takeDur, t.posRef.current)
    if (sameComp(next, base)) {
      onStatus('info', 'No room for this take on the timeline')
      return
    }
    commit(next, base)
    requestDraw()
  }, [insertable, takeDur, t, commit, requestDraw, onStatus])

  useEffect(() => {
    return takeDrag.subscribe((d: TakeDrag | null) => {
      const canvas = compCanvas.current
      const base = displayRef.current
      if (!d) {
        ghostRef.current = null
        requestDraw()
        return
      }
      const box = canvas?.getBoundingClientRect()
      const over =
        !!box && d.x >= box.left && d.x <= box.right && d.y >= box.top && d.y <= box.bottom
      if (!over || !base || !editableRef.current || !(d.duration > 0)) {
        if (ghostRef.current) {
          ghostRef.current = null
          requestDraw()
        }
        return
      }
      const view = viewRef.current
      const at = Math.max(0, xToTime(view, d.x - box.left))
      const targets = snapTargets(hitClips(base), null, [t.posRef.current, refDurRef.current])
      const tol = snapRef.current ? SNAP_PX / view.pxPerSec : 0
      const wanted = snap(at, targets, tol)
      const slot = findInsertSlot(base, d.duration, wanted, d.duration)
      if (d.dropped) {
        ghostRef.current = null
        if (slot !== null) {
          commit(insertClipFromTake(base, d.takeId, d.duration, slot), base)
        }
        requestDraw()
        return
      }
      ghostRef.current = {
        start: slot ?? wanted,
        duration: d.duration,
        valid: slot !== null,
        label: d.label,
      }
      requestDraw()
    })
  }, [hitClips, t, requestDraw, commit])

  const selectedNow = useCallback(() => {
    const base = displayRef.current
    const id = selRef.current
    if (!base || !id) return null
    return base.clips.find((c) => c.id === id) ?? null
  }, [])

  const selection = useCallback((): ClipSelection | null => {
    const clip = selectedNow()
    if (!clip) return null
    const start = clip.start
    const end = clipEnd(clip)
    const path = refPathRef.current
    const to = Math.min(end, refDurRef.current)
    return {
      clipId: clip.id,
      start,
      end,
      reference:
        path && to > start
          ? { id: clipId.original(path), url: audioUrl(path), from: start, to }
          : null,
    }
  }, [selectedNow])

  const promptFragment = useCallback((): boolean => {
    if (!editableRef.current || !selectedNow()) return false
    setPrompt(true)
    return true
  }, [selectedNow])

  useEffect(() => setPrompt(false), [cue.id, selected])

  useEffect(() => setSelected(null), [preview.source])

  const replaceSource = useCallback(
    (targetId: string, takeId: string, duration: number): boolean => {
      const hasClip = (c: CueComp | null | undefined): c is CueComp => !!c && c.clips.some((x) => x.id === targetId)
      const shown = displayRef.current
      const base = hasClip(shown) ? shown : hasClip(cue.comp) ? cue.comp : null
      if (!base) return false
      const next = replaceClipSource(base, targetId, takeId, duration)
      if (sameComp(next, base)) return false
      pendingRef.current = null
      editRef.current.commit(next)
      if (base === shown) requestDraw()
      return true
    },
    [requestDraw, cue.comp]
  )

  const regionEdge = useCallback(
    (edge: 'in' | 'out'): void => {
      const base = displayRef.current
      if (!base) return
      commit(setRegionEdge(base, edge, t.posRef.current), base)
      requestDraw()
    },
    [commit, t, requestDraw]
  )

  const clearRegion = useCallback((): void => {
    const base = displayRef.current
    if (!base?.region) return
    commit(setRegion(base, null), base)
    requestDraw()
  }, [commit, requestDraw])

  const api = useMemo<CompApi>(
    () => ({
      deleteSelected: removeSelected,
      split: splitAtHead,
      heal: healSelected,
      crossfade: toggleCrossfade,
      undo: () => {
        if (editableRef.current) editRef.current.undo()
      },
      redo: () => {
        if (editableRef.current) editRef.current.redo()
      },
      selection,
      promptFragment,
      replaceSource,
    }),
    [
      removeSelected,
      splitAtHead,
      healSelected,
      toggleCrossfade,
      selection,
      promptFragment,
      replaceSource,
    ]
  )

  useWire(compRef, api)

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
    <div className="tl">
      <div className="tl-body" ref={bodyRef}>
        <canvas
          className="tl-ruler"
          ref={rulerRef}
          onMouseDown={onRulerDown}
          onDoubleClick={onRulerDouble}
          title="Top strip: drag to set the render region · below: drag to scrub · double-click to fit"
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

        <div className="tl-lane comp">
          <canvas
            ref={compCanvas}
            onMouseDown={onCompDown}
            onMouseMove={onCompHover}
            onDoubleClick={(e) => e.stopPropagation()}
          />
          <span className="tl-tag">{laneTag}</span>
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
        <TimelineBar
          onCut={splitAtHead}
          canCut={editable && !!displayComp}
          onHeal={healSelected}
          canHeal={editable && canHealAny}
          onDelete={removeSelected}
          canDelete={editable && !!selectedClip}
          onUndo={() => editRef.current.undo()}
          canUndo={editable && edit.canUndo}
          onRedo={() => editRef.current.redo()}
          canRedo={editable && edit.canRedo}
          onZoomIn={() => zoomBy(1.5)}
          canZoomIn={pxPerSec < MAX_PX_PER_SEC}
          onZoomOut={() => zoomBy(1 / 1.5)}
          canZoomOut={pxPerSec > MIN_PX_PER_SEC}
          onFit={fit}
          snap={snapOn}
          onSnap={() => setSnapOn((v) => !v)}
          onFragment={() => void promptFragment()}
          canFragment={editable && !!selectedClip && !busyClipId}
          onAb={abCompare}
          canAb={!!cue.referenceAudio}
          onCrossfade={toggleCrossfade}
          canCrossfade={editable && xfRoom > 0}
          crossfadeOn={xfNow > 0}
          onReverb={() => toggleFx('reverb')}
          reverbOn={!!selectedClip?.edits.effects?.reverb}
          onDelay={() => toggleFx('delay')}
          delayOn={!!selectedClip?.edits.effects?.delay}
          onPitch={() => toggleFx('pitch')}
          pitchOn={!!selectedClip?.edits.effects?.pitch}
          canFx={editable && !!selectedClip}
          onInsert={insertAtHead}
          canInsert={editable && !!insertable && !!displayComp}
          onSetIn={() => regionEdge('in')}
          onSetOut={() => regionEdge('out')}
          onClearRegion={clearRegion}
          canRegion={editable && !!displayComp && compDur > 0}
          hasRegion={editable && !!displayComp?.region}
        />
        <span className="tl-time" ref={timeRef} />
        {delta !== null && (
          <span
            className={'delta' + (Math.abs(delta) > 0.5 ? ' warn' : '')}
            title="Length difference against the original"
          >
            {}
            Δ {delta >= 0 ? '+' : ''}
            {delta.toFixed(2)}s
          </span>
        )}
      </div>

      <ClipParams
        clip={selectedClip}
        onEdit={onClipEdit}
        onRemove={removeSelected}
        busy={!!busyClipId && busyClipId === selected}
        prompt={prompt}
        onPromptSubmit={(text) => {
          const id = selRef.current
          if (id) onFragmentText(id, text)
        }}
        onPromptClose={() => setPrompt(false)}
      />
    </div>
  )
}
