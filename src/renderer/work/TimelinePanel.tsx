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
  duckEnvelope,
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
  trackIsFree,
  setClipEdits,
  setCrossfade,
  setRegionEdge,
  slipClip,
  splitClipAt,
  switchClipVersion,
  trackClips,
  trimClipEdge,
} from '@shared/comp'
import {
  addTrack,
  canRemoveTrack,
  clipBoundaries,
  clipText,
  clipVersions,
  compTracks,
  duplicateTrack,
  fitToLength,
  moveTrack,
  removeTrack,
  resolveTake,
  resolveTargetTrack,
  splitClipByWord,
  splitClipIntoWords,
  updateTrack,
  versionLabel,
  wordSnapPoints,
} from '@shared/library'
import {
  clipSpeed,
  DEFAULT_DUCK_DB,
  DUCK_MAX_DB,
  DUCK_MIN_DB,
  nextOriginal,
  TRACK_GAIN_MAX_DB,
  TRACK_GAIN_MIN_DB,
  type ClipEdits,
  type CompClip,
  type CompTrack,
  type Cue,
  type CueComp,
  type OriginalLane,
  type ProjectSource,
  type Stem,
  type TimelineViewState,
} from '@shared/domain'
import { audioUrl } from '../api'
import { tryResolveComp, type ResolvedOriginal } from '../audio/comp-source'
import { reportTakeDuration } from '../audio/duration-backfill'
import { clipId, transport, type TransportState } from '../audio/transport'
import { playback, type PlaybackOps } from '../playback'
import { getPeaks, Wave, type Peaks } from '../Waveform'
import { DragNumber } from '../cue/DragNumber'
import {
  clampPlayhead,
  clampView,
  fitView,
  marqueeHits,
  MAX_PX_PER_SEC,
  MIN_PX_PER_SEC,
  snapDelta,
  SNAP_PX,
  tickLabel,
  ticks,
  tickStep,
  timeToX,
  wheelIntent,
  xToTime,
  zoomAt,
  type TimelineView,
} from '@shared/timeline-math'
import { useCompEdit, sameComp } from '../cue/useCompEdit'
import { useWire } from '../cue/useWire'
import { useContextMenu, type MenuEntry } from '../shell/ContextMenu'
import { hotkeyText, type KeyAction } from '../keyboard'

export interface ClipSelection {
  clipId: string
  start: number
  end: number
  reference: { id: string; url: string; from: number; to: number } | null
}

export interface TimelineSelection {
  kind: 'clip' | 'track' | null
  clip: CompClip | null
  trackId: string
  tracks: CompTrack[]
  region: { in: number; out: number }
}

export interface CompApi {
  deleteSelected: () => boolean
  selectClip: (clipId: string) => void
  splitAt: (clipId: string, at: number) => void
  muteHovered: () => boolean
  soloHovered: () => boolean
  split: () => void
  heal: () => void
  crossfade: () => void
  undo: () => void
  redo: () => void
  selection: () => ClipSelection | null
  playhead: () => number
  editSelected: (patch: Partial<ClipEdits>, commit: boolean) => void
  moveSelected: (start: number, commit: boolean) => void
  trimSelected: (edge: 'start' | 'end', at: number, commit: boolean) => void
  editTrack: (trackId: string, patch: Partial<Omit<CompTrack, 'id'>>, commit: boolean) => void
  fit: (scope: 'clip' | 'track') => void
  setIn: () => void
  setOut: () => void
  setRegion: (edge: 'in' | 'out', at: number) => void
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
const NO_STEMS: Stem[] = []
const TRACK_COLORS = ['var(--l1)', 'var(--l2)']
const WAVE_COLORS = ['#3fb8a8', '#a58cf0']
export const DRAG_TYPE = 'text/vo-source'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function timecode(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`
}

const clockOf = (sec: number): string => {
  const total = Math.round(Number.isFinite(sec) && sec > 0 ? sec : 0)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
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

interface LaneUi {
  solo?: boolean
  muted?: boolean
  noPreview?: boolean
  gainDb?: number
}

interface OriginalRow {
  key: string
  badge: string
  name: string
  path: string
  stem: Stem | null
}

interface Props {
  cue: Cue | null
  cues: Cue[]
  source: ProjectSource | null
  onSelectLine: (cueId: string) => void
  targetTrackId?: string
  onTargetTrack: (trackId: string) => void
  view?: TimelineViewState
  onView: (view: TimelineViewState) => void
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>
  onOriginal: (original: OriginalLane) => void
  onStems: (stems: Stem[] | null) => void
  onSplitStems: () => Promise<void>
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  onSelect: (selection: TimelineSelection | null) => void
  compRef: MutableRefObject<CompApi | null>
  busyClipId?: string | null
  onDropSource: (takeId: string, trackId: string, at: number) => void
  onRegenerateClip: (clipId: string) => void
  onPinSource: (takeId: string, pinned: boolean) => void
  onShowInLibrary: (takeId: string) => void
  onMonitor: (tab: 'program' | 'source') => void
}

export function TimelinePanel({
  cue,
  cues,
  source,
  onSelectLine,
  targetTrackId,
  onTargetTrack,
  view: savedView,
  onView,
  onComp,
  onOriginal,
  onStems,
  onSplitStems,
  onStatus,
  onSelect,
  compRef,
  busyClipId,
  onDropSource,
  onRegenerateClip,
  onPinSource,
  onShowInLibrary,
  onMonitor,
}: Props) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLSpanElement>(null)
  const posRef = useRef(0)
  const extentRef = useRef(0)
  const hoverTrackRef = useRef<string | null>(null)
  const scrubRef = useRef(false)
  const dragRef = useRef<(() => void) | null>(null)

  const [width, setWidth] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [pending, setPending] = useState<CueComp | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [snapUnit, setSnapUnit] = useState<'words' | 'off'>('words')
  const [units, setUnits] = useState<'seconds' | 'timecode'>(cue?.region ? 'timecode' : 'seconds')
  const [pxPerSec, setPxPerSec] = useState(savedView?.pxPerSec ?? 100)
  const [scroll, setScroll] = useState(savedView?.scroll ?? 0)
  const [origGainDb, setOrigGainDb] = useState(savedView?.originalGainDb ?? 0)
  const [laneUi, setLaneUi] = useState<Record<string, LaneUi>>({})
  const [armSplit, setArmSplit] = useState(false)
  const [splitting, setSplitting] = useState(false)
  const [peaks, setPeaks] = useState<Record<string, Peaks>>({})
  const [gainDrag, setGainDrag] = useState<{ id: string; db: number } | null>(null)
  const [pickedTrack, setPickedTrack] = useState<string | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)

  const cueId = cue?.id ?? ''
  const [shownCue, setShownCue] = useState(cueId)
  if (shownCue !== cueId) {
    setShownCue(cueId)
    setSelected([])
    setPickedTrack(null)
    setPending(null)
    setPxPerSec(savedView?.pxPerSec ?? 100)
    setScroll(savedView?.scroll ?? 0)
    setOrigGainDb(savedView?.originalGainDb ?? 0)
    setLaneUi({})
    setArmSplit(false)
    setUnits(cue?.region ? 'timecode' : 'seconds')
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
  const selRef = useRef<string[]>(selected)
  selRef.current = selected
  const selId = useCallback((): string | null => selRef.current[selRef.current.length - 1] ?? null, [])

  const srcRegion = cue?.region ?? null
  const lineSource = srcRegion && source && source.id === srcRegion.sourceId ? source : null
  const refPath = lineSource ? lineSource.file.relPath : cue?.referenceAudio?.relPath
  const refPeaks = refPath ? (peaks[refPath] ?? null) : null
  const regionBase = srcRegion ? srcRegion.in : 0
  const refDur = srcRegion
    ? srcRegion.out - srcRegion.in
    : (refPeaks?.duration ?? cue?.referenceDuration ?? 0)
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
      onOriginal(nextOriginal(original, patch))
    },
    [original, onOriginal]
  )

  useEffect(() => {
    const paths = new Set<string>()
    if (refPath) paths.add(refPath)
    for (const stem of cue?.stems ?? NO_STEMS) paths.add(stem.file.relPath)
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

  const paintHead = useCallback((t: number): number => {
    const at = clampPlayhead(t, extentRef.current)
    posRef.current = at
    playback.setPos(at)
    const el = headRef.current
    if (el) el.style.transform = `translateX(${(STRIP + timeToX(viewRef.current, at)).toFixed(2)}px)`
    return at
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

  const stems = cue?.stems ?? NO_STEMS

  const originalRows = useMemo<OriginalRow[]>(
    () =>
      stems.length > 0
        ? stems.map((stem, i) => ({
            key: stem.id,
            badge: `0${String.fromCharCode(97 + i)}`,
            name: stem.name,
            path: stem.file.relPath,
            stem,
          }))
        : [{ key: 'original', badge: '0', name: 'Original', path: refPath ?? '', stem: null }],
    [stems, refPath]
  )

  const anyTrackSolo = tracks.some((t) => t.solo)
  const anyLaneSolo = originalRows.some((row) => laneUi[row.key]?.solo === true)

  const laneDuck = useCallback(
    (row: OriginalRow): number | undefined => {
      const lane = row.stem ?? original
      return lane?.exportMode === 'on' ? lane.duckDb : undefined
    },
    [original]
  )

  const originals = useMemo<ResolvedOriginal[]>(() => {
    const soloed = anyTrackSolo || anyLaneSolo
    const out: ResolvedOriginal[] = []
    for (const row of originalRows) {
      const ui = laneUi[row.key] ?? {}
      const audible =
        !!row.path &&
        (row.stem ? ui.noPreview !== true : original?.previewMuted !== true) &&
        ui.muted !== true &&
        (!soloed || ui.solo === true)
      if (!audible) continue
      const duckDb = laneDuck(row)
      out.push({
        url: audioUrl(row.path),
        gainDb: row.stem ? (ui.gainDb ?? 0) : origGainDb,
        ...(!row.stem && srcRegion ? { offset: srcRegion.in, duration: refDur } : {}),
        ...(duckDb === undefined ? {} : { duckDb }),
      })
    }
    return out
  }, [originalRows, laneUi, anyTrackSolo, anyLaneSolo, original, laneDuck, origGainDb, srcRegion, refDur])

  const resolved = useMemo(() => {
    if (!cue) return null
    const effective: CompTrack[] =
      anyLaneSolo && !anyTrackSolo ? tracks.map((t) => ({ ...t, muted: true })) : tracks
    const r = tryResolveComp(project, cue, comp.clips.length > 0 ? comp : null, originals)
    return r ? { ...r, tracks: effective } : null
  }, [cue, project, comp, tracks, anyLaneSolo, anyTrackSolo, originals])

  const region = comp.region
  const regionIn = region?.in ?? 0
  const regionOut = region?.out ?? (compDur > 0 ? compDur : refDur)
  extentRef.current = Math.max(regionOut, contentDur)
  const rawDelta = compDelta(comp.clips.length > 0 ? comp : undefined, refDur)
  const delta = rawDelta !== null && Math.abs(rawDelta) < COMP_EPS ? 0 : rawDelta

  const seek = useCallback(
    (t: number, exact: boolean): void => {
      const v = paintHead(t)
      if (!transportId || transport.currentClipId() !== transportId) return
      if (exact) transport.seek(v)
      else transport.scrubTo(v)
    },
    [paintHead, transportId]
  )

  const playFrom = useCallback(
    (at: number): void => {
      if (!resolved || !transportId) return
      void transport.playComp(resolved, { id: transportId, seek: paintHead(at) })
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
        const c = comp.clips.find((x) => x.id === selId())
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
    [transportId, playingId, playFrom, regionIn, regionOut, comp, takeOf, seek, selId, cue, project]
  )

  const audioSig = useMemo(
    () =>
      JSON.stringify([
        tracks.map((t) => [t.id, t.gainDb, t.muted, t.solo, t.effects ?? null]),
        originals,
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
    [tracks, originals, live]
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
      e.preventDefault()
      const intent = wheelIntent(e, viewRef.current.pxPerSec)
      if (intent.kind === 'zoom') {
        applyView(zoomAt(viewRef.current, intent.factor, e.clientX - bodyLeft()), true)
      } else if (intent.kind === 'scrollY') {
        el.scrollTop += intent.pixels
      } else {
        applyView({ ...viewRef.current, scroll: viewRef.current.scroll + intent.seconds }, true)
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
        seek(xToTime(viewRef.current, clientX - bodyLeft()), exact)
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
      const picked = e.shiftKey
        ? selRef.current.includes(c.id)
          ? selRef.current.filter((id) => id !== c.id)
          : [...selRef.current, c.id]
        : [c.id]
      setSelected(picked)
      setPickedTrack(null)
      selRef.current = picked
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

  const startMarquee = useCallback(
    (e: ReactMouseEvent): void => {
      const el = lanesRef.current
      if (!el) return
      e.preventDefault()
      const base = e.shiftKey ? selRef.current : []
      selRef.current = base
      setSelected(base)
      setPickedTrack(null)
      const box = el.getBoundingClientRect()
      const x0 = e.clientX
      const y0 = e.clientY
      const t0 = xToTime(viewRef.current, x0 - bodyLeft())
      startDrag(
        (ev) => {
          const top = Math.min(y0, ev.clientY)
          const bottom = Math.max(y0, ev.clientY)
          setMarquee({
            x: Math.min(x0, ev.clientX) - box.left,
            y: top - box.top + el.scrollTop,
            w: Math.abs(ev.clientX - x0),
            h: bottom - top,
          })
          const lanes = Array.from(el.querySelectorAll<HTMLElement>('[data-track]'))
            .filter((n) => {
              const r = n.getBoundingClientRect()
              return r.bottom > top && r.top < bottom
            })
            .map((n) => n.dataset['track'] ?? '')
          const hits = marqueeHits(
            compRefLive.current.clips.map((c) => ({
              id: c.id,
              start: c.start,
              end: clipEnd(c),
              trackId: clipTrackId(c),
            })),
            t0,
            xToTime(viewRef.current, ev.clientX - bodyLeft()),
            lanes
          )
          const next = [...base, ...hits.filter((id) => !base.includes(id))]
          selRef.current = next
          setSelected(next)
        },
        () => setMarquee(null)
      )
    },
    [bodyLeft, startDrag]
  )

  const startPan = useCallback(
    (e: ReactMouseEvent): void => {
      const el = lanesRef.current
      if (!el) return
      e.preventDefault()
      let lastX = e.clientX
      let lastY = e.clientY
      el.style.cursor = 'grabbing'
      startDrag(
        (ev) => {
          const v = viewRef.current
          applyView({ ...v, scroll: v.scroll - (ev.clientX - lastX) / v.pxPerSec }, false)
          el.scrollTop -= ev.clientY - lastY
          lastX = ev.clientX
          lastY = ev.clientY
        },
        () => {
          el.style.cursor = ''
          persist({})
        }
      )
    },
    [applyView, persist, startDrag]
  )

  const openClip = useCallback(
    (c: CompClip): void => {
      const take = takeOf(c)
      if (!take) return
      onShowInLibrary(take.id)
      onMonitor('source')
    },
    [takeOf, onShowInLibrary, onMonitor]
  )

  const onLanesDown = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button === 1) {
        startPan(e)
        return
      }
      if (e.button !== 0) return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest('.tl-strip') || t?.closest('[data-clip]')) return
      startMarquee(e)
    },
    [startPan, startMarquee]
  )

  const onRulerDown = useCallback(
    (e: ReactMouseEvent): void => {
      onMonitor('program')
      startScrub(e)
    },
    [onMonitor, startScrub]
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
    () => live.clips.find((c) => c.id === selected[selected.length - 1]) ?? null,
    [live, selected]
  )

  useEffect(() => {
    setSelected((s) => {
      const next = s.filter((id) => live.clips.some((c) => c.id === id))
      return next.length === s.length ? s : next
    })
  }, [live])

  const liveTracks = useMemo(() => compTracks(live), [live])

  useEffect(() => {
    if (!cue) {
      onSelect(null)
      return
    }
    onSelect({
      kind: selectedClip ? 'clip' : pickedTrack ? 'track' : null,
      clip: selectedClip,
      trackId: selectedClip
        ? clipTrackId(selectedClip)
        : resolveTargetTrack(live, pickedTrack ?? targetTrackId),
      tracks: liveTracks,
      region: { in: regionIn, out: regionOut },
    })
  }, [
    cue,
    selectedClip,
    pickedTrack,
    targetTrackId,
    live,
    liveTracks,
    regionIn,
    regionOut,
    onSelect,
  ])

  useEffect(() => () => onSelect(null), [onSelect])

  const editSelected = useCallback(
    (patch: Partial<ClipEdits>, doCommit: boolean): void => {
      const id = selId()
      const base = compRefLive.current
      if (!id || !base.clips.some((x) => x.id === id)) return
      const next = setClipEdits(base, id, patch)
      if (doCommit) commit(next)
      else setPending(next)
    },
    [commit, selId]
  )

  const originalLength = cue?.region ? cue.region.out - cue.region.in : refDur

  const doFit = useCallback(
    (clipIds: string[]): void => {
      const result = fitToLength(compRefLive.current, clipIds, originalLength)
      if ('refused' in result) onStatus('err', result.refused)
      else commit(result.comp)
    },
    [originalLength, onStatus, commit]
  )

  const runSplit = useCallback((): void => {
    if (!armSplit) {
      setArmSplit(true)
      return
    }
    setArmSplit(false)
    setSplitting(true)
    void onSplitStems()
      .catch((e: unknown) => onStatus('err', e instanceof Error ? e.message : String(e)))
      .finally(() => setSplitting(false))
  }, [armSplit, onSplitStems, onStatus])

  const api = useMemo<CompApi>(
    () => ({
      selectClip: (id) => {
        if (!compRefLive.current.clips.some((c) => c.id === id)) return
        setSelected([id])
        selRef.current = [id]
        setPickedTrack(null)
      },
      splitAt: (id, at) => splitClip(id, at),
      muteHovered: () => {
        const id = hoverTrackRef.current
        const t = id ? compTracks(compRefLive.current).find((x) => x.id === id) : undefined
        if (!t) return false
        editTrack(t.id, { muted: !t.muted })
        return true
      },
      soloHovered: () => {
        const id = hoverTrackRef.current
        const t = id ? compTracks(compRefLive.current).find((x) => x.id === id) : undefined
        if (!t) return false
        editTrack(t.id, { solo: !t.solo })
        return true
      },
      deleteSelected: () => {
        const base = compRefLive.current
        const ids = selRef.current.filter((id) => base.clips.some((c) => c.id === id))
        if (!editable || ids.length === 0) return false
        commit(ids.reduce(removeClip, base))
        setSelected([])
        return true
      },
      split: () => {
        const base = compRefLive.current
        const id = selId()
        const at = posRef.current
        const c =
          base.clips.find((x) => x.id === id && at > x.start && at < clipEnd(x)) ??
          base.clips.find((x) => at > x.start && at < clipEnd(x))
        if (c) splitClip(c.id, at)
      },
      heal: () => {
        const base = compRefLive.current
        const picked = selId()
        const id =
          picked && canHeal(base, picked) ? picked : healableAt(base, posRef.current, Infinity)
        if (id) commit(healCut(base, id))
      },
      crossfade: () => {
        const base = compRefLive.current
        const id = selId()
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
        const id = selId()
        const c = editable && id ? base.clips.find((x) => x.id === id) : null
        if (!c) return null
        const to = Math.min(clipEnd(c), refDur)
        return {
          clipId: c.id,
          start: c.start,
          end: clipEnd(c),
          reference:
            refPath && to > c.start
              ? {
                  id: clipId.original(refPath),
                  url: audioUrl(refPath),
                  from: regionBase + c.start,
                  to: regionBase + to,
                }
              : null,
        }
      },
      playhead: () => posRef.current,
      editSelected,
      moveSelected: (start, doCommit) => {
        const base = compRefLive.current
        const id = selId()
        if (!id || !base.clips.some((x) => x.id === id)) return
        const next = moveClipTo(base, id, start)
        if (doCommit) commit(next)
        else setPending(next)
      },
      trimSelected: (edge, at, doCommit) => {
        const base = compRefLive.current
        const id = selId()
        const c = id ? base.clips.find((x) => x.id === id) : null
        if (!c) return
        const take = takeOf(c)
        const srcDur = (take && peaks[take.file.relPath]?.duration) || take?.duration || Infinity
        const from = edge === 'start' ? c.start : clipEnd(c)
        const next = trimClipEdge(base, c.id, edge, at - from, srcDur)
        if (doCommit) commit(next)
        else setPending(next)
      },
      editTrack,
      fit: (scope) => {
        const base = compRefLive.current
        const id = selId()
        const c = id ? base.clips.find((x) => x.id === id) : null
        if (!c) return
        doFit(scope === 'track' ? trackClips(base, clipTrackId(c)).map((x) => x.id) : [c.id])
      },
      setIn: () => {
        const base = compRefLive.current
        commit(setRegionEdge(base, 'in', posRef.current, refDur))
      },
      setOut: () => {
        const base = compRefLive.current
        commit(setRegionEdge(base, 'out', posRef.current, refDur))
      },
      setRegion: (edge, at) => {
        commit(setRegionEdge(compRefLive.current, edge, at, refDur))
      },
      zoom: zoomBy,
      selectTool: () => setTool('select'),
      place: (next) => commit(next),
    }),
    [
      editable,
      commit,
      edit,
      splitClip,
      editSelected,
      editTrack,
      doFit,
      refDur,
      refPath,
      regionBase,
      selId,
      takeOf,
      peaks,
      zoomBy,
    ]
  )

  useWire(compRef, api)

  const menu = useContextMenu()

  const clipMenu = useCallback(
    (c: CompClip): MenuEntry[] => {
      const take = takeOf(c)
      const versions = cue && take ? clipVersions(cue, project, take.id) : []
      const at = posRef.current
      const words = cue ? clipBoundaries(comp, cue, project, c.id) : []
      const free = (t: CompTrack): boolean =>
        t.id === clipTrackId(c) ||
        trackIsFree(comp, t.id, c.start, clipEnd(c), c.id)
      return [
        { label: 'Play clip', hotkey: hotkeyText('playClip'), onClick: () => ops.playClip() },
        {
          label: 'Regenerate',
          hotkey: hotkeyText('generate'),
          onClick: () => onRegenerateClip(c.id),
        },
        {
          label: 'Version',
          disabled: versions.length === 0,
          submenu: [
            ...versions.map((v) => ({
              label: v.label,
              hotkey: `${v.duration.toFixed(2)}s`,
              checked: v.current,
              disabled: v.duration <= 0,
              onClick: () => switchVersion(c, v.takeId, v.duration),
            })),
            { sep: true } as MenuEntry,
            { label: 'New from text…', checked: false, onClick: () => onRegenerateClip(c.id) },
          ],
        },
        { sep: true },
        {
          label: 'Split at playhead',
          hotkey: hotkeyText('splitClip'),
          disabled: !(at > c.start + COMP_EPS && at < clipEnd(c) - COMP_EPS),
          onClick: () => splitClip(c.id, at),
        },
        {
          label: 'Split by words',
          disabled: words.length === 0,
          onClick: () => cue && commit(splitClipIntoWords(comp, cue, project, c.id)),
        },
        {
          label: 'Fit to original length',
          disabled: !(originalLength > 0),
          onClick: () => doFit([c.id]),
        },
        {
          label: 'Reset fades and gain',
          onClick: () =>
            commit(
              setClipEdits(comp, c.id, {
                gainDb: 0,
                fadeIn: { ...c.edits.fadeIn, duration: 0 },
                fadeOut: { ...c.edits.fadeOut, duration: 0 },
              })
            ),
        },
        { sep: true },
        {
          label: 'Move to track',
          submenu: [
            ...tracks.map((t) => ({
              label: t.name,
              checked: t.id === clipTrackId(c),
              disabled: !free(t),
              onClick: () => commit(moveClipTo(comp, c.id, c.start, t.id)),
            })),
            { sep: true } as MenuEntry,
            {
              label: 'New track',
              checked: false,
              onClick: () => {
                const grown = addTrack(comp)
                const added = compTracks(grown)[compTracks(grown).length - 1]
                commit(moveClipTo(grown, c.id, c.start, added.id))
              },
            },
          ],
        },
        {
          label: take?.pinned === true ? 'Unpin source' : 'Pin source to all lines',
          disabled: !take,
          onClick: () => take && onPinSource(take.id, take.pinned !== true),
        },
        {
          label: 'Show in Library',
          disabled: !take,
          onClick: () => take && onShowInLibrary(take.id),
        },
        { sep: true },
        {
          label: 'Delete',
          hotkey: hotkeyText('deleteClip'),
          danger: true,
          onClick: () => commit(removeClip(comp, c.id)),
        },
      ]
    },
    [
      cue,
      project,
      comp,
      tracks,
      takeOf,
      ops,
      onRegenerateClip,
      onPinSource,
      onShowInLibrary,
      switchVersion,
      splitClip,
      commit,
      doFit,
      originalLength,
    ]
  )

  const trackMenu = useCallback(
    (track: CompTrack, index: number): MenuEntry[] => [
      {
        label: 'Rename',
        onClick: () =>
          lanesRef.current
            ?.querySelector<HTMLInputElement>(`[data-strip="${track.id}"] .tl-name`)
            ?.select(),
      },
      { label: 'Set as target', onClick: () => onTargetTrack(track.id) },
      {
        label: 'Mute',
        hotkey: hotkeyText('muteTrack'),
        onClick: () => editTrack(track.id, { muted: !track.muted }),
      },
      {
        label: 'Solo',
        hotkey: hotkeyText('soloTrack'),
        onClick: () => editTrack(track.id, { solo: !track.solo }),
      },
      { sep: true },
      { label: 'Track effects…', onClick: () => setPickedTrack(track.id) },
      {
        label: 'Fit to original length',
        disabled: !(originalLength > 0) || trackClips(comp, track.id).length === 0,
        onClick: () => doFit(trackClips(comp, track.id).map((c) => c.id)),
      },
      { label: 'Duplicate track', onClick: () => commit(duplicateTrack(comp, track.id)) },
      {
        label: 'Move up',
        disabled: index === 0,
        onClick: () => commit(moveTrack(comp, track.id, -1)),
      },
      {
        label: 'Move down',
        disabled: index === tracks.length - 1,
        onClick: () => commit(moveTrack(comp, track.id, 1)),
      },
      { sep: true },
      {
        label: 'Delete track',
        danger: true,
        disabled: !canRemoveTrack(comp, track.id),
        onClick: () => commit(removeTrack(comp, track.id)),
      },
    ],
    [comp, tracks, targetTrackId, onTargetTrack, editTrack, commit, doFit, originalLength]
  )

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

  const originalName = lineSource
    ? `${lineSource.name} · ${timecode(regionBase)} – ${timecode(regionBase + refDur)}`
    : (refPath ?? '').split(/[/\\]/).pop()

  const visibleFrom = Math.max(0, regionBase + scroll)
  const visibleTo = lineSource
    ? Math.min(lineSource.duration, regionBase + scroll + (width > 0 ? width / pxPerSec : 0))
    : 0
  const context =
    lineSource && visibleTo > visibleFrom ? (
      <div
        className="tl-ctx"
        style={{
          left: xOf(visibleFrom - regionBase),
          width: Math.max(2, (visibleTo - visibleFrom) * pxPerSec),
        }}
      >
        <Wave peaks={refPeaks} from={visibleFrom} to={visibleTo} color="#8f97a8" />
      </div>
    ) : null

  const navRegions = useMemo(
    () =>
      lineSource
        ? cues
            .filter((c) => c.region?.sourceId === lineSource.id)
            .sort((a, b) => (a.region?.in ?? 0) - (b.region?.in ?? 0))
        : [],
    [cues, lineSource]
  )

  const navRef = useRef<HTMLDivElement>(null)

  const navScroll = useCallback(
    (dx: number): void => {
      const el = navRef.current
      if (!el || !lineSource) return
      applyView(
        {
          ...viewRef.current,
          scroll: viewRef.current.scroll + (dx / el.clientWidth) * lineSource.duration,
        },
        true
      )
    },
    [applyView, lineSource]
  )

  const navigator =
    lineSource && lineSource.duration > 0 ? (
      <div className="tl-nav">
        <div className="n">{`${lineSource.name} · ${clockOf(lineSource.duration)}`}</div>
        <div
          className="bar"
          ref={navRef}
          onMouseDown={(e) => {
            if (e.button !== 0) return
            e.preventDefault()
            let last = e.clientX
            let moved = false
            startDrag(
              (ev) => {
                if (Math.abs(ev.clientX - last) < 1) return
                moved = true
                navScroll(ev.clientX - last)
                last = ev.clientX
              },
              (ev) => {
                if (moved) return
                const el = navRef.current
                if (!el) return
                const at =
                  ((ev.clientX - el.getBoundingClientRect().left) / el.clientWidth) *
                  lineSource.duration
                const hit =
                  navRegions.find((c) => at >= (c.region?.in ?? 0) && at <= (c.region?.out ?? 0)) ??
                  navRegions.reduce<Cue | null>(
                    (best, c) =>
                      best === null ||
                      Math.abs((c.region?.in ?? 0) - at) < Math.abs((best.region?.in ?? 0) - at)
                        ? c
                        : best,
                    null
                  )
                if (hit) onSelectLine(hit.id)
              }
            )
          }}
        >
          {navRegions.map((c) => (
            <i
              key={c.id}
              className={c.id === cueId ? 'cur' : ''}
              style={{
                left: `${((c.region?.in ?? 0) / lineSource.duration) * 100}%`,
                width: `${Math.max(0.15, ((c.region?.out ?? 0) - (c.region?.in ?? 0)) / lineSource.duration * 100)}%`,
              }}
            />
          ))}
          <span
            className="vp"
            style={{
              left: `${(Math.max(0, visibleFrom) / lineSource.duration) * 100}%`,
              width: `${Math.max(0.4, ((visibleTo - visibleFrom) / lineSource.duration) * 100)}%`,
            }}
          />
        </div>
      </div>
    ) : null

  const regionShade = region ? (
    <>
      {shade(0, region.in)}
      {shade(region.out, Math.max(region.out, scroll + width / pxPerSec))}
    </>
  ) : null

  return (
    <section className={'panel tl' + (navigator ? ' tl-hasnav' : '')}>
      <div className="phd">
        Timeline
        <span className="tl-m">
          <span>in</span>
          {timecode(regionBase + regionIn)}
          <span>out</span>
          {timecode(regionBase + regionOut)}
          <span>Δ</span>
          {delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`}
        </span>
        <span className="tl-zoom">
          <button className="ico sm" onClick={() => zoomBy(1 / 1.5)} data-hk="zoomOut" aria-label="Zoom out">
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
            data-hint="Zoom"
            onChange={(e) =>
              applyView({ ...viewRef.current, pxPerSec: sliderToZoom(Number(e.target.value)) }, false)
            }
            onMouseUp={() => persist({})}
          />
          <button className="ico sm" onClick={() => zoomBy(1.5)} data-hk="zoomIn" aria-label="Zoom in">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M8 8l3 3M3.5 5h3M5 3.5v3" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
          <select
            className="field mono tl-units"
            value={units}
            aria-label="Ruler units"
            data-hint="Ruler units"
            onChange={(e) => setUnits(e.target.value as 'seconds' | 'timecode')}
          >
            <option value="seconds">Seconds</option>
            <option value="timecode">Timecode</option>
          </select>
        </span>
      </div>

      {navigator}

      <div className="tl-rul">
        <div />
        <div className="tl-ruler" onMouseDown={onRulerDown}>
          {rulerTicks.map((t) => (
            <i key={t} style={{ left: xOf(t) }}>
              {units === 'timecode' ? timecode(regionBase + t) : tickLabel(t, step)}
            </i>
          ))}
          {region && (
            <span className="tl-io" style={{ left: xOf(region.in), width: xOf(region.out) - xOf(region.in) }} />
          )}
        </div>
      </div>

      <div
        className="tl-lanes"
        ref={lanesRef}
        onMouseDownCapture={(e) => {
          if (e.button === 0) onMonitor('program')
        }}
        onMouseDown={onLanesDown}
      >
        {originalRows.map((row, i) => {
          const ui = laneUi[row.key] ?? {}
          const stem = row.stem
          const setUi = (patch: LaneUi): void =>
            setLaneUi((m) => ({ ...m, [row.key]: { ...(m[row.key] ?? {}), ...patch } }))
          const setStem = (patch: Partial<Stem>): void => {
            if (stem) onStems(stems.map((x) => (x.id === stem.id ? { ...x, ...patch } : x)))
          }
          const mode = stem ? stem.exportMode : (original?.exportMode ?? 'off')
          const previewOn = stem ? ui.noPreview !== true : original?.previewMuted !== true
          const duckDb = laneDuck(row)
          const curve = duckDb === undefined ? [] : duckEnvelope(comp.clips, duckDb)
          const lanePeaks = row.path ? (peaks[row.path] ?? null) : null
          const laneDur = stem ? (lanePeaks?.duration ?? refDur) : refDur
          const laneFrom = stem ? 0 : regionBase
          return (
            <div
              key={row.key}
              className="tl-lane"
              style={{ ['--c' as string]: 'var(--orig)', height: ORIG_H }}
            >
              <div
                className="tl-strip"
                onContextMenu={(e) =>
                  menu.open(e, [
                    { label: 'Merge', disabled: stems.length === 0, onClick: () => onStems(null) },
                  ])
                }
              >
                <div className="r1">
                  <span className="tl-badge">{row.badge}</span>
                  <span className="tl-nm">{row.name}</span>
                  <span className="tl-ms">
                    <button
                      className={'tl-sm' + (ui.solo === true ? ' on' : '')}
                      data-hint="Solo"
                      onClick={() => setUi({ solo: ui.solo !== true })}
                      aria-pressed={ui.solo === true}
                    >
                      S
                    </button>
                    <button
                      className={'tl-sm' + (ui.muted === true ? ' on' : '')}
                      data-hint="Mute"
                      onClick={() => setUi({ muted: ui.muted !== true })}
                      aria-pressed={ui.muted === true}
                    >
                      M
                    </button>
                  </span>
                  <button
                    className={'ico sm' + (previewOn ? ' on' : '')}
                    aria-label={`Preview ${row.name}`}
                    data-hint="Preview"
                    aria-pressed={previewOn}
                    onClick={() =>
                      stem
                        ? setUi({ noPreview: ui.noPreview !== true })
                        : setOriginal({
                            previewMuted: original?.previewMuted === true ? undefined : true,
                          })
                    }
                  >
                    <svg width="13" height="12" viewBox="0 0 14 13">
                      <path
                        d="M1 9V7a6 6 0 0 1 12 0v2"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <rect x="1" y="8" width="3" height="5" rx="1" fill="currentColor" />
                      <rect x="10" y="8" width="3" height="5" rx="1" fill="currentColor" />
                    </svg>
                  </button>
                </div>
                <div className="tl-kv">
                  <span>Gain</span>
                  <DragNumber
                    label=""
                    value={stem ? (ui.gainDb ?? 0) : origGainDb}
                    min={TRACK_GAIN_MIN_DB}
                    max={TRACK_GAIN_MAX_DB}
                    perPx={0.2}
                    decimals={1}
                    unit="dB"
                    onInput={(v) => (stem ? setUi({ gainDb: v }) : setOrigGainDb(v))}
                    onCommit={(v) => {
                      if (stem) {
                        setUi({ gainDb: v })
                        return
                      }
                      setOrigGainDb(v)
                      persist({ originalGainDb: v })
                    }}
                  />
                </div>
                <div className="tl-kv">
                  <span>Export</span>
                  <span className="tl-tg">
                    {(['off', 'on'] as const).map((m) => (
                      <button
                        key={m}
                        className={mode === m ? 'on' : ''}
                        disabled={!cue}
                        onClick={() => {
                          const needsDuck =
                            m === 'on' && (stem ? stem.duckDb : original?.duckDb) === undefined
                          const patch = needsDuck
                            ? { exportMode: m, duckDb: DEFAULT_DUCK_DB }
                            : { exportMode: m }
                          if (stem) setStem(patch)
                          else setOriginal(patch)
                        }}
                      >
                        {m === 'off' ? 'Off' : 'On'}
                      </button>
                    ))}
                  </span>
                </div>
                <div className="tl-kv">
                  <span>Duck</span>
                  <DragNumber
                    label=""
                    value={(stem ? stem.duckDb : original?.duckDb) ?? DEFAULT_DUCK_DB}
                    min={DUCK_MIN_DB}
                    max={DUCK_MAX_DB}
                    perPx={0.2}
                    decimals={0}
                    unit="dB"
                    disabled={!cue || mode !== 'on'}
                    onInput={() => {}}
                    onCommit={(v) => (stem ? setStem({ duckDb: v }) : setOriginal({ duckDb: v }))}
                  />
                </div>
                {stems.length === 0 && (
                  <div className="tl-kv">
                    <span>Stems</span>
                    <button
                      className="btn sm"
                      disabled={!cue || !refPath || !(originalLength > 0) || splitting}
                      onClick={runSplit}
                    >
                      {splitting
                        ? 'Splitting…'
                        : armSplit
                          ? `Split ${secs(originalLength)}s`
                          : 'Split'}
                    </button>
                  </div>
                )}
              </div>
              <div className="tl-body" {...(i === 0 ? { ref: bodyRef } : {})}>
                {grid}
                {!stem && context}
                {row.path && laneDur > 0 && (
                  <div
                    className="tl-clip tl-orig"
                    style={{ left: xOf(0), width: Math.max(2, laneDur * pxPerSec) }}
                  >
                    <span className="cn">
                      <span className="w">{stem ? stem.name : originalName}</span>
                    </span>
                    <Wave peaks={lanePeaks} from={laneFrom} to={laneFrom + laneDur} color="#8f97a8" />
                    <span className="dur">{secs(laneDur)}s</span>
                  </div>
                )}
                {curve.length > 0 && width > 0 && (
                  <svg className="tl-duck" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
                    <polyline
                      points={curve
                        .map((pt) => `${xOf(pt.t).toFixed(2)},${gainTop(pt.db).toFixed(2)}`)
                        .join(' ')}
                    />
                  </svg>
                )}
                {regionShade}
              </div>
            </div>
          )
        })}

        {tracks.map((track, i) => (
          <div
            key={track.id}
            className="tl-lane"
            style={{
              ['--c' as string]: TRACK_COLORS[i % TRACK_COLORS.length],
              height: TRACK_H,
              ...(i === tracks.length - 1 ? { flexGrow: 1 } : {}),
            }}
          >
            <div
              className="tl-strip"
              data-strip={track.id}
              onMouseEnter={() => {
                hoverTrackRef.current = track.id
              }}
              onMouseLeave={() => {
                if (hoverTrackRef.current === track.id) hoverTrackRef.current = null
              }}
              onContextMenu={(e) => {
                setSelected([])
                selRef.current = []
                setPickedTrack(track.id)
                menu.open(e, trackMenu(track, i))
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                setSelected([])
                selRef.current = []
                setPickedTrack(track.id)
              }}
            >
              <div className="r1">
                <button
                  className={'tl-badge' + (track.id === resolveTargetTrack(comp, targetTrackId) ? ' on' : '')}
                  onClick={() => onTargetTrack(track.id)}
                  data-hint="Target track"
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
                    data-hk="soloTrack"
                    aria-pressed={track.solo}
                    disabled={!cue}
                    onClick={() => editTrack(track.id, { solo: !track.solo })}
                  >
                    S
                  </button>
                  <button
                    className={'tl-sm' + (track.muted ? ' on' : '')}
                    data-hk="muteTrack"
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
                    selected={selected.includes(c.id)}
                    busy={busyClipId === c.id}
                    gainDrag={gainDrag && gainDrag.id === c.id ? gainDrag.db : null}
                    onDown={onClipDown}
                    onOpen={openClip}
                    onContext={(e, clip) => {
                      setSelected([clip.id])
                      selRef.current = [clip.id]
                      setPickedTrack(null)
                      menu.open(e, clipMenu(clip))
                    }}
                    onVersion={switchVersion}
                  />
                ))}
              {regionShade}
            </div>
          </div>
        ))}

        {marquee && (
          <span
            className="tl-marq"
            style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
          />
        )}
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
            {...(t.hk ? { 'data-hk': t.hk } : { 'data-hint': t.name })}
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
          data-hint="Snap"
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

      {menu.node}
    </section>
  )
}

const TOOLS: { id: Tool; name: string; hk?: KeyAction; icon: JSX.Element }[] = [
  {
    id: 'select',
    name: 'Select',
    hk: 'toolSelect',
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M2 1l10 8H7l-2 4z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'razor',
    name: 'Razor',
    hk: 'splitClip',
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
    icon: (
      <svg width="14" height="14" viewBox="0 0 14 14">
        <path d="M1 13L13 1v12z" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: 'slip',
    name: 'Slip',
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
  onContext: (e: ReactMouseEvent, clip: CompClip) => void
  onOpen: (clip: CompClip) => void
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
  onContext,
  onOpen,
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
      onDoubleClick={() => onOpen(clip)}
      onContextMenu={(e) => onContext(e, clip)}
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
