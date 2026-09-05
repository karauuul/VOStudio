import { useCallback, useEffect, useRef, useState } from 'react'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const DRAG_PX = 3

interface Props {
  label: string
  value: number
  min: number
  max: number
  perPx: number
  decimals: number
  unit: string
  title: string
  disabled?: boolean
  onInput: (v: number) => void
  onCommit: (v: number) => void
}

export function DragNumber({
  label,
  value,
  min,
  max,
  perPx,
  decimals,
  unit,
  title,
  disabled,
  onInput,
  onCommit,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [live, setLive] = useState<number | null>(null)
  const [text, setText] = useState<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const shown = text ?? (live ?? value).toFixed(decimals)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled || e.button !== 0 || text !== null) return
      const x0 = e.clientX
      const v0 = value
      let dragging = false
      const move = (ev: MouseEvent): void => {
        if (ev.buttons === 0) {
          up(ev)
          return
        }
        const dx = ev.clientX - x0
        if (!dragging && Math.abs(dx) < DRAG_PX) return
        dragging = true
        const k = ev.shiftKey ? 0.2 : 1
        const v = clamp(v0 + dx * perPx * k, min, max)
        setLive(v)
        onInput(v)
      }
      const stop = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        cleanupRef.current = null
      }
      const up = (ev: MouseEvent): void => {
        stop()
        if (!dragging) {
          setText(value.toFixed(decimals))
          setLive(null)
          requestAnimationFrame(() => inputRef.current?.select())
          return
        }
        const dx = ev.clientX - x0
        const k = ev.shiftKey ? 0.2 : 1
        const v = clamp(v0 + dx * perPx * k, min, max)
        setLive(null)
        onCommit(v)
      }
      cleanupRef.current = stop
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      e.preventDefault()
    },
    [disabled, text, value, perPx, min, max, decimals, onInput, onCommit]
  )

  const finish = useCallback(
    (accept: boolean) => {
      const t = text
      setText(null)
      if (!accept || t === null) return
      const n = Number.parseFloat(t.replace(',', '.'))
      if (!Number.isFinite(n)) return
      onCommit(clamp(n, min, max))
    },
    [text, min, max, onCommit]
  )

  return (
    <label className={'cp-num' + (disabled ? ' off' : '')} title={title}>
      <span className="cp-k">{label}</span>
      <span className="cp-in" onMouseDown={onMouseDown}>
        <input
          ref={inputRef}
          value={shown}
          readOnly={text === null}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.code === 'Enter' || e.code === 'NumpadEnter') {
              e.preventDefault()
              inputRef.current?.blur()
            } else if (e.code === 'Escape') {
              e.preventDefault()
              setText(null)
              inputRef.current?.blur()
            }
          }}
        />
        <span className="cp-u">{unit}</span>
      </span>
    </label>
  )
}
