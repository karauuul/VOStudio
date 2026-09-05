import { useEffect, useRef, useState } from 'react'
import { transport, type TransportState } from './audio/transport'
import { playback, usePlayback } from './playback'
import { timecode } from './cue/shared'

export function TransportBar() {
  const [playing, setPlaying] = useState(false)
  const [foreign, setForeign] = useState<string | null>(null)
  const sides = usePlayback()
  const sidesRef = useRef(sides)
  sidesRef.current = sides
  const posRef = useRef<HTMLSpanElement>(null)
  const durRef = useRef<HTMLSpanElement>(null)
  const fillRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let lastPlaying = false
    let lastForeign: string | null = null
    const apply = (s: TransportState): void => {
      const p = posRef.current
      if (p) p.textContent = timecode(s.pos)
      const d = durRef.current
      if (d) d.textContent = timecode(s.dur)
      const f = fillRef.current
      if (f) f.style.width = `${s.dur > 0 ? Math.min(100, (s.pos / s.dur) * 100) : 0}%`

      if (s.playing !== lastPlaying) {
        lastPlaying = s.playing
        setPlaying(s.playing)
      }
      const st = sidesRef.current
      const other =
        s.playing && s.clipId && s.clipId !== st.orig.id && s.clipId !== st.active.id
          ? s.clipId
          : null
      if (other !== lastForeign) {
        lastForeign = other
        setForeign(other)
      }
    }
    apply(transport.getState())
    return transport.subscribe(apply)
  }, [])

  const label = foreign ? transport.sourceLabel(foreign) : sides[sides.target].label

  return (
    <div className="tbar">
      <button
        className="icon-btn"
        onClick={() => playback.restart(sides.target)}
        title="Restart"
      >
        ⏮
      </button>
      <button
        className="icon-btn"
        onClick={() => (foreign ? transport.toggle() : playback.toggleTarget())}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="icon-btn" onClick={() => playback.stop()} title="Stop">
        ■
      </button>

      <span className="tbar-time">
        <span ref={posRef}>00:00.0</span>
        <span className="dim"> / </span>
        <span ref={durRef} className="dim">
          00:00.0
        </span>
      </span>

      <span className="tbar-track">
        <span className="tbar-fill" ref={fillRef} />
      </span>

      <span className={'tbar-src' + (playing ? ' on' : '')}>{label}</span>
    </div>
  )
}
