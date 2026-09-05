import { useEffect, useRef, useState } from 'react'
import type { AppSettings } from '@shared/ipc'
import { RecordBar } from './RecordBar'
import type { VoiceToVoice } from './useVoiceToVoice'

interface Props {
  onGenerate: () => void
  generating: boolean
  genDisabled: boolean
  genTitle: string
  v2v: VoiceToVoice
  appSettings: AppSettings
  onAppSettings: (s: AppSettings) => void
}

export function CreateBar({
  onGenerate,
  generating,
  genDisabled,
  genTitle,
  v2v,
  appSettings,
  onAppSettings,
}: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const { rec, converting } = v2v
  const locked =
    rec.phase === 'arming' || rec.phase === 'countin' || rec.phase === 'recording' || converting

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="create">
      <button className="btn primary" onClick={onGenerate} disabled={genDisabled} title={genTitle}>
        {generating ? <span className="spin" /> : '▶'} Generate <kbd>Ctrl+G</kbd>
      </button>

      <RecordBar v2v={v2v} />

      <span className="sp" />

      <div className="menu" ref={wrapRef}>
        <button
          className="btn ghost"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v)
            if (!open) rec.refreshDevices()
          }}
        >
          Record options ▾
        </button>
        {open && (
          <div
            className="menu-pop rec-opts"
            role="menu"
            onKeyDown={(e) => {
              if (e.code !== 'Escape') return
              e.stopPropagation()
              e.preventDefault()
              setOpen(false)
            }}
          >
            <label className="rec-opt">
              Microphone
              <select
                value={appSettings.micDeviceId ?? ''}
                disabled={locked}
                onChange={(e) =>
                  onAppSettings({ ...appSettings, micDeviceId: e.target.value || undefined })
                }
                onFocus={rec.refreshDevices}
              >
                <option value="">Default microphone</option>
                {rec.devices.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Input ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>

            <label className="tgl rec-opt">
              <input
                type="checkbox"
                checked={appSettings.countIn}
                disabled={locked}
                onChange={(e) => onAppSettings({ ...appSettings, countIn: e.target.checked })}
              />
              Count-in
            </label>

            <label className="tgl rec-opt">
              <input
                type="checkbox"
                checked={appSettings.autoReference}
                disabled={locked}
                onChange={(e) => onAppSettings({ ...appSettings, autoReference: e.target.checked })}
              />
              Reference
            </label>
          </div>
        )}
      </div>
    </div>
  )
}
