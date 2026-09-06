import { useCallback, useEffect, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from 'react'
import { CueList } from '../CueList'
import { CueEditor } from '../CueEditor'
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
  queue: ComponentProps<typeof CueList>
  editor: ComponentProps<typeof CueEditor> | null
  inspector: ComponentProps<typeof Inspector>
}

export function WorkRoom({ hidden, queue, editor, inspector }: Props) {
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

  const cue = editor?.cue

  return (
    <div
      className="main work-grid"
      hidden={hidden}
      style={{ gridTemplateColumns: `${linesW}px 8px minmax(0, 1fr) 8px ${propsW}px` }}
    >
      <section className="panel">
        <div className="phd">
          Lines <span className="n">{queue.cues.length}</span>
        </div>
        <CueList {...queue} />
      </section>

      <div className="splitter col" onMouseDown={startDrag('left')} />

      <section className="panel">
        <div className="phd">
          Text {cue && <span className="n">{cue.fields['EventName'] || cue.key}</span>}
        </div>
        {editor && <CueEditor {...editor} />}
      </section>

      <div className="splitter col" onMouseDown={startDrag('right')} />

      <section className="panel">
        <div className="phd">Properties</div>
        {editor && <Inspector {...inspector} />}
      </section>
    </div>
  )
}
