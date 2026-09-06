import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { bindingOf, keyText, type KeyAction } from '../keyboard'

const DELAY = 200

interface Hint {
  label: string
  keys: string
  left: number
  top: number
}

export function HotkeyHint() {
  const [hint, setHint] = useState<Hint | null>(null)

  useEffect(() => {
    let timer = 0
    const clear = (): void => {
      window.clearTimeout(timer)
      setHint(null)
    }
    const onOver = (e: MouseEvent): void => {
      window.clearTimeout(timer)
      const target = e.target instanceof HTMLElement ? e.target : null
      const el = target?.closest<HTMLElement>('[data-hk],[data-hint]')
      const action = el?.dataset['hk']
      const b = action ? bindingOf(action as KeyAction) : null
      const label = b ? (b.label ?? '') : (el?.dataset['hint'] ?? '')
      if (!el || !label || el.matches(':disabled')) {
        setHint(null)
        return
      }
      timer = window.setTimeout(() => {
        const box = el.getBoundingClientRect()
        setHint({
          label,
          keys: b ? keyText(b) : '',
          left: box.left + box.width / 2,
          top: box.bottom + 4,
        })
      }, DELAY)
    }
    document.addEventListener('mouseover', onOver)
    window.addEventListener('mousedown', clear, true)
    window.addEventListener('blur', clear)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      window.removeEventListener('mousedown', clear, true)
      window.removeEventListener('blur', clear)
    }
  }, [])

  if (!hint) return null
  return createPortal(
    <span className="hk-hint" style={{ left: hint.left, top: hint.top, transform: 'translateX(-50%)' }}>
      {hint.label}
      {hint.keys && <b>{hint.keys}</b>}
    </span>,
    document.body
  )
}
