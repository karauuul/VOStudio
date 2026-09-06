import { useEffect, useState } from 'react'
import type { UsageInfo } from '@shared/domain'
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
  usage: UsageInfo | null
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
  usage,
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
    const media = navigator.mediaDevices
    if (!media) return
    const refresh = (): void => {
      void media
        .enumerateDevices()
        .then((list) => {
          if (alive) setDevices(list)
        })
        .catch(() => {})
    }
    void media
      .getUserMedia({ audio: true })
      .then((s) => s.getTracks().forEach((t) => t.stop()))
      .catch(() => {})
      .then(refresh)
    media.addEventListener('devicechange', refresh)
    return () => {
      alive = false
      media.removeEventListener('devicechange', refresh)
    }
  }, [])

  const inputs = devices.filter((d) => d.kind === 'audioinput')
  const outputs = devices.filter((d) => d.kind === 'audiooutput')
  const mic = inputs.some((d) => d.label === settings.micDeviceLabel)
    ? (settings.micDeviceLabel ?? '')
    : ''
  const output = outputs.some((d) => d.label === settings.outputDeviceLabel)
    ? (settings.outputDeviceLabel ?? '')
    : ''

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

        <div className="set-row">
          <span className="set-l">Credits</span>
          <span className="mono">
            {usage
              ? `${usage.remaining.toLocaleString('en-US')} / ${usage.limit.toLocaleString('en-US')} chars`
              : '—'}
          </span>
        </div>

        <div className="sec-h">Audio</div>
        <label className="set-row">
          <span className="set-l">Microphone</span>
          <select
            value={mic}
            onChange={(e) =>
              onSettings({ ...settings, micDeviceLabel: e.target.value || undefined })
            }
          >
            <option value="">System default</option>
            {inputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.label}>
                {d.label || `Input ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label className="set-row">
          <span className="set-l">Output</span>
          <select
            value={output}
            onChange={(e) =>
              onSettings({ ...settings, outputDeviceLabel: e.target.value || undefined })
            }
          >
            <option value="">System default</option>
            {outputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.label}>
                {d.label || `Output ${i + 1}`}
              </option>
            ))}
          </select>
        </label>

        <div className="sec-h">Defaults</div>
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
