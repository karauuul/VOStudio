import { useCallback, useEffect, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from 'react'
import { LinesPanel } from '../work/LinesPanel'
import { CueText } from '../work/CueText'
import { TextPanel, type TextPanelProps } from '../work/TextPanel'
import { TimelinePanel } from '../work/TimelinePanel'
import { Inspector } from '../cue/Inspector'

const LINES = { key: 'vo.lines.w', def: 280, min: 240, max: 400 }
const PROPS = { key: 'vo.props.w', def: 380, min: 320, max: 480 }

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

function storedWidth({ key, def, min, max }: typeof LINES): number {
  try {
    const v = parseInt(localStorage.getItem(key) ?? '', 10)
    return Number.isFinite(v) ? clamp(v, min, max) : def
  } catch {
    return def
  }
}

interface Props {
  hidden: boolean
  lines: ComponentProps<typeof LinesPanel>
  total: number
  text: TextPanelProps
  cueText: ComponentProps<typeof CueText> | null
  timeline: ComponentProps<typeof TimelinePanel>
  inspector: ComponentProps<typeof Inspector>
}

export function WorkRoom({ hidden, lines, total, text, cueText, timeline, inspector }: Props) {
  const [linesW, setLinesW] = useState(() => storedWidth(LINES))
  const [propsW, setPropsW] = useState(() => storedWidth(PROPS))

  useEffect(() => {
    try {
      localStorage.setItem(LINES.key, String(linesW))
      localStorage.setItem(PROPS.key, String(propsW))
    } catch {
    }
  }, [linesW, propsW])

  const startDrag = useCallback(
    (side: 'left' | 'right') => (e: ReactMouseEvent) => {
      e.preventDefault()
      const x0 = e.clientX
      const w0 = side === 'left' ? linesW : propsW
      const cfg = side === 'left' ? LINES : PROPS
      const set = side === 'left' ? setLinesW : setPropsW
      document.body.classList.add('resizing')
      const move = (ev: MouseEvent): void => {
        const dx = side === 'left' ? ev.clientX - x0 : x0 - ev.clientX
        set(clamp(w0 + dx, cfg.min, cfg.max))
      }
      const up = (): void => {
        document.body.classList.remove('resizing')
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [linesW, propsW]
  )

  const cue = text.cue

  return (
    <div
      className="main work-grid"
      hidden={hidden}
      style={{ gridTemplateColumns: `${linesW}px 8px minmax(0, 1fr) 8px ${propsW}px` }}
    >
      <section className="panel">
        <div className="phd">
          Lines <span className="n">{total}</span>
        </div>
        <LinesPanel {...lines} />
      </section>

      <div className="splitter col" onMouseDown={startDrag('left')} />

      <div className="work-center">
        <section className="panel text">
          <div className="phd">
            Text {cue && <span className="n">{cue.fields['EventName'] || cue.key}</span>}
          </div>
          <div className="ed-script">{cueText ? <CueText {...cueText} /> : <TextPanel {...text} />}</div>
        </section>

        <TimelinePanel {...timeline} />
      </div>

      <div className="splitter col" onMouseDown={startDrag('right')} />

      <section className="panel">
        <div className="phd">Properties</div>
        {cueText && <Inspector {...inspector} />}
      </section>
    </div>
  )
}
