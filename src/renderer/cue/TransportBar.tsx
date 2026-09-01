import { useEffect, useRef, useState } from 'react'
import { transport } from '../audio/transport'
import { timecode } from './shared'

export function TransportBar() {
  const [playing, setPlaying] = useState(false)
  const [source, setSource] = useState('—')
  const posRef = useRef<HTMLSpanElement>(null)
  const durRef = useRef<HTMLSpanElement>(null)
  const fillRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let lastPlaying = false
    let lastSource = '—'
    const apply = (s: ReturnType<typeof transport.getState>): void => {
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
      const label = transport.isAB() ? 'A/B' : transport.sourceLabel(s.clipId)
      if (label !== lastSource) {
        lastSource = label
        setSource(label)
      }
    }
    apply(transport.getState())
    return transport.subscribe(apply)
  }, [])

  return (
    <div className="tbar">
      <button
        className="icon-btn"
        onClick={() => transport.toggle()}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="icon-btn" onClick={() => transport.stop()} title="Stop">
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

      <span className={'tbar-src' + (playing ? ' on' : '')}>{source}</span>
    </div>
  )
}
