import { useEffect, useMemo, useRef } from 'react'
import { MAX_STS_SECONDS } from '@shared/domain'
import { PREROLL_SECONDS } from '../audio/ring'
import { clipId, transport } from '../audio/transport'
import { useTransport } from '../audio/useTransport'
import { clock, credits, meterPct } from './shared'
import type { VoiceToVoice } from './useVoiceToVoice'

export function RecordBar({ v2v }: { v2v: VoiceToVoice }) {
  const { rec, converting, preroll, pending } = v2v
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

  if (pending) {
    return (
      <div className="rec decide">
        <span className="rec-tag warn">Recording · Unsaved</span>
        <button
          className="btn primary"
          onClick={() => v2v.resolvePending('save')}
          disabled={converting}
        >
          Save recording
        </button>
        <button className="btn danger" onClick={() => v2v.resolvePending('discard')}>
          Discard
        </button>
        <button className="btn ghost" autoFocus onClick={() => v2v.resolvePending('cancel')}>
          Cancel
        </button>
      </div>
    )
  }

  if (canPreview) {
    return (
      <div className="rec">
        <span className="rec-tag warn">Recording · Unsaved</span>
        <button
          className="icon-btn rec-sm"
          onClick={t.toggle}
          title={`${clipDur.toFixed(2)}s · ${clip.sampleRate} Hz · WAV`}
        >
          {t.playing ? '❚❚' : '▶'}
        </button>
        <span ref={stateRef} className="rec-state">
          {clock(clipDur)}
        </span>
        <span
          ref={t.surfaceRef}
          className="meter-slot scrub"
          title="Playhead"
          {...t.surfaceProps}
        >
          <span className="meter play">
            <span className="meter-fill" ref={fillRef} style={{ width: '0%' }} />
          </span>
        </span>
        <button
          className="btn primary"
          onClick={v2v.saveRecording}
          disabled={converting}
        >
          Save recording
        </button>
        <button
          className="btn ghost"
          onClick={v2v.convertClip}
          disabled={converting || !!v2v.convertBlocked}
          title={v2v.convertBlocked || `≈${credits(clipDur)} credits`}
        >
          {converting ? 'Converting…' : `Convert ≈${credits(clipDur)}`}
        </button>
        <button className="btn ghost" onClick={v2v.retake} disabled={converting}>
          ↺ Retake <kbd>R</kbd>
        </button>
        <button className="btn danger" onClick={v2v.discard} disabled={converting}>
          Discard
        </button>
      </div>
    )
  }

  if (!active && !preroll) {
    return (
      <div className="rec">
        <button
          className="btn primary rec-main"
          onClick={v2v.toggleRec}
          disabled={converting}
          title="Start recording"
        >
          ● Record <kbd>R</kbd>
        </button>
      </div>
    )
  }

  const armed = phase === 'arming' || preroll
  const state =
    phase === 'countin' ? String(rec.countIn) : phase === 'recording' ? clock(rec.elapsed) : ''

  return (
    <div className={'rec' + (phase === 'recording' ? ' on' : '')}>
      <button
        className="btn primary rec-main"
        onClick={v2v.toggleRec}
        disabled={converting}
        title={armed ? 'Cancel' : 'Stop recording'}
      >
        {armed ? (
          <>
            <span className="spin" />
            Starting…
          </>
        ) : (
          <>
            ■ Stop <kbd>R</kbd>
          </>
        )}
      </button>
      <span
        className={
          'rec-state' +
          (phase === 'countin' ? ' count' : '') +
          (phase === 'recording' ? (tooLong ? ' over' : ' live') : '')
        }
      >
        {state}
      </span>
      <span className="meter-slot" title="Input level">
        <span className={'meter' + (phase === 'recording' ? ' live' : '')}>
          <span className="meter-fill" style={{ width: `${meterPct(rec.level)}%` }} />
        </span>
      </span>
      <button className="icon-btn rec-sm" onClick={rec.cancel} title="Cancel [Esc]">
        ✕
      </button>
    </div>
  )
}
