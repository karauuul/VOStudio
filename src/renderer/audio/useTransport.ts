import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react'
import { compDuration } from '@shared/comp'
import type { ResolvedComp } from './comp-source'
import { transport, type TransportState } from './transport'

export interface ClipTransportOptions {
  id: string
  url?: string
  comp?: ResolvedComp | null
  onFrame?: (f: number) => void
}

export interface ClipTransport<T extends HTMLElement> {
  surfaceRef: RefObject<T>
  playing: boolean
  play: () => void
  playFromStart: () => void
  pause: () => void
  toggle: () => void
  reset: () => void
  surfaceProps: {
    onMouseDown: (e: ReactMouseEvent) => void
    onDoubleClick: (e: ReactMouseEvent) => void
  }
}

export function useTransport<T extends HTMLElement>({
  id,
  url,
  comp,
  onFrame,
}: ClipTransportOptions): ClipTransport<T> {
  const surfaceRef = useRef<T>(null)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)
  const posRef = useRef(0)
  const durRef = useRef(0)
  const scrubRef = useRef(false)
  const dragRef = useRef<(() => void) | null>(null)
  const frameRef = useRef(onFrame)
  frameRef.current = onFrame

  const paint = useCallback((f: number): void => {
    posRef.current = f
    frameRef.current?.(f)
  }, [])

  useLayoutEffect(() => {
    frameRef.current?.(posRef.current)
  })

  useEffect(() => {
    const apply = (s: TransportState): void => {
      const mine = s.clipId === id
      if (mine) {
        if (s.dur > 0) durRef.current = s.dur
        if (!scrubRef.current) paint(s.dur > 0 ? s.pos / s.dur : 0)
      }
      const p = mine && s.playing
      if (p !== playingRef.current) {
        playingRef.current = p
        setPlaying(p)
      }
    }
    apply(transport.getState())
    return transport.subscribe(apply)
  }, [id, paint])

  useEffect(() => {
    posRef.current = 0
    durRef.current = 0
    paint(0)
    if (comp) durRef.current = compDuration({ clips: comp.clips.map((c) => c.clip) })
    let alive = true
    if (!comp && url) {
      void transport.getBuffer(url).then(
        (b) => {
          if (alive) durRef.current = b.duration
        },
        () => {}
      )
    }
    return () => {
      alive = false
      if (transport.currentClipId() === id) transport.stop()
    }
  }, [id, url, comp, paint])

  useEffect(() => () => dragRef.current?.(), [])

  const play = useCallback((): void => {
    const d = durRef.current
    const at = d > 0 ? posRef.current * d : 0
    if (comp) {
      void transport.playComp(comp, { id, seek: at })
      return
    }
    if (!url) return
    void transport.playClip({ id, url }, at)
  }, [id, url, comp])

  const playFromStart = useCallback((): void => {
    if (!comp && !url) return
    paint(0)
    if (comp) void transport.playComp(comp, { id, seek: 0 })
    else if (url) void transport.playClip({ id, url }, 0)
  }, [id, url, comp, paint])

  const pause = useCallback((): void => {
    if (transport.currentClipId() === id) transport.pause()
  }, [id])

  const toggle = useCallback((): void => {
    if (playingRef.current) pause()
    else play()
  }, [play, pause])

  const reset = useCallback((): void => {
    if (transport.currentClipId() === id) transport.stop()
    scrubRef.current = false
    paint(0)
  }, [id, paint])

  const fracAt = useCallback((clientX: number): number => {
    const box = surfaceRef.current
    if (!box) return 0
    const r = box.getBoundingClientRect()
    if (r.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }, [])

  const audioSeek = useCallback(
    (f: number, exact: boolean): void => {
      const d = durRef.current
      if (d <= 0 || transport.currentClipId() !== id) return
      if (exact) transport.seek(f * d)
      else transport.scrubTo(f * d)
    },
    [id]
  )

  const onMouseDown = useCallback(
    (e: ReactMouseEvent): void => {
      if (e.button !== 0 || (!url && !comp)) return
      e.preventDefault()
      scrubRef.current = true
      const apply = (clientX: number, exact: boolean): void => {
        const f = fracAt(clientX)
        paint(f)
        audioSeek(f, exact)
      }
      const move = (ev: MouseEvent): void => {
        if (ev.buttons === 0) {
          up(ev)
          return
        }
        apply(ev.clientX, false)
      }
      const stop = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        dragRef.current = null
        scrubRef.current = false
      }
      const up = (ev: MouseEvent): void => {
        apply(ev.clientX, true)
        stop()
      }
      dragRef.current = stop
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      apply(e.clientX, true)
    },
    [audioSeek, fracAt, paint, url, comp]
  )

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent): void => {
      e.preventDefault()
      playFromStart()
    },
    [playFromStart]
  )

  const surfaceProps = useMemo(() => ({ onMouseDown, onDoubleClick }), [onMouseDown, onDoubleClick])

  return { surfaceRef, playing, play, playFromStart, pause, toggle, reset, surfaceProps }
}
