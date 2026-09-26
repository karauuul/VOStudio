import { useEffect, useState } from 'react'
import type { UsageInfo } from '@shared/domain'
import type { AppSettings } from '@shared/ipc'
import type { UpdateStatus } from '@shared/updater'
import {
  PUNCH_PREROLL_DEFAULT,
  PUNCH_PREROLL_MAX,
  RECORD_LATENCY_MAX_MS,
  punchPrerollSeconds,
  recordLatencyMs,
} from '@shared/punch'
import { pcmBitDepth } from '@shared/wav-header'
import { api } from './api'
import { DragNumber } from './cue/DragNumber'
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
  outputApplied: boolean
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
  outputApplied,
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
  const output =
    outputApplied && outputs.some((d) => d.label === settings.outputDeviceLabel)
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

  const latency = recordLatencyMs(settings.recordLatencyMs)
  const setPreroll = (v: number): void => {
    const next = punchPrerollSeconds(v)
    onSettings({ ...settings, punchPrerollSeconds: next === PUNCH_PREROLL_DEFAULT ? undefined : next })
  }
  const idle = (): void => {}

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
              onSettings({ ...settings, micDeviceLabel: e.target.value || undefined, micDeviceId: undefined })
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
          <span className="set-l">Bit depth</span>
          <select
            value={pcmBitDepth(settings.recordBitDepth)}
            onChange={(e) =>
              onSettings({ ...settings, recordBitDepth: e.target.value === '24' ? 24 : undefined })
            }
          >
            <option value={16}>16-bit</option>
            <option value={24}>24-bit</option>
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
        <div className="set-row">
          <span className="set-l">Latency</span>
          <select
            className="set-mode"
            aria-label="Latency"
            value={latency === undefined ? 'off' : latency === 'auto' ? 'auto' : 'manual'}
            onChange={(e) =>
              onSettings({
                ...settings,
                recordLatencyMs: e.target.value === 'manual' ? 0 : e.target.value === 'auto' ? 'auto' : undefined,
              })
            }
          >
            <option value="off">Off</option>
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </select>
          {typeof latency === 'number' && (
            <DragNumber
              label=""
              unit="ms"
              value={latency}
              min={-RECORD_LATENCY_MAX_MS}
              max={RECORD_LATENCY_MAX_MS}
              perPx={1}
              decimals={0}
              onInput={idle}
              onCommit={(v) => onSettings({ ...settings, recordLatencyMs: recordLatencyMs(v) })}
            />
          )}
        </div>
        <div className="set-row">
          <span className="set-l">Pre-roll</span>
          <DragNumber
            label=""
            unit="s"
            value={punchPrerollSeconds(settings.punchPrerollSeconds)}
            min={0}
            max={PUNCH_PREROLL_MAX}
            perPx={0.05}
            decimals={1}
            onInput={idle}
            onCommit={setPreroll}
          />
        </div>

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
