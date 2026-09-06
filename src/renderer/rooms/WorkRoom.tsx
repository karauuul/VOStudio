import { useCallback, useEffect, useState, type ComponentProps, type MouseEvent as ReactMouseEvent } from 'react'
import type { ProjectSource } from '@shared/domain'
import { LinesPanel } from '../work/LinesPanel'
import { CueText } from '../work/CueText'
import { TextPanel, type TextPanelProps } from '../work/TextPanel'
import { ProgramPanel } from '../work/ProgramPanel'
import { TimelinePanel, timecode } from '../work/TimelinePanel'
import { LibraryPanel } from '../work/LibraryPanel'
import { PropertiesPanel } from '../work/PropertiesPanel'

const PANES = {
  lines: { key: 'vo.lines.w', def: 280, min: 240, max: 400 },
  props: { key: 'vo.props.w', def: 380, min: 320, max: 480 },
  lib: { key: 'vo.lib.h', def: 500, min: 160, max: 800 },
  prog: { key: 'vo.prog.w', def: 620, min: 360, max: 900 },
  upper: { key: 'vo.upper.h', def: 410, min: 240, max: 600 },
} as const

type Pane = keyof typeof PANES
type Sizes = Record<Pane, number>

const VERTICAL: Pane[] = ['lib', 'upper']
const INVERTED: Pane[] = ['props', 'prog']
const KEEP = 160

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

interface PaneConfig {
  key: string
  def: number
  min: number
  max: number
}

function stored({ key, def, min, max }: PaneConfig): number {
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
  const [size, setSize] = useState<Sizes>(
    () =>
      Object.fromEntries(
        Object.entries(PANES).map(([pane, cfg]) => [pane, stored(cfg)])
      ) as Sizes
  )

  useEffect(() => {
    try {
      for (const [pane, cfg] of Object.entries(PANES)) {
        localStorage.setItem(cfg.key, String(size[pane as Pane]))
      }
    } catch {
    }
  }, [size])

  const startDrag = useCallback(
    (pane: Pane) => (e: ReactMouseEvent) => {
      e.preventDefault()
      const cfg = PANES[pane]
      const vertical = VERTICAL.includes(pane)
      const inverted = INVERTED.includes(pane)
      const p0 = vertical ? e.clientY : e.clientX
      const v0 = size[pane]
      const neighbor = inverted
        ? e.currentTarget.previousElementSibling
        : e.currentTarget.nextElementSibling
      const room =
        neighbor instanceof HTMLElement
          ? vertical
            ? neighbor.offsetHeight
            : neighbor.offsetWidth
          : Infinity
      const max = Math.min(cfg.max, Math.max(v0, v0 + room - KEEP))
      document.body.classList.add('resizing')
      const move = (ev: MouseEvent): void => {
        const d = inverted ? p0 - ev.clientX : (vertical ? ev.clientY : ev.clientX) - p0
        setSize((s) => ({ ...s, [pane]: clamp(v0 + d, cfg.min, max) }))
      }
      const up = (): void => {
        document.body.classList.remove('resizing')
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [size]
  )

  const cue = text.cue
  const region = cue?.region
  const regionLabel = region ? `${timecode(region.in)} – ${timecode(region.out)}` : null

  return (
    <div
      className="main work-grid"
      hidden={hidden}
      style={{ gridTemplateColumns: `${size.lines}px 8px minmax(0, 1fr) 8px ${size.props}px` }}
    >
      <section className="panel">
        <div className="phd">
          Lines <span className="n">{source ? `${total} · ${source.name}` : total}</span>
        </div>
        <LinesPanel {...lines} />
      </section>

      <div className="splitter col" onMouseDown={startDrag('lines')} />

      <div
        className="work-center"
        style={{ gridTemplateRows: `${size.upper}px 8px minmax(0, 1fr)` }}
      >
        <div
          className="work-upper"
          style={{ gridTemplateColumns: `minmax(0, 1fr) 8px ${size.prog}px` }}
        >
          <section className="panel text">
            <div className="phd">
              Text{' '}
              {cue && (
                <span className="n">{regionLabel ?? (cue.fields['EventName'] || cue.key)}</span>
              )}
            </div>
            <div className="ed-script">{cueText ? <CueText {...cueText} /> : <TextPanel {...text} />}</div>
          </section>

          <div className="splitter col" onMouseDown={startDrag('prog')} />

          <ProgramPanel {...program} />
        </div>

        <div className="splitter row" onMouseDown={startDrag('upper')} />

        <TimelinePanel {...timeline} />
      </div>

      <div className="splitter col" onMouseDown={startDrag('props')} />

      <div className="work-right" style={{ gridTemplateRows: `${size.lib}px 8px minmax(0, 1fr)` }}>
        <LibraryPanel {...library} />

        <div className="splitter row" onMouseDown={startDrag('lib')} />

        <PropertiesPanel {...properties} />
      </div>
    </div>
  )
}
