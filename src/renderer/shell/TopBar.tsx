import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectVersion } from '@shared/domain'
import { Logo } from './Logo'

export type Route = 'import' | 'work' | 'export'

export interface MenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
}

const ROOMS: { id: Route; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'work', label: 'Work' },
  { id: 'export', label: 'Export' },
]

function Chevron() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
      <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function Gear() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6.6 1h2.8l.4 2 1.6.9 1.9-.7 1.4 2.4-1.5 1.3v1.9l1.5 1.3-1.4 2.4-1.9-.7-1.6.9-.4 2H6.6l-.4-2-1.6-.9-1.9.7L1.3 10l1.5-1.3V6.8L1.3 5.5l1.4-2.4 1.9.7 1.6-.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="7.8" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function Menu({
  trigger,
  className,
  label,
  items,
  open,
  onOpen,
  disabled,
}: {
  trigger: ReactNode
  className: string
  label: string
  items: MenuItem[]
  open: boolean
  onOpen: (next: boolean) => void
  disabled?: boolean
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return
      onOpen(false)
      btnRef.current?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onOpen])

  return (
    <div className="menu" ref={wrapRef}>
      <button
        ref={btnRef}
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => onOpen(!open)}
      >
        {trigger}
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
                onOpen(false)
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
  )
}

interface Props {
  name: string
  onRename: (name: string) => void
  versions: ProjectVersion[]
  onSaveVersion: () => void
  route: Route
  onRoute: (next: Route) => void
  items: MenuItem[]
  jobsPending: number
  jobsFailed: number
  onJobs: () => void
  onMenu: (open: boolean) => void
}

export function TopBar({
  name,
  onRename,
  versions,
  onSaveVersion,
  route,
  onRoute,
  items,
  jobsPending,
  jobsFailed,
  onJobs,
  onMenu,
}: Props) {
  const [draft, setDraft] = useState(name)
  const [shown, setShown] = useState(name)
  const [open, setOpen] = useState<'versions' | 'gear' | null>(null)
  const cancelRef = useRef(false)
  const menuRef = useRef(onMenu)
  menuRef.current = onMenu

  if (name !== shown) {
    setShown(name)
    setDraft(name)
  }

  useEffect(() => {
    menuRef.current(open !== null)
  }, [open])

  const commit = (): void => {
    const next = draft.trim()
    if (cancelRef.current || !next || next === name) {
      cancelRef.current = false
      setDraft(name)
      return
    }
    onRename(next)
  }

  const latest = versions[versions.length - 1]

  return (
    <header className="top">
      <span className="brand">
        <Logo />
        VO Studio
      </span>

      <input
        className="pname"
        aria-label="Project name"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.code === 'Enter' || e.code === 'NumpadEnter') e.currentTarget.blur()
          if (e.code === 'Escape') {
            cancelRef.current = true
            e.currentTarget.blur()
          }
        }}
      />

      <Menu
        className="field mono"
        label="Versions"
        trigger={
          <>
            {latest ? `v${latest.n}` : 'v—'}
            <Chevron />
          </>
        }
        disabled={versions.length === 0}
        items={[...versions]
          .reverse()
          .map((v) => ({ label: v.name ? `v${v.n} · ${v.name}` : `v${v.n}`, onClick: () => {} }))}
        open={open === 'versions'}
        onOpen={(next) => setOpen(next ? 'versions' : null)}
      />

      <button className="btn ghost" onClick={onSaveVersion}>
        Save version
      </button>

      <div className="rooms" role="tablist">
        {ROOMS.map((r) => (
          <button
            key={r.id}
            role="tab"
            aria-selected={route === r.id}
            className={route === r.id ? 'on' : ''}
            onClick={() => onRoute(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {(jobsPending > 0 || jobsFailed > 0) && (
        <button className="ico" onClick={onJobs} aria-label="Jobs">
          {jobsPending > 0 ? <i className="spin" /> : <i className="dot-err" />}
        </button>
      )}

      <Menu
        className="ico"
        label="Menu"
        trigger={<Gear />}
        items={items}
        open={open === 'gear'}
        onOpen={(next) => setOpen(next ? 'gear' : null)}
      />
    </header>
  )
}
