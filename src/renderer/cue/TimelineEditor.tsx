import {
  useCallback,
  useRef,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  canHeal,
  clipEnd,
  clipTimelineDuration,
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
  splitClipAt,
  trimClipEdge,
} from '@shared/comp'
import { clipSpeed, type ClipEdits, type CompClip, type Cue, type CueComp, type Take } from '@shared/domain'
import { toggleEffect } from '@shared/effects'
import { audioUrl } from '../api'
import { clipId } from '../audio/transport'
import type { Peaks } from '../Waveform'
import type { EffectName } from './ClipParams'
import { FragmentPrompt } from './FragmentPrompt'
import { takeDrag, type TakeDrag } from './take-drag'
import type { DrawGhost } from './timeline-draw'
import {
  clipAt,
  FADE_ZONE_PX,
  hitTest,
  REGION_BAND_PX,
  regionHit,
  snap,
  SNAP_PX,
  snapDelta,
  snapTargets,
  xToTime,
  type HitClip,
  type TimelineView,
} from './timeline-math'
import { TimelineBar } from './TimelineBar'
import { sameComp, useCompEdit } from './useCompEdit'

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
  editSelected: (patch: Partial<ClipEdits>, commit: boolean) => void
  trimSelected: (edge: 'start' | 'end', at: number, commit: boolean) => void
  toggleEffect: (which: EffectName) => void
  insertTake: (take: Take) => void
}

interface Ctx {
  cue: Cue
  displayComp: CueComp | null
  selected: string | null
  setSelected: (id: string | null) => void
  editable: boolean
  compDur: number
  refs: {
    display: MutableRefObject<CueComp | null>
    pending: MutableRefObject<CueComp | null>
    ghost: MutableRefObject<DrawGhost | null>
    sel: MutableRefObject<string | null>
    peaks: MutableRefObject<Record<string, Peaks>>
    refDur: MutableRefObject<number>
    refPath: MutableRefObject<string | undefined>
    snap: MutableRefObject<boolean>
    editable: MutableRefObject<boolean>
    view: MutableRefObject<TimelineView>
    pos: MutableRefObject<number>
    canvas: RefObject<HTMLCanvasElement>
    ruler: RefObject<HTMLCanvasElement>
  }
  requestDraw: () => void
  localX: (clientX: number) => number
  startDrag: (onMove: (ev: MouseEvent) => void, onUp: (ev: MouseEvent) => void) => void
  startScrub: (e: ReactMouseEvent) => void
  fit: () => void
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
}

export interface TimelineEditorApi {
  api: CompApi
  selectedClip: CompClip | null
  prompt: boolean
  closePrompt: () => void
  onRulerDown: (e: ReactMouseEvent) => void
  onRulerDouble: (e: ReactMouseEvent) => void
  onCompDown: (e: ReactMouseEvent) => void
  onCompHover: (e: ReactMouseEvent) => void
  insertTake: (take: Take) => void
  canInsert: boolean
  bar: {
    onCut: () => void
    canCut: boolean
    onHeal: () => void
    canHeal: boolean
    onCrossfade: () => void
    canCrossfade: boolean
    crossfadeOn: boolean
    onDelete: () => void
    canDelete: boolean
    onUndo: () => void
    canUndo: boolean
    onRedo: () => void
    canRedo: boolean
    onFragment: () => void
    canFragment: boolean
    onSetIn: () => void
    onSetOut: () => void
    onClearRegion: () => void
    canRegion: boolean
    hasRegion: boolean
  }
}

export function useTimelineEditor(ctx: Ctx): TimelineEditorApi {
  const {
    cue,
    displayComp,
    selected,
    setSelected,
    editable,
    compDur,
    refs,
    requestDraw,
    localX,
    startDrag,
    startScrub,
    fit,
    onComp,
    onStatus,
  } = ctx

  const [prompt, setPrompt] = useState(false)

  const onProblem = useCallback(
    (p: string) => onStatus('err', `Composition rejected: ${p}`),
    [onStatus]
  )
  const edit = useCompEdit(cue.id, cue.comp, onComp, onProblem)

  const optimistic = useRef<CueComp | null | undefined>(undefined)
  useEffect(() => {
    optimistic.current = undefined
  }, [cue.comp])
  const shownComp = useCallback(
    (): CueComp | null => (optimistic.current === undefined ? refs.display.current : optimistic.current),
    [refs]
  )

  const commit = useCallback(
    (next: CueComp | null, from: CueComp | null): void => {
      if (!refs.editable.current) return
      const value = next && next.clips.length > 0 ? next : null
      if (sameComp(value, from)) return
      optimistic.current = value
      edit.commit(value)
    },
    [edit, refs]
  )

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

  const onRulerDown = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0) return
      const base = shownComp()
      if (!base || !refs.ruler.current || !refs.editable.current || e.nativeEvent.offsetY > REGION_BAND_PX) {
        startScrub(e)
        return
      }
      e.preventDefault()
      const view = refs.view.current
      const at = Math.max(0, xToTime(view, localX(e.clientX)))
      const grab = regionHit(base.region, at, view.pxPerSec)
      const targets = snapTargets(hitClips(base), null, [refs.pos.current, refs.refDur.current])
      const anchor =
        grab === 'in' && base.region ? base.region.out : grab === 'out' && base.region ? base.region.in : at
      let next: CueComp = base

      const apply = (clientX: number, alt: boolean): void => {
        const v = refs.view.current
        const tol = alt || !refs.snap.current ? 0 : SNAP_PX / v.pxPerSec
        const raw = Math.max(0, xToTime(v, localX(clientX)))
        const edge = snap(raw, targets, tol)
        next = setRegion(base, { in: Math.min(anchor, edge), out: Math.max(anchor, edge) })
        refs.pending.current = next
        requestDraw()
      }

      startDrag(
        (ev) => apply(ev.clientX, ev.altKey),
        (ev) => {
          apply(ev.clientX, ev.altKey)
          refs.pending.current = null
          commit(next, base)
          requestDraw()
        }
      )
      apply(e.clientX, e.altKey)
    },
    [refs, startScrub, localX, hitClips, requestDraw, startDrag, commit]
  )

  const onRulerDouble = useCallback(
    (e: ReactMouseEvent): void => {
      const base = shownComp()
      if (refs.editable.current && base?.region && e.nativeEvent.offsetY <= REGION_BAND_PX) {
        const at = Math.max(0, xToTime(refs.view.current, localX(e.clientX)))
        if (at >= base.region.in && at <= base.region.out) {
          commit(setRegion(base, null), base)
          requestDraw()
          return
        }
      }
      fit()
    },
    [refs, localX, commit, requestDraw, fit]
  )

  const onCompDown = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0) return
      const base = shownComp()
      const canvas = refs.canvas.current
      if (!base || !canvas || !refs.editable.current) {
        startScrub(e)
        return
      }
      const box = canvas.getBoundingClientRect()
      const view = refs.view.current
      const at = xToTime(view, e.clientX - box.left)
      const hits = hitClips(base)
      const hit = hitTest(hits, at, view.pxPerSec, e.clientY - box.top <= FADE_ZONE_PX)
      if (!hit) {
        setSelected(null)
        startScrub(e)
        return
      }
      setSelected(hit.id)
      refs.sel.current = hit.id
      const clip = base.clips.find((c) => c.id === hit.id)
      if (!clip) return
      e.preventDefault()

      const x0 = e.clientX
      const targets = snapTargets(hits, hit.id, [refs.pos.current, refs.refDur.current])
      const srcDur = refs.peaks.current[clip.sourceTakeId]?.duration ?? Infinity
      const tl = clipTimelineDuration(clip)
      const xf0 = hits.find((h) => h.id === hit.id)?.crossfade ?? 0
      let next: CueComp = base

      const onMove = (ev: MouseEvent): void => {
        const pps = refs.view.current.pxPerSec
        const raw = (ev.clientX - x0) / pps
        const tol = ev.altKey || !refs.snap.current ? 0 : SNAP_PX / pps
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
        refs.pending.current = next
        requestDraw()
      }

      startDrag(onMove, () => {
        refs.pending.current = null
        commit(next, base)
        requestDraw()
      })
    },
    [refs, startScrub, hitClips, setSelected, requestDraw, startDrag, commit]
  )

  const onCompHover = useCallback(
    (e: ReactMouseEvent): void => {
      const canvas = refs.canvas.current
      const base = refs.pending.current ?? shownComp()
      if (!canvas || !base) return
      if (!refs.editable.current) {
        canvas.style.cursor = 'pointer'
        return
      }
      const box = canvas.getBoundingClientRect()
      const view = refs.view.current
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
    [refs, hitClips]
  )

  const selectedClip = useMemo(
    () => displayComp?.clips.find((c) => c.id === selected) ?? null,
    [displayComp, selected]
  )

  const editSelected = useCallback(
    (patch: Partial<ClipEdits>, doCommit: boolean): void => {
      const base = shownComp()
      const id = refs.sel.current
      if (!base || !id) return
      const next = setClipEdits(base, id, patch)
      if (doCommit) {
        refs.pending.current = null
        commit(next, base)
      } else {
        refs.pending.current = next
      }
      requestDraw()
    },
    [refs, commit, requestDraw]
  )

  const trimSelected = useCallback(
    (edge: 'start' | 'end', at: number, doCommit: boolean): void => {
      const base = shownComp()
      const id = refs.sel.current
      const clip = base?.clips.find((c) => c.id === id)
      if (!base || !id || !clip) return
      const speed = clipSpeed(clip.edits)
      const from = edge === 'start' ? clip.srcIn : clip.srcOut
      const srcDur = refs.peaks.current[clip.sourceTakeId]?.duration ?? Infinity
      const next = trimClipEdge(base, id, edge, (at - from) / speed, srcDur)
      if (doCommit) {
        refs.pending.current = null
        commit(next, base)
      } else {
        refs.pending.current = next
      }
      requestDraw()
    },
    [refs, commit, requestDraw]
  )

  const removeSelected = useCallback((): boolean => {
    const base = shownComp()
    const id = refs.sel.current
    if (!refs.editable.current || !base || !id || !base.clips.some((c) => c.id === id)) return false
    commit(removeClip(base, id), base)
    setSelected(null)
    return true
  }, [refs, commit, setSelected])

  const splitAtHead = useCallback((): void => {
    const base = shownComp()
    if (!base) return
    const at = refs.pos.current
    const sel = base.clips.find((c) => c.id === refs.sel.current)
    const target =
      sel && at > sel.start && at < clipEnd(sel)
        ? sel.id
        : clipAt(
            base.clips.map((c) => ({ id: c.id, start: c.start, end: clipEnd(c) })),
            at
          )
    if (!target) return
    commit(splitClipAt(base, target, at), base)
  }, [refs, commit])

  const canHealAny = useMemo(
    () => !!displayComp && displayComp.clips.some((c) => canHeal(displayComp, c.id)),
    [displayComp]
  )

  const healSelected = useCallback((): void => {
    const base = shownComp()
    if (!base) return
    const id =
      refs.sel.current && canHeal(base, refs.sel.current)
        ? refs.sel.current
        : healableAt(base, refs.pos.current, Infinity)
    if (!id) return
    commit(healCut(base, id), base)
    setSelected(id)
    refs.sel.current = id
  }, [refs, commit, setSelected])

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
    const base = shownComp()
    const id = refs.sel.current
    if (!base || !id) return
    const i = base.clips.findIndex((c) => c.id === id)
    if (i < 0) return
    const on = effectiveCrossfade(base.clips[i], base.clips[i + 1]) > 0
    commit(setCrossfade(base, id, on ? 0 : DEFAULT_CROSSFADE), base)
  }, [refs, commit])

  const toggleFx = useCallback(
    (which: EffectName): void => {
      const base = shownComp()
      const id = refs.sel.current
      if (!base || !id) return
      const clip = base.clips.find((c) => c.id === id)
      if (!clip) return
      const on = !!clip.edits.effects?.[which]
      commit(setClipEdits(base, id, { effects: toggleEffect(clip.edits.effects, which, !on) }), base)
      requestDraw()
    },
    [refs, commit, requestDraw]
  )

  const insertTake = useCallback(
    (take: Take): void => {
      const base = shownComp()
      if (!base) return
      const duration = refs.peaks.current[take.id]?.duration || take.duration
      if (!(duration > 0)) {
        onStatus('info', 'This take has no known duration yet')
        return
      }
      const next = insertClipFromTake(base, take.id, duration, refs.pos.current)
      if (sameComp(next, base)) {
        onStatus('info', 'No room for this take on the timeline')
        return
      }
      commit(next, base)
      requestDraw()
    },
    [refs, commit, requestDraw, onStatus]
  )

  useEffect(() => {
    return takeDrag.subscribe((d: TakeDrag | null) => {
      const canvas = refs.canvas.current
      const base = shownComp()
      if (!d) {
        refs.ghost.current = null
        requestDraw()
        return
      }
      const box = canvas?.getBoundingClientRect()
      const over =
        !!box && d.x >= box.left && d.x <= box.right && d.y >= box.top && d.y <= box.bottom
      if (!over || !base || !refs.editable.current || !(d.duration > 0)) {
        if (refs.ghost.current) {
          refs.ghost.current = null
          requestDraw()
        }
        return
      }
      const view = refs.view.current
      const at = Math.max(0, xToTime(view, d.x - box.left))
      const targets = snapTargets(hitClips(base), null, [refs.pos.current, refs.refDur.current])
      const tol = refs.snap.current ? SNAP_PX / view.pxPerSec : 0
      const wanted = snap(at, targets, tol)
      const slot = findInsertSlot(base, d.duration, wanted, d.duration)
      if (d.dropped) {
        refs.ghost.current = null
        if (slot !== null) {
          commit(insertClipFromTake(base, d.takeId, d.duration, slot), base)
        }
        requestDraw()
        return
      }
      refs.ghost.current = {
        start: slot ?? wanted,
        duration: d.duration,
        valid: slot !== null,
        label: d.label,
      }
      requestDraw()
    })
  }, [refs, hitClips, requestDraw, commit])

  const selection = useCallback((): ClipSelection | null => {
    const base = shownComp()
    const id = refs.sel.current
    const clip = refs.editable.current && base && id ? base.clips.find((c) => c.id === id) : null
    if (!clip) return null
    const start = clip.start
    const end = clipEnd(clip)
    const path = refs.refPath.current
    const to = Math.min(end, refs.refDur.current)
    return {
      clipId: clip.id,
      start,
      end,
      reference:
        path && to > start
          ? { id: clipId.original(path), url: audioUrl(path), from: start, to }
          : null,
    }
  }, [refs])

  const promptFragment = useCallback((): boolean => {
    if (!selection()) return false
    setPrompt(true)
    return true
  }, [selection])

  useEffect(() => setPrompt(false), [cue.id, selected])

  const replaceSource = useCallback(
    (targetId: string, takeId: string, duration: number): boolean => {
      const hasClip = (c: CueComp | null | undefined): c is CueComp =>
        !!c && c.clips.some((x) => x.id === targetId)
      const shown = shownComp()
      const base = hasClip(shown) ? shown : hasClip(cue.comp) ? cue.comp : null
      if (!base) return false
      const next = replaceClipSource(base, targetId, takeId, duration)
      if (sameComp(next, base)) return false
      refs.pending.current = null
      edit.commit(next)
      if (base === shown) requestDraw()
      return true
    },
    [refs, edit, requestDraw, cue.comp]
  )

  const regionEdge = useCallback(
    (edge: 'in' | 'out'): void => {
      const base = shownComp()
      if (!base) return
      commit(setRegionEdge(base, edge, refs.pos.current), base)
      requestDraw()
    },
    [refs, commit, requestDraw]
  )

  const clearRegion = useCallback((): void => {
    const base = shownComp()
    if (!base?.region) return
    commit(setRegion(base, null), base)
    requestDraw()
  }, [refs, commit, requestDraw])

  const undo = edit.undo
  const redo = edit.redo

  const api = useMemo<CompApi>(
    () => ({
      deleteSelected: removeSelected,
      split: splitAtHead,
      heal: healSelected,
      crossfade: toggleCrossfade,
      undo: () => {
        if (refs.editable.current) undo()
      },
      redo: () => {
        if (refs.editable.current) redo()
      },
      selection,
      promptFragment,
      replaceSource,
      editSelected,
      trimSelected,
      toggleEffect: toggleFx,
      insertTake,
    }),
    [
      refs,
      removeSelected,
      splitAtHead,
      healSelected,
      toggleCrossfade,
      undo,
      redo,
      selection,
      promptFragment,
      replaceSource,
      editSelected,
      trimSelected,
      toggleFx,
      insertTake,
    ]
  )

  const hasComp = !!displayComp && displayComp.clips.length > 0

  return {
    api,
    selectedClip,
    prompt,
    closePrompt: useCallback(() => setPrompt(false), []),
    onRulerDown,
    onRulerDouble,
    onCompDown,
    onCompHover,
    insertTake,
    canInsert: editable && hasComp,
    bar: {
      onCut: splitAtHead,
      canCut: editable && hasComp,
      onHeal: healSelected,
      canHeal: editable && canHealAny,
      onCrossfade: toggleCrossfade,
      canCrossfade: editable && xfRoom > 0,
      crossfadeOn: xfNow > 0,
      onDelete: removeSelected,
      canDelete: editable && !!selectedClip,
      onUndo: undo,
      canUndo: editable && edit.canUndo,
      onRedo: redo,
      canRedo: editable && edit.canRedo,
      onFragment: promptFragment,
      canFragment: editable && !!selectedClip,
      onSetIn: () => regionEdge('in'),
      onSetOut: () => regionEdge('out'),
      onClearRegion: clearRegion,
      canRegion: editable && hasComp && compDur > 0,
      hasRegion: editable && !!displayComp?.region,
    },
  }
}

interface EditorProps {
  editor: TimelineEditorApi
  insert: ReactNode
  snap: boolean
  onSnap: () => void
  onZoomIn: () => void
  canZoomIn: boolean
  onZoomOut: () => void
  canZoomOut: boolean
  onFit: () => void
  busy: boolean
  onFragmentText: (text: string) => void
}

export function TimelineEditor({
  editor,
  insert,
  snap: snapOn,
  onSnap,
  onZoomIn,
  canZoomIn,
  onZoomOut,
  canZoomOut,
  onFit,
  busy,
  onFragmentText,
}: EditorProps) {
  return (
    <div className="tl-tools">
      <TimelineBar
        {...editor.bar}
        canFragment={editor.bar.canFragment && !busy}
        insert={insert}
        snap={snapOn}
        onSnap={onSnap}
        onZoomIn={onZoomIn}
        canZoomIn={canZoomIn}
        onZoomOut={onZoomOut}
        canZoomOut={canZoomOut}
        onFit={onFit}
      />
      {editor.prompt && editor.selectedClip && (
        <FragmentPrompt onSubmit={onFragmentText} onClose={editor.closePrompt} />
      )}
    </div>
  )
}
