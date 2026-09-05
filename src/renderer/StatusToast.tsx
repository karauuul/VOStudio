import { useEffect, useRef, useState } from 'react'
import type { StatusKind } from './useProjectSession'

export type Status = { id: number; kind: StatusKind; text: string } | null

const TOAST_MS: Record<StatusKind, number> = { ok: 4000, info: 4000, err: 8000 }
const TOAST_FADE_MS = 260

export function StatusToast({
  status,
  onClose,
}: {
  status: NonNullable<Status>
  onClose: () => void
}) {
  const [hover, setHover] = useState(false)
  const [out, setOut] = useState(false)
  const leftRef = useRef(TOAST_MS[status.kind])

  useEffect(() => {
    leftRef.current = TOAST_MS[status.kind]
    setOut(false)
    setHover(false)
  }, [status.id, status.kind])

  useEffect(() => {
    if (out || hover) return
    const left = leftRef.current
    const from = Date.now()
    const t = setTimeout(() => setOut(true), left)
    return () => {
      clearTimeout(t)
      leftRef.current = Math.max(0, left - (Date.now() - from))
    }
  }, [status.id, out, hover])

  useEffect(() => {
    if (!out) return
    const t = setTimeout(onClose, TOAST_FADE_MS)
    return () => clearTimeout(t)
  }, [out, onClose])

  return (
    <div
      className={`toast ${status.kind}` + (out ? ' out' : '')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="status"
    >
      <span className="toast-tx">{status.text}</span>
      {status.kind === 'err' && (
        <button className="toast-x" onClick={onClose} title="Dismiss">
          ×
        </button>
      )}
    </div>
  )
}
