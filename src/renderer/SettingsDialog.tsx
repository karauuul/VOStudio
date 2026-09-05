import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/ipc'
import type { UpdateStatus } from '@shared/updater'
import { api } from './api'
import { Overlay } from './Overlay'

const UPDATE_LABEL: Record<UpdateStatus['phase'], string> = {
  idle: 'Ready',
  checking: 'Checking…',
  available: 'Available',
  downloading: 'Downloading',
  ready: 'Ready',
  'up-to-date': 'Up to date',
  error: 'Error',
}

interface Props {
  hasKey: boolean
  onKeySaved: () => void
  settings: AppSettings
  onSettings: (next: AppSettings) => void
  updateStatus: UpdateStatus | null
  onUpdateStatus: (next: UpdateStatus) => void
  onShortcuts: () => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  onClose: () => void
}

export function SettingsDialog({
  hasKey,
  onKeySaved,
  settings,
  onSettings,
  updateStatus,
  onUpdateStatus,
  onShortcuts,
  onStatus,
  onClose,
}: Props) {
  const [keyInput, setKeyInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    let alive = true
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => {
        if (alive) setDevices(list.filter((d) => d.kind === 'audioinput'))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const saveKey = (): void => {
    const key = keyInput.trim()
    if (!key) return
    setSaving(true)
    void api['provider:setApiKey'](key)
      .then(
        () => {
          setKeyInput('')
          onKeySaved()
          onStatus('ok', 'API key saved (safeStorage)')
        },
        (e: unknown) => onStatus('err', String(e))
      )
      .finally(() => setSaving(false))
  }

  const checking =
    updateStatus?.phase === 'checking' || updateStatus?.phase === 'downloading'

  return (
    <Overlay title="Settings" label="Settings" onClose={onClose}>
      <div className="modal-body set">
        <div className="sec-h">ElevenLabs key</div>
        <div className="set-row">
          <span className={hasKey ? 'pb ok' : 'pb warn'}>{hasKey ? 'Configured' : 'Missing'}</span>
          <input
            type="password"
            aria-label="API key"
            value={keyInput}
            placeholder={hasKey ? 'sk_… replaces the stored key' : 'sk_…'}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.code === 'Enter' || e.code === 'NumpadEnter') saveKey()
            }}
          />
          <button className="btn primary" onClick={saveKey} disabled={saving || !keyInput.trim()}>
            Save key
          </button>
        </div>

        <div className="sec-h">Defaults</div>
        <label className="set-row">
          <span className="set-l">Microphone</span>
          <select
            value={settings.micDeviceId ?? ''}
            onChange={(e) =>
              onSettings({ ...settings, micDeviceId: e.target.value || undefined })
            }
          >
            <option value="">Default microphone</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Input ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className="set-row tgl">
          <input
            type="checkbox"
            checked={settings.countIn}
            onChange={(e) => onSettings({ ...settings, countIn: e.target.checked })}
          />
          Count-in
        </label>
        <label className="set-row tgl">
          <input
            type="checkbox"
            checked={settings.autoReference}
            onChange={(e) => onSettings({ ...settings, autoReference: e.target.checked })}
          />
          Reference
        </label>

        <div className="sec-h">Version</div>
        <div className="set-row">
          <span className="set-l mono">{updateStatus?.currentVersion ?? '—'}</span>
          <span className="update-state" title={updateStatus?.error}>
            {updateStatus ? UPDATE_LABEL[updateStatus.phase] : ''}
            {updateStatus?.phase === 'downloading' && updateStatus.percent !== undefined
              ? ` ${Math.round(updateStatus.percent)}%`
              : ''}
          </span>
          {updateStatus?.phase === 'ready' ? (
            <button className="btn primary" onClick={() => void api['updater:restart']()}>
              Restart to update
            </button>
          ) : (
            <button
              className="btn ghost"
              disabled={checking}
              onClick={() => void api['updater:check']().then(onUpdateStatus)}
            >
              Check for updates
            </button>
          )}
        </div>
      </div>

      <div className="modal-foot">
        <button className="btn ghost" onClick={onShortcuts}>
          Shortcuts <kbd>F1</kbd>
        </button>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Overlay>
  )
}
