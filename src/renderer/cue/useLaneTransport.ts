import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ResolvedComp } from '../audio/comp-source'
import { transport, type TransportState } from '../audio/transport'
import type { WaveformHandle } from '../Waveform'

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
  origHandle: WaveformHandle
  compHandle: WaveformHandle
}

export function useLaneTransport(opts: {
  orig: LaneSource
  comp: LaneSource
  resetKey: string
  onFrame: (t: number) => void
}): LaneTransport {
  const { orig, comp, resetKey, onFrame } = opts

  const posRef = useRef(0)
  const scrubRef = useRef(false)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const playingRef = useRef<string | null>(null)

  const frameRef = useRef(onFrame)
  frameRef.current = onFrame
  const srcRef = useRef({ orig, comp })
  srcRef.current = { orig, comp }

  const paint = useCallback((t: number): void => {
    posRef.current = t
    frameRef.current(t)
  }, [])

  useLayoutEffect(() => {
    frameRef.current(posRef.current)
  })

  const isMine = useCallback((id: string | null): boolean => {
    const s = srcRef.current
    return !!id && (id === s.orig.id || id === s.comp.id)
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
  const compId = comp.id
  useEffect(
    () => () => {
      const cur = transport.currentClipId()
      if (cur && (cur === origId || cur === compId)) transport.stop()
    },
    [origId, compId]
  )

  const resolved = comp.comp ?? null
  useEffect(() => {
    if (!resolved || !compId) return
    const st = transport.getState()
    if (st.clipId !== compId || !st.playing) return
    void transport.playComp(resolved, { id: compId, seek: st.pos })
  }, [resolved, compId])

  const startAt = useCallback((src: LaneSource, fromStart: boolean): number => {
    const region = src.comp?.region
    const max = src.duration > 0 ? src.duration : Infinity
    const pos = Math.max(0, Math.min(max, posRef.current))
    if (!region) return fromStart ? 0 : pos
    return !fromStart && pos > region.in && pos < region.out ? pos : region.in
  }, [])

  const start = useCallback(
    (which: 'orig' | 'comp', fromStart: boolean): void => {
      const src = srcRef.current[which]
      if (!src.id) return
      const at = startAt(src, fromStart)
      if (fromStart || at !== posRef.current) paint(at)
      if (src.comp) void transport.playComp(src.comp, { id: src.id, seek: at })
      else if (src.url) void transport.playClip({ id: src.id, url: src.url }, at)
    },
    [paint, startAt]
  )

  const toggle = useCallback(
    (which: 'orig' | 'comp'): void => {
      const src = srcRef.current[which]
      if (!src.id) return
      if (playingRef.current === src.id) transport.pause()
      else start(which, false)
    },
    [start]
  )

  const pauseSide = useCallback((which: 'orig' | 'comp'): void => {
    const src = srcRef.current[which]
    if (src.id && transport.currentClipId() === src.id) transport.pause()
  }, [])

  const seek = useCallback(
    (t: number, exact: boolean): void => {
      const v = Math.max(0, t)
      paint(v)
      if (!isMine(transport.currentClipId())) return
      if (exact) transport.seek(v)
      else transport.scrubTo(v)
    },
    [isMine, paint]
  )

  const origHandle = useMemo<WaveformHandle>(
    () => ({
      toggle: () => toggle('orig'),
      play: () => start('orig', true),
      pause: () => pauseSide('orig'),
    }),
    [toggle, start, pauseSide]
  )

  const compHandle = useMemo<WaveformHandle>(
    () => ({
      toggle: () => toggle('comp'),
      play: () => start('comp', true),
      pause: () => pauseSide('comp'),
    }),
    [toggle, start, pauseSide]
  )

  return { posRef, scrubRef, playingId, seek, origHandle, compHandle }
}
