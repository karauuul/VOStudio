import { useCallback, useEffect, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from 'react'
import type { ProjectSource } from '@shared/domain'
import { LinesPanel } from '../work/LinesPanel'
import { CueText } from '../work/CueText'
import { TextPanel, type TextPanelProps } from '../work/TextPanel'
import { ProgramPanel } from '../work/ProgramPanel'
import { TimelinePanel, timecode } from '../work/TimelinePanel'
import { LibraryPanel } from '../work/LibraryPanel'
import { PropertiesPanel } from '../work/PropertiesPanel'

const LINES = { key: 'vo.lines.w', def: 280, min: 240, max: 400 }
const PROPS = { key: 'vo.props.w', def: 380, min: 320, max: 480 }
const LIB = { key: 'vo.lib.h', def: 500, min: 160, max: 800 }

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

function stored({ key, def, min, max }: typeof LINES): number {
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
  source: ProjectSource | null
  text: TextPanelProps
  cueText: ComponentProps<typeof CueText> | null
  program: ComponentProps<typeof ProgramPanel>
  timeline: ComponentProps<typeof TimelinePanel>
  library: ComponentProps<typeof LibraryPanel>
  properties: ComponentProps<typeof PropertiesPanel>
}

export function WorkRoom({
  hidden,
  lines,
  total,
  source,
  text,
  cueText,
  program,
  timeline,
  library,
  properties,
}: Props) {
  const [linesW, setLinesW] = useState(() => stored(LINES))
  const [propsW, setPropsW] = useState(() => stored(PROPS))
  const [libH, setLibH] = useState(() => stored(LIB))

  useEffect(() => {
    try {
      localStorage.setItem(LINES.key, String(linesW))
      localStorage.setItem(PROPS.key, String(propsW))
      localStorage.setItem(LIB.key, String(libH))
    } catch {
    }
  }, [linesW, propsW, libH])

  const startDrag = useCallback(
    (side: 'left' | 'right' | 'lib') => (e: ReactMouseEvent) => {
      e.preventDefault()
      const vertical = side === 'lib'
      const p0 = vertical ? e.clientY : e.clientX
      const cfg = side === 'left' ? LINES : side === 'right' ? PROPS : LIB
      const v0 = side === 'left' ? linesW : side === 'right' ? propsW : libH
      const set = side === 'left' ? setLinesW : side === 'right' ? setPropsW : setLibH
      document.body.classList.add('resizing')
      const move = (ev: MouseEvent): void => {
        const d = side === 'right' ? p0 - ev.clientX : (vertical ? ev.clientY : ev.clientX) - p0
        set(clamp(v0 + d, cfg.min, cfg.max))
      }
      const up = (): void => {
        document.body.classList.remove('resizing')
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [linesW, propsW, libH]
  )

  const cue = text.cue
  const region = cue?.region
  const regionLabel = region ? `${timecode(region.in)} – ${timecode(region.out)}` : null

  return (
    <div
      className="main work-grid"
      hidden={hidden}
      style={{ gridTemplateColumns: `${linesW}px 8px minmax(0, 1fr) 8px ${propsW}px` }}
    >
      <section className="panel">
        <div className="phd">
          Lines <span className="n">{source ? `${total} · ${source.name}` : total}</span>
        </div>
        <LinesPanel {...lines} />
      </section>

      <div className="splitter col" onMouseDown={startDrag('left')} />

      <div className="work-center">
        <div className="work-upper">
          <section className="panel text">
            <div className="phd">
              Text{' '}
              {cue && (
                <span className="n">{regionLabel ?? (cue.fields['EventName'] || cue.key)}</span>
              )}
            </div>
            <div className="ed-script">{cueText ? <CueText {...cueText} /> : <TextPanel {...text} />}</div>
          </section>

          <div className="gutter" />

          <ProgramPanel {...program} />
        </div>

        <TimelinePanel {...timeline} />
      </div>

      <div className="splitter col" onMouseDown={startDrag('right')} />

      <div className="work-right" style={{ gridTemplateRows: `${libH}px 8px minmax(0, 1fr)` }}>
        <LibraryPanel {...library} />

        <div className="splitter row" onMouseDown={startDrag('lib')} />

        <PropertiesPanel {...properties} />
      </div>
    </div>
  )
}
