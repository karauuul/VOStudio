import {
  useCallback,
  useEffect,
  useState,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { CueList } from './CueList'
import { CueEditor } from './CueEditor'
import { Inspector } from './cue/Inspector'

const SIDE = { key: 'vo.sidebar.w', def: 320, min: 280, max: 460 }
const INSP = { key: 'vo.inspector.w', def: 300, min: 280, max: 320 }

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

function storedWidth({
  key,
  def,
  min,
  max,
}: {
  key: string
  def: number
  min: number
  max: number
}): number {
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

export function WorkScreen({ hidden, queue, editor, inspector }: Props) {
  const [sideW, setSideW] = useState(() => storedWidth(SIDE))
  const [rightW, setRightW] = useState(() => storedWidth(INSP))

  useEffect(() => {
    try {
      localStorage.setItem(SIDE.key, String(sideW))
      localStorage.setItem(INSP.key, String(rightW))
    } catch {
    }
  }, [sideW, rightW])

  const startDrag = useCallback(
    (side: 'left' | 'right') => (e: ReactMouseEvent) => {
      e.preventDefault()
      const x0 = e.clientX
      const w0 = side === 'left' ? sideW : rightW
      const cfg = side === 'left' ? SIDE : INSP
      const set = side === 'left' ? setSideW : setRightW
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
    [sideW, rightW]
  )

  return (
    <div className="work" style={hidden ? { display: 'none' } : undefined}>
      <div style={{ width: sideW, flex: `0 0 ${sideW}px`, display: 'flex', minHeight: 0 }}>
        <CueList {...queue} />
      </div>

      <div className="resizer" onMouseDown={startDrag('left')} title="Drag to resize" />

      <main className="center">
        {editor ? (
          <CueEditor {...editor} />
        ) : (
          <div className="center-empty">Select a cue from the list</div>
        )}
      </main>

      <div className="resizer" onMouseDown={startDrag('right')} title="Drag to resize" />

      <aside className="right" style={{ width: rightW, flex: `0 0 ${rightW}px` }}>
        <Inspector {...inspector} />
      </aside>
    </div>
  )
}
