import { useEffect, useRef, useState } from 'react'
import type { UsageInfo } from '@shared/domain'
import { api } from './api'

export type Route = 'work' | 'project' | 'deliver'

export interface MenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
}

interface Props {
  name: string
  cues: number
  approved: number
  route: Route
  onRoute: (next: Route) => void
  usage: UsageInfo | null
  jobsTotal: number
  jobsPending: number
  jobsFailed: number
  onJobs: () => void
  updateReady: boolean
  items: MenuItem[]
  onMenu: (open: boolean) => void
}

function Chip({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className="chip ok">
      <div className="chip-top">
        <span className="chip-label">{label}</span>
        <span className="chip-val">
          {value}
          <span className="dim"> / {total}</span>
        </span>
      </div>
      <div className="chip-bar">
        <div className="chip-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

const TABS: { id: Route; label: string; key: string }[] = [
  { id: 'work', label: 'Work', key: 'Ctrl+1' },
  { id: 'project', label: 'Project', key: 'Ctrl+2' },
  { id: 'deliver', label: 'Deliver', key: 'Ctrl+3' },
]

export function ProjectHeader({
  name,
  cues,
  approved,
  route,
  onRoute,
  usage,
  jobsTotal,
  jobsPending,
  jobsFailed,
  onJobs,
  updateReady,
  items,
  onMenu,
}: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef(onMenu)
  menuRef.current = onMenu

  useEffect(() => {
    menuRef.current(open)
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return
      setOpen(false)
      btnRef.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const creditsLow = usage ? usage.remaining / Math.max(1, usage.limit) < 0.15 : false

  return (
    <header className="hdr">
      <div className="hdr-id">
        <span className="hdr-name">{name}</span>
        <span className="hdr-sub">{cues} cues</span>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={route === t.id}
            className={route === t.id ? 'on' : ''}
            onClick={() => onRoute(t.id)}
          >
            {t.label} <kbd>{t.key}</kbd>
          </button>
        ))}
      </div>

      <div className="chips">
        <Chip label="Approved" value={approved} total={cues} />
      </div>

      <div className="hdr-right">
        {updateReady && (
          <button className="btn primary" onClick={() => void api['updater:restart']()}>
            Restart to update
          </button>
        )}
        <span className={'credits' + (creditsLow ? ' low' : '')}>
          {usage
            ? `${usage.remaining.toLocaleString('en-US')} / ${usage.limit.toLocaleString('en-US')} chars`
            : 'credits —'}
        </span>
        {jobsTotal > 0 && (
          <button className={'jobs' + (jobsFailed > 0 ? ' err' : '')} onClick={onJobs}>
            {jobsPending > 0 && <i className="spin" />}
            Jobs {jobsPending}
            {jobsFailed > 0 && <span className="jobs-x">{jobsFailed} failed</span>}
          </button>
        )}
        <div className="menu" ref={wrapRef}>
          <button
            ref={btnRef}
            className="btn ghost menu-btn"
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            title="More"
          >
            ⋯
          </button>
          {open && (
            <div className="menu-pop" role="menu">
              {items.map((item) => (
                <button
                  key={item.label}
                  className="menu-item"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    btnRef.current?.focus()
                    item.onClick()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
