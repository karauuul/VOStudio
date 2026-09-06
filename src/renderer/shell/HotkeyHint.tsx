import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { hintPosition, type HintAnchor } from '@shared/hint-position'
import { bindingOf, keyText, type KeyAction } from '../keyboard'

const DELAY = 200

interface Hint {
  label: string
  keys: string
  anchor: HintAnchor
}

export function HotkeyHint() {
  const [hint, setHint] = useState<Hint | null>(null)
  const ref = useRef<HTMLSpanElement>(null)

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
          anchor: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
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

  useLayoutEffect(() => {
    const el = ref.current
    if (!hint || !el) return
    const at = hintPosition(
      hint.anchor,
      el.offsetWidth,
      el.offsetHeight,
      window.innerWidth,
      window.innerHeight
    )
    el.style.left = `${at.left}px`
    el.style.top = `${at.top}px`
  }, [hint])

  if (!hint) return null
  return createPortal(
    <span ref={ref} className="hk-hint" style={{ left: 0, top: 0 }}>
      {hint.label}
      {hint.keys && <b>{hint.keys}</b>}
    </span>,
    document.body
  )
}
