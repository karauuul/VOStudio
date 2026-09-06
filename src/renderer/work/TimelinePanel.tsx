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
  clipEnd,
  clipTimelineDuration,
  clipTrackId,
  compDelta,
  COMP_EPS,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
  compDuration,
  DEFAULT_CROSSFADE,
  effectiveCrossfade,
  healableAt,
  healCut,
  canHeal,
  maxCrossfade,
  moveClipTo,
  removeClip,
  setClipEdits,
  setCrossfade,
  setRegionEdge,
  slipClip,
  splitClipAt,
  switchClipVersion,
  trimClipEdge,
} from '@shared/comp'
import {
  addTrack,
  clipText,
  clipVersions,
  compTracks,
  resolveTake,
  splitClipByWord,
  updateTrack,
  versionLabel,
  wordSnapPoints,
} from '@shared/library'
import { mergeEffects, toggleEffect } from '@shared/effects'
import {
  clipSpeed,
  DUCK_MAX_DB,
  DUCK_MIN_DB,
  TRACK_GAIN_MAX_DB,
  TRACK_GAIN_MIN_DB,
  type ClipEditPatch,
  type ClipEdits,
  type CompClip,
  type CompTrack,
  type Cue,
  type CueComp,
  type OriginalLane,
  type TimelineViewState,
} from '@shared/domain'
import { audioUrl } from '../api'
import { tryResolveComp } from '../audio/comp-source'
import { reportTakeDuration } from '../audio/duration-backfill'
import { clipId, transport, type TransportState } from '../audio/transport'
import { playback, type PlaybackOps } from '../playback'
import { getPeaks, Wave, type Peaks } from '../Waveform'
import type { EffectName, EffectsTarget } from '../cue/ClipParams'
import { DragNumber } from '../cue/DragNumber'
import {
  clampView,
  fitView,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  snapDelta,
  SNAP_PX,
  tickLabel,
  ticks,
  tickStep,
  timeToX,
  xToTime,
  zoomAt,
  type TimelineView,
} from '../cue/timeline-math'
import { useCompEdit, sameComp } from '../cue/useCompEdit'
import { useWire } from '../cue/useWire'

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
  playhead: () => number
  editSelected: (patch: ClipEditPatch, commit: boolean) => void
  trimSelected: (edge: 'start' | 'end', at: number, commit: boolean) => void
  toggleEffect: (which: EffectName) => void
  setIn: () => void
  setOut: () => void
  zoom: (factor: number) => void
  selectTool: () => void
  place: (next: CueComp) => void
}

export type Tool = 'select' | 'razor' | 'trim' | 'fade' | 'slip'

const STRIP = 190
const STEP_SECONDS = 0.1
const RESCHEDULE_MS = 80
const ORIG_H = 150
const TRACK_H = 165
const EDGE_PX = 6
const FADE_GRAB = 10
const GAIN_SPAN = 24
const GAIN_GRAB = 6
const DEFAULT_DUCK_DB = -12
const TRACK_COLORS = ['var(--l1)', 'var(--l2)']
const WAVE_COLORS = ['#3fb8a8', '#a58cf0']
export const DRAG_TYPE = 'text/vo-source'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function timecode(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

const secs = (sec: number): string => (Number.isFinite(sec) && sec > 0 ? sec.toFixed(2) : '0.00')

const gainTop = (db: number): number => clamp(50 - (db / GAIN_SPAN) * 46, 3, 97)

const zoomToSlider = (px: number): number =>
  Math.round(
    ((Math.log(px) - Math.log(MIN_PX_PER_SEC)) / (Math.log(MAX_PX_PER_SEC) - Math.log(MIN_PX_PER_SEC))) *
      100
  )

const sliderToZoom = (v: number): number =>
  Math.exp(Math.log(MIN_PX_PER_SEC) + (v / 100) * (Math.log(MAX_PX_PER_SEC) - Math.log(MIN_PX_PER_SEC)))

type Gesture = 'move' | 'trimStart' | 'trimEnd' | 'fadeIn' | 'fadeOut' | 'gain' | 'slip' | 'split'

interface Props {
  cue: Cue | null
  cues: Cue[]
  targetTrackId?: string
  onTargetTrack: (trackId: string) => void
  view?: TimelineViewState
  onView: (view: TimelineViewState) => void
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>
  onOriginal: (original: OriginalLane) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  onEffectsTarget: (target: EffectsTarget | null) => void
  compRef: MutableRefObject<CompApi | null>
  busyClipId?: string | null
  onDropSource: (takeId: string, trackId: string, at: number) => void
}

export function TimelinePanel({
  cue,
  cues,
  targetTrackId,
  onTargetTrack,
  view: savedView,
  onView,
  onComp,
  onOriginal,
  onStatus,
  onEffectsTarget,
  compRef,
  busyClipId,
  onDropSource,
}: Props) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLSpanElement>(null)
  const posRef = useRef(0)
  const scrubRef = useRef(false)
  const dragRef = useRef<(() => void) | null>(null)

  const [width, setWidth] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<CueComp | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [snapUnit, setSnapUnit] = useState<'words' | 'off'>('words')
  const [units, setUnits] = useState<'seconds' | 'timecode'>('seconds')
  const [pxPerSec, setPxPerSec] = useState(savedView?.pxPerSec ?? 100)
  const [scroll, setScroll] = useState(savedView?.scroll ?? 0)
  const [origGainDb, setOrigGainDb] = useState(savedView?.originalGainDb ?? 0)
  const [origMuted, setOrigMuted] = useState(false)
  const [origSolo, setOrigSolo] = useState(false)
  const [peaks, setPeaks] = useState<Record<string, Peaks>>({})
  const [gainDrag, setGainDrag] = useState<{ id: string; db: number } | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)

  const cueId = cue?.id ?? ''
  const [shownCue, setShownCue] = useState(cueId)
  if (shownCue !== cueId) {
    setShownCue(cueId)
    setSelected(null)
    setPending(null)
    setPxPerSec(savedView?.pxPerSec ?? 100)
    setScroll(savedView?.scroll ?? 0)
    setOrigGainDb(savedView?.originalGainDb ?? 0)
    setOrigMuted(false)
    setOrigSolo(false)
  }

  const project = useMemo(() => ({ cues }), [cues])
  const editable = !!cue

  const onProblem = useCallback(
    (p: string) => onStatus('err', `Composition rejected: ${p}`),
    [onStatus]
  )
  const edit = useCompEdit(cueId, cue?.comp, onComp, onProblem)

  const stored = useMemo<CueComp>(() => cue?.comp ?? { clips: [] }, [cue?.comp])
  const queued = edit.pending()
  const live = queued === undefined ? stored : (queued ?? { clips: [] })
  const comp = pending ?? live
  const tracks = useMemo(() => compTracks(comp), [comp])

  const view = useMemo<TimelineView>(() => ({ pxPerSec, scroll }), [pxPerSec, scroll])
  const viewRef = useRef(view)
  viewRef.current = view
  const compRefLive = useRef(comp)
  compRefLive.current = comp
  const selRef = useRef<string | null>(null)
  selRef.current = selected

  const refPath = cue?.referenceAudio?.relPath
  const refPeaks = refPath ? (peaks[refPath] ?? null) : null
  const refDur = refPeaks?.duration ?? cue?.referenceDuration ?? 0
  const compDur = compDuration(comp)
  const contentDur = Math.max(refDur, compDur)

  const liveRef = useRef(live)
  liveRef.current = live

  const commit = useCallback(
    (next: CueComp): void => {
      setPending(null)
      if (!editable || sameComp(next, liveRef.current)) return
      edit.commit(next.clips.length > 0 ? next : null)
    },
    [edit, editable]
  )

  const original = cue?.original
  const setOriginal = useCallback(
    (patch: Partial<OriginalLane> & { previewMuted?: true | undefined }): void => {
      const base: OriginalLane = original ?? { exportMode: 'off' }
      const next = { ...base, ...patch }
      if (next.previewMuted !== true) delete next.previewMuted
      onOriginal(next)
    },
    [original, onOriginal]
  )

  useEffect(() => {
    const paths = new Set<string>()
    if (refPath) paths.add(refPath)
    for (const c of comp.clips) {
      const found = cue ? resolveTake(project, cue, c.sourceTakeId) : undefined
      if (found) paths.add(found.take.file.relPath)
    }
    let alive = true
    for (const path of paths) {
      if (peaks[path]) continue
      void getPeaks(path)
        .then((p) => {
          if (!alive) return
          setPeaks((m) => (m[path] ? m : { ...m, [path]: p }))
          const found = cue?.takes.find((t) => t.file.relPath === path)
          if (found && cue) reportTakeDuration(cue.id, found, p.duration)
        })
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [refPath, comp, peaks, cue, project])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) setWidth(el.clientWidth)
    })
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const fittedRef = useRef('')
  useEffect(() => {
    if (fittedRef.current === cueId || savedView || width <= 0 || !(contentDur > 0)) return
    fittedRef.current = cueId
    const v = fitView(contentDur * 1.04, width)
    setPxPerSec(v.pxPerSec)
    setScroll(0)
  }, [cueId, contentDur, width, savedView])

  const takeOf = useCallback(
    (c: CompClip) => (cue ? resolveTake(project, cue, c.sourceTakeId)?.take : undefined),
    [cue, project]
  )

  const transportId = cueId ? clipId.comp(cueId) : null

  const paintHead = useCallback((t: number): void => {
    posRef.current = t
    playback.setPos(t)
    const el = headRef.current
    if (el) el.style.transform = `translateX(${(STRIP + timeToX(viewRef.current, t)).toFixed(2)}px)`
  }, [])

  useEffect(() => {
    paintHead(posRef.current)
  })

  useEffect(() => {
    const apply = (s: TransportState): void => {
      const mine = !!transportId && s.clipId === transportId
      if (mine && !scrubRef.current) paintHead(s.pos)
      setPlayingId(s.playing ? s.clipId : null)
    }
    apply(transport.getState())
    return transport.subscribe(apply)
  }, [transportId, paintHead])

  useEffect(() => {
    paintHead(0)
  }, [cueId, paintHead])

  const anyTrackSolo = tracks.some((t) => t.solo)
  const origAudible =
    !!refPath && original?.previewMuted !== true && !origMuted && (!anyTrackSolo || origSolo)

  const resolved = useMemo(() => {
    if (!cue) return null
    const effective: CompTrack[] =
      origSolo && !anyTrackSolo ? tracks.map((t) => ({ ...t, muted: true })) : tracks
    const r = tryResolveComp(
      project,
      cue,
      comp.clips.length > 0 ? comp : null,
      origAudible && refPath ? { url: audioUrl(refPath), gainDb: origGainDb } : undefined
    )
    return r ? { ...r, tracks: effective } : null
  }, [cue, project, comp, tracks, origSolo, anyTrackSolo, origAudible, refPath, origGainDb])

  const region = comp.region
  const regionIn = region?.in ?? 0
  const regionOut = region?.out ?? compDur
  const delta = compDelta(comp.clips.length > 0 ? comp : undefined, refDur)

  const seek = useCallback(
    (t: number, exact: boolean): void => {
      const v = Math.max(0, t)
      paintHead(v)
      if (!transportId || transport.currentClipId() !== transportId) return
      if (exact) transport.seek(v)
      else transport.scrubTo(v)
    },
    [paintHead, transportId]
  )

  const playFrom = useCallback(
    (at: number): void => {
      if (!resolved || !transportId) return
      paintHead(at)
      void transport.playComp(resolved, { id: transportId, seek: at })
    },
    [resolved, transportId, paintHead]
  )

  const ops = useMemo<PlaybackOps>(
    () => ({
      toggle: () => {
        if (transportId && transport.currentClipId() === transportId && playingId === transportId) {
          transport.pause()
          return
        }
        playFrom(posRef.current)
      },
      restart: () => playFrom(regionIn),
      playClip: () => {
        const c = comp.clips.find((x) => x.id === selRef.current)
        const take = c ? takeOf(c) : undefined
        if (!c || !take) return
        void transport.playComp(
          { clips: [{ clip: { ...c, start: 0 }, url: audioUrl(take.file.relPath) }] },
          { id: 'clip:' + c.id }
        )
      },
      goIn: () => seek(regionIn, true),
      goOut: () => seek(regionOut, true),
      seek: (t) => seek(t, true),
      step: (dir) => {
        const at = posRef.current
        const words =
          cue && comp.clips.some((c) => takeOf(c)?.words)
            ? wordSnapPoints(comp, cue, project)
            : []
        const next =
          dir < 0
            ? [...words].reverse().find((p) => p < at - COMP_EPS)
            : words.find((p) => p > at + COMP_EPS)
        seek(next ?? Math.max(0, at + dir * STEP_SECONDS), true)
      },
    }),
    [transportId, playingId, playFrom, regionIn, regionOut, comp, takeOf, seek, cue, project]
  )

  const audioSig = useMemo(
    () =>
      JSON.stringify([
        tracks.map((t) => [t.id, t.gainDb, t.muted, t.solo, t.effects ?? null]),
        [origAudible, origGainDb, origSolo, origMuted],
        live.clips.map((c) => [
          c.id,
          c.start,
          c.srcIn,
          c.srcOut,
          c.sourceTakeId,
          c.edits,
          c.crossfade ?? 0,
          clipTrackId(c),
        ]),
        live.region ?? null,
      ]),
    [tracks, origAudible, origGainDb, origSolo, origMuted, live]
  )

  const sigRef = useRef(audioSig)
  const rescheduleRef = useRef(0)
  useEffect(() => () => window.clearTimeout(rescheduleRef.current), [])
  useEffect(() => {
    if (sigRef.current === audioSig) return
    sigRef.current = audioSig
    if (!transportId || playingId !== transportId) return
    window.clearTimeout(rescheduleRef.current)
    rescheduleRef.current = window.setTimeout(() => playFrom(posRef.current), RESCHEDULE_MS)
  }, [audioSig, transportId, playingId, playFrom])

  useEffect(() => {
    playback.setOps(ops)
    return () => playback.setOps(null)
  }, [ops])

  const persist = useCallback(
    (next: Partial<TimelineViewState>): void => {
      if (!cueId) return
      onView({
        pxPerSec: viewRef.current.pxPerSec,
        scroll: viewRef.current.scroll,
        ...(origGainDb !== 0 ? { originalGainDb: origGainDb } : {}),
        ...next,
      })
    },
    [cueId, onView, origGainDb]
  )

  const applyView = useCallback(
    (next: TimelineView, save: boolean): void => {
      const v = clampView(next, width, contentDur)
      viewRef.current = v
      setPxPerSec(v.pxPerSec)
      setScroll(v.scroll)
      if (save) onView({ pxPerSec: v.pxPerSec, scroll: v.scroll, ...(origGainDb !== 0 ? { originalGainDb: origGainDb } : {}) })
    },
    [width, contentDur, onView, origGainDb]
  )

  const zoomBy = useCallback(
    (factor: number): void => {
      applyView(zoomAt(viewRef.current, factor, width / 2), true)
    },
    [applyView, width]
  )

  const bodyLeft = useCallback((): number => {
    const el = bodyRef.current
    return el ? el.getBoundingClientRect().left : 0
  }, [])

  useEffect(() => {
    const el = lanesRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.altKey) {
        e.preventDefault()
        applyView(
          zoomAt(viewRef.current, Math.exp(-e.deltaY * 0.0025), e.clientX - bodyLeft()),
          true
        )
        return
      }
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        applyView({ ...viewRef.current, scroll: viewRef.current.scroll + d / viewRef.current.pxPerSec }, true)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [applyView, bodyLeft])

  const startDrag = useCallback(
    (onMove: (ev: MouseEvent) => void, onUp: (ev: MouseEvent) => void): void => {
      const stop = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        dragRef.current = null
      }
      const move = (ev: MouseEvent): void => {
        if (ev.buttons === 0) up(ev)
        else onMove(ev)
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

  useEffect(() => () => dragRef.current?.(), [])

  const startScrub = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0) return
      e.preventDefault()
      scrubRef.current = true
      const at = (clientX: number, exact: boolean): void =>
        seek(Math.max(0, xToTime(viewRef.current, clientX - bodyLeft())), exact)
      startDrag(
        (ev) => at(ev.clientX, false),
        (ev) => {
          at(ev.clientX, true)
          scrubRef.current = false
        }
      )
      at(e.clientX, true)
    },
    [seek, bodyLeft, startDrag]
  )

  const snapPoints = useCallback(
    (excludeId: string | null): number[] => {
      if (snapUnit === 'off' || !cue) return []
      const base = wordSnapPoints(comp, cue, project)
      if (!excludeId) return base
      const c = comp.clips.find((x) => x.id === excludeId)
      if (!c) return base
      const lo = c.start
      const hi = clipEnd(c)
      return base.filter((t) => t <= lo || t >= hi)
    },
    [snapUnit, cue, comp, project]
  )

  const splitClip = useCallback(
    (id: string, at: number): void => {
      if (!cue) return
      const next =
        snapUnit === 'words'
          ? splitClipByWord(comp, cue, project, id, at)
          : splitClipAt(comp, id, at)
      commit(next)
    },
    [cue, comp, project, snapUnit, commit]
  )

  const gestureFor = useCallback(
    (c: CompClip, w: number, h: number, lx: number, ly: number): Gesture => {
      if (tool === 'razor') return 'split'
      if (tool === 'slip') return 'slip'
      if (tool === 'trim') return lx < w / 2 ? 'trimStart' : 'trimEnd'
      if (tool === 'fade') return lx < w / 2 ? 'fadeIn' : 'fadeOut'
      const pps = viewRef.current.pxPerSec
      const fi = c.edits.fadeIn.duration * pps
      const fo = c.edits.fadeOut.duration * pps
      if (ly <= 18) {
        if (Math.abs(lx - fi) <= FADE_GRAB) return 'fadeIn'
        if (Math.abs(lx - (w - fo)) <= FADE_GRAB) return 'fadeOut'
      }
      if (lx <= EDGE_PX) return 'trimStart'
      if (lx >= w - EDGE_PX) return 'trimEnd'
      if (Math.abs(ly - (gainTop(c.edits.gainDb) / 100) * h) <= GAIN_GRAB) return 'gain'
      return 'move'
    },
    [tool]
  )

  const onClipDown = useCallback(
    (e: ReactMouseEvent, c: CompClip): void => {
      if (e.button !== 0 || !editable) return
      e.preventDefault()
      e.stopPropagation()
      setSelected(c.id)
      selRef.current = c.id
      const box = e.currentTarget.getBoundingClientRect()
      const lx = e.clientX - box.left
      const ly = e.clientY - box.top
      const at = xToTime(viewRef.current, e.clientX - bodyLeft())
      const gesture = gestureFor(c, box.width, box.height, lx, ly)
      if (gesture === 'split') {
        splitClip(c.id, at)
        return
      }

      const base = comp
      const x0 = e.clientX
      const y0 = e.clientY
      const targets = snapPoints(c.id)
      const take = takeOf(c)
      const srcDur = (take && peaks[take.file.relPath]?.duration) || take?.duration || Infinity
      const tl = clipTimelineDuration(c)
      let next = base

      const onMove = (ev: MouseEvent): void => {
        const pps = viewRef.current.pxPerSec
        const raw = (ev.clientX - x0) / pps
        const tol = ev.altKey || snapUnit === 'off' ? 0 : SNAP_PX / pps
        if (gesture === 'move') {
          const d = snapDelta([c.start, clipEnd(c)], raw, targets, tol)
          const over = document
            .elementFromPoint(ev.clientX, ev.clientY)
            ?.closest('[data-track]') as HTMLElement | null
          next = moveClipTo(base, c.id, c.start + d, over?.dataset['track'] ?? clipTrackId(c))
        } else if (gesture === 'trimStart' || gesture === 'trimEnd') {
          const edge = gesture === 'trimStart' ? 'start' : 'end'
          const anchor = edge === 'start' ? c.start : clipEnd(c)
          next = trimClipEdge(base, c.id, edge, snapDelta([anchor], raw, targets, tol), srcDur)
        } else if (gesture === 'fadeIn') {
          next = setClipEdits(base, c.id, {
            fadeIn: { ...c.edits.fadeIn, duration: clamp(c.edits.fadeIn.duration + raw, 0, tl) },
          })
        } else if (gesture === 'fadeOut') {
          next = setClipEdits(base, c.id, {
            fadeOut: { ...c.edits.fadeOut, duration: clamp(c.edits.fadeOut.duration - raw, 0, tl) },
          })
        } else if (gesture === 'slip') {
          next = slipClip(base, c.id, -raw, srcDur)
        } else {
          const db = clamp(
            c.edits.gainDb - ((ev.clientY - y0) / box.height) * 2 * GAIN_SPAN,
            GAIN_MIN_DB,
            GAIN_MAX_DB
          )
          next = setClipEdits(base, c.id, { gainDb: db })
          setGainDrag({ id: c.id, db })
        }
        setPending(next)
      }

      startDrag(onMove, () => {
        setGainDrag(null)
        commit(next)
      })
    },
    [
      editable,
      comp,
      gestureFor,
      bodyLeft,
      splitClip,
      snapPoints,
      takeOf,
      peaks,
      snapUnit,
      startDrag,
      commit,
    ]
  )

  const deselect = useCallback(
    (e: ReactMouseEvent): void => {
      setSelected(null)
      selRef.current = null
      startScrub(e)
    },
    [startScrub]
  )

  const onRulerDown = useCallback(
    (e: ReactMouseEvent): void => {
      startScrub(e)
    },
    [startScrub]
  )

  const editTrack = useCallback(
    (trackId: string, patch: Partial<Omit<CompTrack, 'id'>>, doCommit = true): void => {
      const next = updateTrack(comp, trackId, patch)
      if (doCommit) commit(next)
      else setPending(next)
    },
    [comp, commit]
  )

  const switchVersion = useCallback(
    (c: CompClip, takeId: string, duration: number): void => {
      commit(switchClipVersion(comp, c.id, takeId, duration))
    },
    [comp, commit]
  )

  const selectedClip = useMemo(
    () => live.clips.find((c) => c.id === selected) ?? null,
    [live, selected]
  )

  useEffect(() => {
    setSelected((s) => (s && !live.clips.some((c) => c.id === s) ? null : s))
  }, [live])

  const effectsLabel = useMemo(() => {
    if (!selectedClip || !cue) return ''
    const track = tracks.find((t) => t.id === clipTrackId(selectedClip))
    const v = versionLabel(cue, project, selectedClip.sourceTakeId)
    return [track?.name, v].filter(Boolean).join(' · ')
  }, [selectedClip, cue, tracks, project])

  useEffect(() => {
    if (!selectedClip) {
      onEffectsTarget(null)
      return
    }
    const take = takeOf(selectedClip)
    onEffectsTarget({
      label: effectsLabel,
      clip: selectedClip,
      sourceDuration:
        (take && peaks[take.file.relPath]?.duration) || take?.duration || 0,
      busy: busyClipId === selectedClip.id,
    })
  }, [selectedClip, effectsLabel, takeOf, peaks, busyClipId, onEffectsTarget])

  useEffect(() => () => onEffectsTarget(null), [onEffectsTarget])

  const editSelected = useCallback(
    (patch: ClipEditPatch, doCommit: boolean): void => {
      const id = selRef.current
      const base = compRefLive.current
      const c = base.clips.find((x) => x.id === id)
      if (!id || !c) return
      const { effects, ...rest } = patch
      const edits: Partial<ClipEdits> = effects
        ? { ...rest, effects: mergeEffects(c.edits.effects, effects) }
        : rest
      const next = setClipEdits(base, id, edits)
      if (doCommit) commit(next)
      else setPending(next)
    },
    [commit]
  )

  const api = useMemo<CompApi>(
    () => ({
      deleteSelected: () => {
        const id = selRef.current
        const base = compRefLive.current
        if (!editable || !id || !base.clips.some((c) => c.id === id)) return false
        commit(removeClip(base, id))
        setSelected(null)
        return true
      },
      split: () => {
        const base = compRefLive.current
        const id = selRef.current
        const at = posRef.current
        const c =
          base.clips.find((x) => x.id === id && at > x.start && at < clipEnd(x)) ??
          base.clips.find((x) => at > x.start && at < clipEnd(x))
        if (c) splitClip(c.id, at)
      },
      heal: () => {
        const base = compRefLive.current
        const id =
          selRef.current && canHeal(base, selRef.current)
            ? selRef.current
            : healableAt(base, posRef.current, Infinity)
        if (id) commit(healCut(base, id))
      },
      crossfade: () => {
        const base = compRefLive.current
        const id = selRef.current
        if (!id) return
        const i = base.clips.findIndex((c) => c.id === id)
        if (i < 0 || maxCrossfade(base, id) <= 0) return
        const on = effectiveCrossfade(base.clips[i], base.clips[i + 1]) > 0
        commit(setCrossfade(base, id, on ? 0 : DEFAULT_CROSSFADE))
      },
      undo: () => {
        if (editable) edit.undo()
      },
      redo: () => {
        if (editable) edit.redo()
      },
      selection: () => {
        const base = compRefLive.current
        const id = selRef.current
        const c = editable && id ? base.clips.find((x) => x.id === id) : null
        if (!c) return null
        const to = Math.min(clipEnd(c), refDur)
        return {
          clipId: c.id,
          start: c.start,
          end: clipEnd(c),
          reference:
            refPath && to > c.start
              ? { id: clipId.original(refPath), url: audioUrl(refPath), from: c.start, to }
              : null,
        }
      },
      playhead: () => posRef.current,
      editSelected,
      trimSelected: (edge, at, doCommit) => {
        const base = compRefLive.current
        const id = selRef.current
        const c = id ? base.clips.find((x) => x.id === id) : null
        if (!c) return
        const take = takeOf(c)
        const srcDur = (take && peaks[take.file.relPath]?.duration) || take?.duration || Infinity
        const from = edge === 'start' ? c.srcIn : c.srcOut
        const next = trimClipEdge(base, c.id, edge, (at - from) / clipSpeed(c.edits), srcDur)
        if (doCommit) commit(next)
        else setPending(next)
      },
      toggleEffect: (which) => {
        const base = compRefLive.current
        const id = selRef.current
        const c = id ? base.clips.find((x) => x.id === id) : null
        if (!c || !id) return
        const on = !!c.edits.effects?.[which]
        commit(setClipEdits(base, id, { effects: toggleEffect(c.edits.effects, which, !on) }))
      },
      setIn: () => {
        const base = compRefLive.current
        commit(setRegionEdge(base, 'in', posRef.current, refDur))
      },
      setOut: () => {
        const base = compRefLive.current
        commit(setRegionEdge(base, 'out', posRef.current, refDur))
      },
      zoom: zoomBy,
      selectTool: () => setTool('select'),
      place: (next) => commit(next),
    }),
    [editable, commit, edit, splitClip, editSelected, refDur, refPath, takeOf, peaks, zoomBy]
  )

  useWire(compRef, api)

  const step = tickStep(pxPerSec)
  const rulerTicks = width > 0 ? ticks(view, width) : []
  const xOf = (t: number): number => timeToX(view, t)

  const grid = (
    <div
      className="tl-grid"
      style={{ backgroundSize: `${step * pxPerSec}px 100%`, backgroundPositionX: `${xOf(0)}px` }}
    />
  )

  const shade = (from: number, to: number): JSX.Element | null => {
    if (!region) return null
    const a = xOf(from)
    const b = xOf(to)
    return b > a ? <span className="tl-shade" style={{ left: a, width: b - a }} /> : null
  }

  const regionShade = region ? (
    <>
      {shade(0, region.in)}
      {shade(region.out, Math.max(region.out, scroll + width / pxPerSec))}
    </>
  ) : null

  return (
    <section className="panel tl">
      <div className="phd">
        Timeline
        <span className="tl-m">
          <span>in</span>
          {timecode(regionIn)}
          <span>out</span>
          {timecode(regionOut)}
          <span>Δ</span>
          {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`}
        </span>
        <span className="tl-zoom">
          <button className="ico sm" onClick={() => zoomBy(1 / 1.5)} title="-" aria-label="Zoom out">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 8l3 3M3.5 5h3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          <input
            className="tl-range"
            type="range"
            min={0}
            max={100}
            value={zoomToSlider(pxPerSec)}
            aria-label="Zoom"
            onChange={(e) =>
              applyView({ ...viewRef.current, pxPerSec: sliderToZoom(Number(e.target.value)) }, false)
            }
            onMouseUp={() => persist({})}
          />
          <button className="ico sm" onClick={() => zoomBy(1.5)} title="=" aria-label="Zoom in">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 8l3 3M3.5 5h3M5 3.5v3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          <select
            className="field mono tl-units"
            value={units}
            aria-label="Ruler units"
            onChange={(e) => setUnits(e.target.value as 'seconds' | 'timecode')}
          >
            <option value="seconds">Seconds</option>
            <option value="timecode">Timecode</option>
          </select>
        </span>
      </div>

      <div className="tl-rul">
        <div />
        <div className="tl-ruler" onMouseDown={onRulerDown}>
          {rulerTicks.map((t) => (
            <i key={t} style={{ left: xOf(t) }}>
              {units === 'timecode' ? timecode(t) : tickLabel(t, step)}
            </i>
          ))}
          {region && (
            <span className="tl-io" style={{ left: xOf(region.in), width: xOf(region.out) - xOf(region.in) }} />
          )}
        </div>
      </div>

      <div className="tl-lanes" ref={lanesRef}>
        <div className="tl-lane" style={{ ['--c' as string]: 'var(--orig)', height: ORIG_H }}>
          <div className="tl-strip">
            <div className="r1">
              <span className="tl-badge">0</span>
              <span className="tl-nm">Original</span>
              <span className="tl-ms">
                <button
                  className={'tl-sm' + (origSolo ? ' on' : '')}
                  onClick={() => setOrigSolo((v) => !v)}
                  aria-pressed={origSolo}
                >
                  S
                </button>
                <button
                  className={'tl-sm' + (origMuted ? ' on' : '')}
                  onClick={() => setOrigMuted((v) => !v)}
                  aria-pressed={origMuted}
                >
                  M
                </button>
              </span>
              <button
                className={'ico sm' + (original?.previewMuted === true ? '' : ' on')}
                aria-label="Preview the original"
                aria-pressed={original?.previewMuted !== true}
                onClick={() =>
                  setOriginal({
                    previewMuted: original?.previewMuted === true ? undefined : true,
                  })
                }
              >
                <svg width="13" height="12" viewBox="0 0 14 13">
                  <path d="M1 9V7a6 6 0 0 1 12 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <rect x="1" y="8" width="3" height="5" rx="1" fill="currentColor" />
                  <rect x="10" y="8" width="3" height="5" rx="1" fill="currentColor" />
                </svg>
              </button>
            </div>
            <div className="tl-kv">
              <span>Gain</span>
              <DragNumber
                label=""
                value={origGainDb}
                min={TRACK_GAIN_MIN_DB}
                max={TRACK_GAIN_MAX_DB}
                perPx={0.2}
                decimals={1}
                unit="dB"
                onInput={setOrigGainDb}
                onCommit={(v) => {
                  setOrigGainDb(v)
                  persist({ originalGainDb: v })
                }}
              />
            </div>
            <div className="tl-kv">
              <span>Export</span>
              <span className="tl-tg">
                {(['off', 'on'] as const).map((mode) => (
                  <button
                    key={mode}
                    className={original?.exportMode === mode || (!original && mode === 'off') ? 'on' : ''}
                    disabled={!cue}
                    onClick={() =>
                      setOriginal(
                        mode === 'on' && original?.duckDb === undefined
                          ? { exportMode: mode, duckDb: DEFAULT_DUCK_DB }
                          : { exportMode: mode }
                      )
                    }
                  >
                    {mode === 'off' ? 'Off' : 'On'}
                  </button>
                ))}
              </span>
            </div>
            <div className="tl-kv">
              <span>Duck</span>
              <DragNumber
                label=""
                value={original?.duckDb ?? DEFAULT_DUCK_DB}
                min={DUCK_MIN_DB}
                max={DUCK_MAX_DB}
                perPx={0.2}
                decimals={0}
                unit="dB"
                disabled={!cue || original?.exportMode !== 'on'}
                onInput={() => {}}
                onCommit={(v) => setOriginal({ duckDb: v })}
              />
            </div>
            <div className="tl-kv">
              <span>Stems</span>
              <button className="btn sm" disabled>
                Split
              </button>
            </div>
          </div>
          <div className="tl-body" ref={bodyRef} onMouseDown={startScrub}>
            {grid}
            {refPath && refDur > 0 && (
              <div
                className="tl-clip tl-orig"
                style={{ left: xOf(0), width: Math.max(2, refDur * pxPerSec) }}
              >
                <span className="cn">
                  <span className="w">{refPath.split(/[\\/]/).pop()}</span>
                </span>
                <Wave peaks={refPeaks} from={0} to={refDur} color="#8f97a8" />
                <span className="dur">{secs(refDur)}s</span>
              </div>
            )}
            {regionShade}
          </div>
        </div>

        {tracks.map((track, i) => (
          <div
            key={track.id}
            className="tl-lane"
            style={{ ['--c' as string]: TRACK_COLORS[i % TRACK_COLORS.length], height: TRACK_H }}
          >
            <div className="tl-strip">
              <div className="r1">
                <button
                  className={'tl-badge' + (track.id === targetTrackId || (!targetTrackId && i === 0) ? ' on' : '')}
                  onClick={() => onTargetTrack(track.id)}
                  aria-label={`Target track ${i + 1}`}
                >
                  {i + 1}
                </button>
                <input
                  className="tl-nm tl-name"
                  value={track.name}
                  disabled={!cue}
                  onChange={(e) => editTrack(track.id, { name: e.target.value }, false)}
                  onBlur={(e) => editTrack(track.id, { name: e.target.value.trim() || track.name })}
                  onKeyDown={(e) => e.stopPropagation()}
                />
                <span className="tl-ms">
                  <button
                    className={'tl-sm' + (track.solo ? ' on' : '')}
                    aria-pressed={track.solo}
                    disabled={!cue}
                    onClick={() => editTrack(track.id, { solo: !track.solo })}
                  >
                    S
                  </button>
                  <button
                    className={'tl-sm' + (track.muted ? ' on' : '')}
                    aria-pressed={track.muted}
                    disabled={!cue}
                    onClick={() => editTrack(track.id, { muted: !track.muted })}
                  >
                    M
                  </button>
                </span>
              </div>
              <div className="tl-kv">
                <span>Gain</span>
                <DragNumber
                  label=""
                  value={track.gainDb}
                  min={TRACK_GAIN_MIN_DB}
                  max={TRACK_GAIN_MAX_DB}
                  perPx={0.2}
                  decimals={1}
                  unit="dB"
                  disabled={!cue}
                  onInput={(v) => editTrack(track.id, { gainDb: v }, false)}
                  onCommit={(v) => editTrack(track.id, { gainDb: v })}
                />
              </div>
            </div>
            <div
              className="tl-body"
              data-track={track.id}
              onMouseDown={deselect}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(e) => {
                const takeId = e.dataTransfer.getData(DRAG_TYPE)
                if (!takeId) return
                e.preventDefault()
                onDropSource(
                  takeId,
                  track.id,
                  Math.max(0, xToTime(viewRef.current, e.clientX - bodyLeft()))
                )
              }}
            >
              {grid}
              {comp.clips
                .filter((c) => clipTrackId(c) === track.id)
                .map((c) => (
                  <Clip
                    key={c.id}
                    clip={c}
                    cue={cue}
                    project={project}
                    peaks={peaks}
                    view={view}
                    color={WAVE_COLORS[i % WAVE_COLORS.length]}
                    selected={c.id === selected}
                    busy={busyClipId === c.id}
                    gainDrag={gainDrag && gainDrag.id === c.id ? gainDrag.db : null}
                    onDown={onClipDown}
                    onVersion={switchVersion}
                  />
                ))}
              {regionShade}
            </div>
          </div>
        ))}

        <span className="tl-ph" ref={headRef} />
      </div>

      <div className="tl-tools">
        <button className="btn ghost" disabled={!cue} onClick={() => cue && commit(addTrack(comp))}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.6" />
          </svg>
          Add track
        </button>
        <span className="tl-sep" />
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={'ico' + (tool === t.id ? ' on' : '')}
            {...(t.key ? { title: t.key } : {})}
            aria-label={t.name}
            aria-pressed={tool === t.id}
            onClick={() => setTool(t.id)}
          >
            {t.icon}
          </button>
        ))}
        <span className="tl-sep" />
        <button
          className={'ico' + (snapUnit === 'words' ? ' on' : '')}
          aria-label="Snap"
          aria-pressed={snapUnit === 'words'}
          onClick={() => setSnapUnit((v) => (v === 'words' ? 'off' : 'words'))}
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <path d="M4 3h2v8H4zM8 3h2v8H8z" fill="currentColor" />
          </svg>
        </button>
        <select
          className="field mono tl-snap"
          value={snapUnit}
          aria-label="Snap unit"
          onChange={(e) => setSnapUnit(e.target.value as 'words' | 'off')}
        >
          <option value="words">Snap · words</option>
          <option value="off">Snap · off</option>
        </select>
      </div>
    </section>
  )
}

const TOOLS: { id: Tool; name: string; key: string; icon: JSX.Element }[] = [
  {
    id: 'select',
    name: 'Select',
    key: 'V',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M2 1l10 8H7l-2 4z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'razor',
    name: 'Razor',
    key: 'C',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="3.5" cy="10.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="10.5" cy="10.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5 9L12 1M9 9L2 1" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    id: 'trim',
    name: 'Trim',
    key: '',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M4 1v12M10 1v12" stroke="currentColor" strokeWidth="1.4" />
        <path d="M1 7h2M13 7h-2M6 7h2" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    id: 'fade',
    name: 'Fade',
    key: '',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M1 13L13 1v12z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'slip',
    name: 'Slip',
    key: '',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M1 7h12" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
      </svg>
    ),
  },
]

interface ClipProps {
  clip: CompClip
  cue: Cue | null
  project: { cues: Cue[] }
  peaks: Record<string, Peaks>
  view: TimelineView
  color: string
  selected: boolean
  busy: boolean
  gainDrag: number | null
  onDown: (e: ReactMouseEvent, clip: CompClip) => void
  onVersion: (clip: CompClip, takeId: string, duration: number) => void
}

function Clip({
  clip,
  cue,
  project,
  peaks,
  view,
  color,
  selected,
  busy,
  gainDrag,
  onDown,
  onVersion,
}: ClipProps) {
  const found = cue ? resolveTake(project, cue, clip.sourceTakeId) : undefined
  const take = found?.take
  const tl = clipTimelineDuration(clip)
  const left = timeToX(view, clip.start)
  const width = Math.max(2, tl * view.pxPerSec)
  const label = cue && take ? versionLabel(cue, project, take.id) : ''
  const words = take ? clipText(take, clip.srcIn, clip.srcOut) : ''
  const versions = cue && selected && take ? clipVersions(cue, project, take.id) : []
  const speed = clipSpeed(clip.edits)
  const db = gainDrag ?? clip.edits.gainDb

  return (
    <div
      className={'tl-clip' + (selected ? ' sel' : '') + (busy ? ' busy' : '')}
      style={{ left, width }}
      data-clip={clip.id}
      onMouseDown={(e) => onDown(e, clip)}
    >
      <span className="cn">
        {label && <i>{label}</i>}
        <span className="w">{words}</span>
        {versions.length > 1 && (
          <span className="vch">
            {versions.map((v) => (
              <button
                key={v.takeId}
                className={v.current ? 'on' : ''}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  if (!v.current && v.duration > 0) onVersion(clip, v.takeId, v.duration)
                }}
              >
                {v.label}
              </button>
            ))}
          </span>
        )}
      </span>
      <Wave
        peaks={take ? (peaks[take.file.relPath] ?? null) : null}
        from={clip.srcIn}
        to={clip.srcOut}
        color={color}
      />
      {clip.edits.fadeIn.duration > 0 && (
        <span className="fi" style={{ width: (clip.edits.fadeIn.duration / speed) * view.pxPerSec }} />
      )}
      {clip.edits.fadeOut.duration > 0 && (
        <span className="fo" style={{ width: (clip.edits.fadeOut.duration / speed) * view.pxPerSec }} />
      )}
      <span className="gl" style={{ top: `${gainTop(db)}%` }} />
      <span className="dur">
        {gainDrag === null ? `${secs(tl)}s` : `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`}
      </span>
    </div>
  )
}
