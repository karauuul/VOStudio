import { useEffect, useMemo, useRef } from 'react'
import { MAX_STS_SECONDS } from '@shared/domain'
import type { AppSettings } from '@shared/ipc'
import type { RecorderApi } from '../audio/recorder'
import { PREROLL_SECONDS } from '../audio/ring'
import { clipId, transport } from '../audio/transport'
import { useTransport } from '../audio/useTransport'
import { clock, credits, meterPct } from './shared'

export function RecordBar({
  rec,
  appSettings,
  onAppSettings,
  onToggle,
  onConvert,
  converting,
  convertBlockedReason,
  preroll,
}: {
  rec: RecorderApi
  appSettings: AppSettings
  onAppSettings: (s: AppSettings) => void
  onToggle: () => void
  onConvert: () => void
  converting: boolean
  convertBlockedReason: string
  preroll?: boolean
}) {
  const { phase, clip } = rec
  const active = phase === 'arming' || phase === 'countin' || phase === 'recording'
  const tooLong = rec.elapsed + PREROLL_SECONDS > MAX_STS_SECONDS

  const clipUrl = clip?.url
  const clipDur = clip?.durationSec ?? 0
  const canPreview = phase === 'preview' && !!clip

  const stateRef = useRef<HTMLSpanElement>(null)
  const fillRef = useRef<HTMLSpanElement>(null)

  const recId = useMemo(() => clipId.rec(clipUrl ?? 'none'), [clipUrl])

  const t = useTransport<HTMLSpanElement>({
    id: recId,
    url: clipUrl,
    onFrame: (f) => {
      if (!canPreview) return
      const fill = fillRef.current
      if (fill) fill.style.width = `${f * 100}%`
      const st = stateRef.current
      if (st) st.textContent = clock(f === 0 ? clipDur : f * clipDur)
    },
  })

  useEffect(() => {
    if (!clipUrl) return
    return () => transport.release(clipUrl)
  }, [clipUrl])

  const playing = t.playing
  const primary =
    phase === 'countin' || phase === 'recording'
      ? { label: '■ Stop', title: 'Stop recording' }
      : phase === 'arming' || preroll
        ? { label: 'Starting…', title: 'Opening the microphone — press again to cancel' }
        : phase === 'preview'
          ? { label: '↺ Retake', title: 'Record this take again' }
          : { label: '● Record', title: 'Start recording' }

  const state =
    phase === 'countin'
      ? String(rec.countIn)
      : phase === 'recording'
        ? clock(rec.elapsed)
        : canPreview
          ? clock(clipDur)
          : ''

  const fill = active ? meterPct(rec.level) : 0

  const show = (on: boolean): { visibility: 'visible' | 'hidden' } => ({
    visibility: on ? 'visible' : 'hidden',
  })

  return (
    <div className={'rec' + (phase === 'recording' ? ' on' : '')}>
      <div className="rec-row">
        <button
          className="btn primary rec-main"
          onClick={onToggle}
          disabled={converting}
          title={primary.title}
        >
          {(phase === 'arming' || preroll) && <span className="spin" />}
          {primary.label} <kbd>R</kbd>
        </button>

        <button
          className="icon-btn rec-sm"
          style={show(canPreview)}
          onClick={t.toggle}
          title={
            clip
              ? `${clip.durationSec.toFixed(2)}s · ${clip.sampleRate} Hz · WAV 16-bit — play/pause`
              : undefined
          }
        >
          {playing ? '❚❚' : '▶'}
        </button>

        <span
          ref={stateRef}
          className={
            'rec-state' +
            (phase === 'countin' ? ' count' : '') +
            (phase === 'recording' ? (tooLong ? ' over' : ' live') : '')
          }
        >
          {state}
        </span>

        {}
        <span
          ref={t.surfaceRef}
          className={'meter-slot' + (canPreview ? ' scrub' : '')}
          title={canPreview ? 'Click or drag to move the playhead' : 'Input level'}
          {...(canPreview ? t.surfaceProps : {})}
        >
          <span
            className={
              'meter' + (phase === 'recording' ? ' live' : '') + (canPreview ? ' play' : '')
            }
          >
            <span className="meter-fill" ref={fillRef} style={{ width: `${fill}%` }} />
          </span>
        </span>

        <button
          className="icon-btn rec-sm"
          style={show(active)}
          onClick={rec.cancel}
          title="Cancel [Esc]"
        >
          ✕
        </button>

        <select
          className="rec-dev"
          value={appSettings.micDeviceId ?? ''}
          disabled={active || converting}
          onChange={(e) => onAppSettings({ ...appSettings, micDeviceId: e.target.value || undefined })}
          onFocus={rec.refreshDevices}
          title="Microphone"
        >
          <option value="">Default microphone</option>
          {rec.devices.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {d.label || `Input ${i + 1}`}
            </option>
          ))}
        </select>

        <label className="tgl" title="Three beeps before the take starts">
          <input
            type="checkbox"
            checked={appSettings.countIn}
            disabled={active || converting}
            onChange={(e) => onAppSettings({ ...appSettings, countIn: e.target.checked })}
          />
          Count-in
        </label>
        <label className="tgl" title="Play the original in your headphones before recording">
          <input
            type="checkbox"
            checked={appSettings.autoReference}
            disabled={active || converting}
            onChange={(e) => onAppSettings({ ...appSettings, autoReference: e.target.checked })}
          />
          Reference
        </label>

        <span className="sp" />

        <span className="rec-conv">
          <button
            className="btn primary"
            style={show(canPreview)}
            onClick={onConvert}
            disabled={converting || !!convertBlockedReason}
            title={convertBlockedReason || 'Send this recording to ElevenLabs Speech-to-Speech'}
          >
            {converting
              ? 'Converting…'
              : `Convert (≈${clip ? credits(clip.durationSec) : '0'} credits)`}
          </button>
        </span>
      </div>
    </div>
  )
}
