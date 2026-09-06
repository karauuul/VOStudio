import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { isTopDismiss, pushDismiss } from '../Overlay'

export interface MenuItem {
  label: string
  hotkey?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  confirm?: string
  submenu?: MenuEntry[]
}

export type MenuEntry = MenuItem | { sep: true } | { hdr: string }

const isItem = (e: MenuEntry): e is MenuItem => 'label' in e

const MARGIN = 6

function Rows({
  entries,
  onClose,
  onLeave,
  autoFocus,
}: {
  entries: MenuEntry[]
  onClose: () => void
  onLeave?: () => void
  autoFocus: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [hi, setHi] = useState(-1)
  const [sub, setSub] = useState(-1)
  const [confirming, setConfirming] = useState(-1)
  const [flip, setFlip] = useState(false)

  useEffect(() => {
    if (autoFocus && sub < 0) ref.current?.focus()
  }, [autoFocus, sub])

  useLayoutEffect(() => {
    if (sub < 0) return
    const el = ref.current?.querySelector<HTMLElement>('.cmenu-sub')
    if (!el) return
    const box = el.getBoundingClientRect()
    setFlip(box.right > window.innerWidth - MARGIN)
  }, [sub])

  const steps = entries.flatMap((e, i) => (isItem(e) && !e.disabled ? [i] : []))

  const pick = useCallback(
    (i: number): void => {
      const e = entries[i]
      if (!isItem(e) || e.disabled) return
      if (e.submenu) {
        setSub(i)
        return
      }
      if (e.confirm && confirming !== i) {
        setConfirming(i)
        return
      }
      onClose()
      e.onClick?.()
    },
    [entries, confirming, onClose]
  )

  const onKeyDown = (ev: ReactKeyboardEvent): void => {
    if (sub >= 0 && ev.currentTarget !== ev.target) return
    const at = steps.indexOf(hi)
    if (ev.code === 'ArrowDown' || ev.code === 'ArrowUp') {
      ev.preventDefault()
      ev.stopPropagation()
      const d = ev.code === 'ArrowDown' ? 1 : -1
      const n = steps.length
      const next = n === 0 ? -1 : at < 0 ? (d > 0 ? steps[0] : steps[n - 1]) : steps[(at + d + n) % n]
      setHi(next)
      setSub(-1)
      return
    }
    if (ev.code === 'ArrowRight') {
      const e = entries[hi]
      if (isItem(e) && e.submenu && !e.disabled) {
        ev.preventDefault()
        ev.stopPropagation()
        setSub(hi)
      }
      return
    }
    if (ev.code === 'ArrowLeft' || ev.code === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      if (sub >= 0) {
        setSub(-1)
      } else if (onLeave) onLeave()
      else onClose()
      return
    }
    if (ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'Space') {
      ev.preventDefault()
      ev.stopPropagation()
      if (hi >= 0) pick(hi)
    }
  }

  const marks = entries.some((e) => isItem(e) && e.checked !== undefined)

  return (
    <div ref={ref} className="cmenu" role="menu" tabIndex={-1} onKeyDown={onKeyDown}>
      {entries.map((e, i) => {
        if ('sep' in e) return <div className="sep" key={`s${i}`} />
        if ('hdr' in e) return <div className="hdr" key={`h${i}`}>{e.hdr}</div>
        const cls = [
          'i',
          hi === i || sub === i ? 'hi' : '',
          e.disabled ? 'dis' : '',
          e.danger ? 'red' : '',
          marks ? (e.checked ? 'chk' : 'nochk') : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={`${i}:${e.label}`}
            className={cls}
            role="menuitem"
            aria-disabled={e.disabled || undefined}
            onMouseEnter={() => {
              setHi(i)
              setSub(e.submenu && !e.disabled ? i : -1)
            }}
            onClick={(ev) => {
              ev.stopPropagation()
              pick(i)
            }}
          >
            <span>{confirming === i && e.confirm ? e.confirm : e.label}</span>
            {e.submenu ? <span className="cmenu-arrow" /> : <span className="k">{e.hotkey ?? ''}</span>}
            {sub === i && e.submenu && (
              <div className={'cmenu-sub' + (flip ? ' flip' : '')}>
                <Rows
                  entries={e.submenu}
                  onClose={onClose}
                  onLeave={() => setSub(-1)}
                  autoFocus
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    setPos({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - box.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - box.height - MARGIN)),
    })
  }, [x, y, entries])

  useEffect(() => {
    const dismiss = (): void => closeRef.current()
    const drop = pushDismiss(dismiss)
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) dismiss()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!isTopDismiss(dismiss) || e.code !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      dismiss()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('contextmenu', onDown, true)
    window.addEventListener('wheel', dismiss)
    window.addEventListener('keydown', onKey, true)
    return () => {
      drop()
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('contextmenu', onDown, true)
      window.removeEventListener('wheel', dismiss)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  return createPortal(
    <div ref={wrapRef} className="cmenu-wrap" style={pos}>
      <Rows entries={entries} onClose={onClose} autoFocus />
    </div>,
    document.body
  )
}

export function useContextMenu(): {
  open: (e: ReactMouseEvent, entries: MenuEntry[]) => void
  openAt: (x: number, y: number, entries: MenuEntry[]) => void
  close: () => void
  node: JSX.Element | null
} {
  const [state, setState] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  const opener = useRef<Element | null>(null)

  const close = useCallback(() => {
    setState(null)
    const el = opener.current
    opener.current = null
    if (el instanceof HTMLElement && document.contains(el)) el.focus()
  }, [])

  const openAt = useCallback((x: number, y: number, entries: MenuEntry[]) => {
    if (entries.length > 0) setState({ x, y, entries })
  }, [])

  const open = useCallback(
    (e: ReactMouseEvent, entries: MenuEntry[]) => {
      e.preventDefault()
      e.stopPropagation()
      opener.current = document.activeElement
      openAt(e.clientX, e.clientY, entries)
    },
    [openAt]
  )

  return {
    open,
    openAt,
    close,
    node: state ? (
      <ContextMenu x={state.x} y={state.y} entries={state.entries} onClose={close} />
    ) : null,
  }
}
