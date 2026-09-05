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

  useEffect(() => {
    const dismiss = (): void => {
      if (!busyRef.current) closeRef.current()
    }
    stack.push(dismiss)
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape' || stack[stack.length - 1] !== dismiss) return
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
      <div className={cls} role="dialog" aria-modal="true" aria-label={label}>
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
