import { useEffect, useRef, type ReactNode } from 'react'

const stack: (() => void)[] = []

interface OverlayProps {
  title: ReactNode
  label: string
  onClose: () => void
  children: ReactNode
  busy?: boolean
  drawer?: boolean
  wide?: boolean
}

export function Overlay({ title, label, onClose, children, busy, drawer, wide }: OverlayProps) {
  const opener = useRef<Element | null>(null)
  if (opener.current === null) opener.current = document.activeElement

  const busyRef = useRef(busy)
  busyRef.current = busy
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const dismiss = (): void => {
      if (!busyRef.current) closeRef.current()
    }
    stack.push(dismiss)
    const focusables = (): HTMLElement[] => {
      const root = rootRef.current
      if (!root) return []
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      )
    }
    const root = rootRef.current
    if (root && !root.contains(document.activeElement)) {
      const items = focusables()
      const first = items.find((el) => !el.closest('.modal-head')) ?? items[0]
      ;(first ?? root).focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== dismiss) return
      if (e.code === 'Tab') {
        const items = focusables()
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        const inside = !!rootRef.current?.contains(active)
        if (e.shiftKey && (active === first || !inside)) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && (active === last || !inside)) {
          e.preventDefault()
          first.focus()
        }
        return
      }
      if (e.code !== 'Escape') return
      e.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      const i = stack.indexOf(dismiss)
      if (i >= 0) stack.splice(i, 1)
      window.removeEventListener('keydown', onKey)
      const el = opener.current
      if (el instanceof HTMLElement && document.contains(el)) el.focus()
    }
  }, [])

  const dismiss = (): void => {
    if (!busy) onClose()
  }

  const cls = 'modal' + (drawer ? ' drawer' : '') + (wide ? ' wide' : '')

  return (
    <div
      className="modal-bg"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss()
      }}
    >
      <div ref={rootRef} className={cls} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className="modal-head">
          {title}
          <button className="icon-btn" onClick={dismiss} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export interface Choice {
  label: string
  onClick: () => void
  kind?: 'primary' | 'danger' | 'ghost'
  safe?: boolean
  disabled?: boolean
}

export function Confirm({
  operation,
  name,
  detail,
  choices,
}: {
  operation?: string
  name?: string
  detail?: ReactNode
  choices: Choice[]
}) {
  return (
    <div className="confirm">
      {operation && <span className="confirm-op">{operation}</span>}
      {name && <span className="confirm-name">{name}</span>}
      {detail}
      <span className="sp" />
      {choices.map((c) => (
        <button
          key={c.label}
          className={'btn ' + (c.kind ?? 'ghost')}
          autoFocus={c.safe}
          disabled={c.disabled}
          onClick={c.onClick}
        >
          {c.label}
        </button>
      ))}
    </div>
  )
}

export function ConfirmDialog({
  operation,
  name,
  detail,
  choices,
  onClose,
}: {
  operation: string
  name?: string
  detail?: ReactNode
  choices: Choice[]
  onClose: () => void
}) {
  return (
    <Overlay title={operation} label={operation} onClose={onClose}>
      <div className="modal-foot">
        <Confirm name={name} detail={detail} choices={choices} />
      </div>
    </Overlay>
  )
}
