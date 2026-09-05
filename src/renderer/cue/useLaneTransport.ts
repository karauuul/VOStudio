import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ResolvedComp } from '../audio/comp-source'
import { transport, type TransportState } from '../audio/transport'
import { playback, type PlaybackOps, type Side } from '../playback'

export interface LaneSource {
  id: string | null
  url?: string
  comp?: ResolvedComp | null
  duration: number
}

export interface LaneTransport {
  posRef: React.MutableRefObject<number>
  scrubRef: React.MutableRefObject<boolean>
  playingId: string | null
  seek: (t: number, exact: boolean) => void
  ops: PlaybackOps
}

export function useLaneTransport(opts: {
  orig: LaneSource
  active: LaneSource
  resetKey: string
  onFrame: (t: number) => void
}): LaneTransport {
  const { orig, active, resetKey, onFrame } = opts

  const posRef = useRef(0)
  const scrubRef = useRef(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const playingRef = useRef<string | null>(null)
  const compareRef = useRef(0)

  const frameRef = useRef(onFrame)
  frameRef.current = onFrame
  const srcRef = useRef({ orig, active })
  srcRef.current = { orig, active }

  const paint = useCallback((t: number): void => {
    posRef.current = t
    frameRef.current(t)
  }, [])

  useLayoutEffect(() => {
    frameRef.current(posRef.current)
  })

  const isMine = useCallback((id: string | null): boolean => {
    const s = srcRef.current
    return !!id && (id === s.orig.id || id === s.active.id)
  }, [])

  useEffect(() => {
    const apply = (s: TransportState): void => {
      const mine = isMine(s.clipId)
      if (mine && !scrubRef.current) paint(s.pos)
      const p = mine && s.playing ? s.clipId : null
      if (p !== playingRef.current) {
        playingRef.current = p
        setPlayingId(p)
      }
    }
    apply(transport.getState())
    return transport.subscribe(apply)
  }, [isMine, paint])

  useEffect(() => {
    paint(0)
  }, [resetKey, paint])

  const origId = orig.id
  const activeId = active.id
  useEffect(() => {
    compareRef.current++
    playback.setTarget('active')
  }, [origId, activeId])

  useEffect(
    () => () => {
      const cur = transport.currentClipId()
      if (cur && (cur === origId || cur === activeId)) transport.stop()
    },
    [origId, activeId]
  )

  const resolved = active.comp ?? null
  useEffect(() => {
    if (!resolved || !activeId) return
    const st = transport.getState()
    if (st.clipId !== activeId || !st.playing) return
    void transport.playComp(resolved, { id: activeId, seek: st.pos })
  }, [resolved, activeId])

  const startAt = useCallback((src: LaneSource, fromStart: boolean): number => {
    const region = src.comp?.region
    const max = src.duration > 0 ? src.duration : Infinity
    const pos = Math.max(0, Math.min(max, posRef.current))
    if (!region) return fromStart ? 0 : pos
    return !fromStart && pos > region.in && pos < region.out ? pos : region.in
  }, [])

  const startStage = useCallback(
    (side: Side, fromStart: boolean): Promise<void> => {
      const src = srcRef.current[side]
      if (!src.id) return Promise.resolve()
      const at = startAt(src, fromStart)
      if (fromStart || at !== posRef.current) paint(at)
      if (src.comp) return transport.playComp(src.comp, { id: src.id, seek: at })
      if (src.url) return transport.playClip({ id: src.id, url: src.url }, at)
      return Promise.resolve()
    },
    [paint, startAt]
  )

  const cancelCompare = useCallback((): void => {
    compareRef.current++
  }, [])

  const restart = useCallback(
    (side: Side): void => {
      void startStage(side, true)
    },
    [startStage]
  )

  const toggle = useCallback(
    (side: Side): void => {
      const src = srcRef.current[side]
      if (!src.id) return
      if (playingRef.current === src.id) transport.pause()
      else void startStage(side, false)
    },
    [startStage]
  )

  const compare = useCallback((): void => {
    const token = ++compareRef.current
    const { orig: o, active: a } = srcRef.current
    if (!o.id || !a.id) {
      const side: Side = o.id ? 'orig' : 'active'
      playback.setTarget(side)
      void startStage(side, true)
      return
    }
    playback.setTarget('orig')
    void startStage('orig', true).then(() => {
      if (compareRef.current !== token) return
      playback.setTarget('active')
      void startStage('active', true)
    })
  }, [startStage])

  const seek = useCallback(
    (t: number, exact: boolean): void => {
      const v = Math.max(0, t)
      paint(v)
      if (!isMine(transport.currentClipId())) return
      compareRef.current++
      if (exact) transport.seek(v)
      else transport.scrubTo(v)
    },
    [isMine, paint]
  )

  const ops = useMemo<PlaybackOps>(
    () => ({ toggle, restart, compare, cancelCompare }),
    [toggle, restart, compare, cancelCompare]
  )

  return { posRef, scrubRef, playingId, seek, ops }
}
