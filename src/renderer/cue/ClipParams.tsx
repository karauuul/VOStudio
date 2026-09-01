import { useCallback, useEffect, useRef, useState } from 'react'
import { GAIN_MAX_DB, GAIN_MIN_DB, SPEED_MAX, SPEED_MIN } from '@shared/comp'
import { clipSpeed, type ClipEdits, type CompClip } from '@shared/domain'
import {
  DELAY_FEEDBACK_MAX,
  DELAY_FEEDBACK_MIN,
  DELAY_TIME_MAX,
  DELAY_TIME_MIN,
  MIX_MAX,
  MIX_MIN,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  PITCH_STEP,
  REVERB_DECAY_MAX,
  REVERB_DECAY_MIN,
  REVERB_SIZE_MAX,
  REVERB_SIZE_MIN,
  type DelayEffect,
  type ReverbEffect,
} from '@shared/effects'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

interface NumProps {
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

const DRAG_PX = 3

function DragNumber({
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
}: NumProps) {
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
            if (e.key === 'Enter') {
              e.preventDefault()
              inputRef.current?.blur()
            } else if (e.key === 'Escape') {
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

function FragmentPrompt({
  onSubmit,
  onClose,
}: {
  onSubmit: (text: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState('')
  return (
    <div className="frag-pop">
      <input
        autoFocus
        value={text}
        placeholder="fragment text"
        onChange={(ev) => setText(ev.target.value)}
        onBlur={onClose}
        onKeyDown={(ev) => {
          ev.stopPropagation()
          if (ev.key === 'Enter') {
            ev.preventDefault()
            onSubmit(text)
            onClose()
          } else if (ev.key === 'Escape') {
            ev.preventDefault()
            onClose()
          }
        }}
      />
    </div>
  )
}

interface Props {
  clip: CompClip | null
  onEdit: (patch: Partial<ClipEdits>, commit: boolean) => void
  onRemove: () => void
  busy?: boolean
  prompt?: boolean
  onPromptSubmit?: (text: string) => void
  onPromptClose?: () => void
}

export function ClipParams({
  clip,
  onEdit,
  onRemove,
  busy,
  prompt,
  onPromptSubmit,
  onPromptClose,
}: Props) {
  const off = !clip
  const e = clip?.edits
  const fadeIn = e?.fadeIn ?? { duration: 0, shape: 'equalPower' as const }
  const fadeOut = e?.fadeOut ?? { duration: 0, shape: 'equalPower' as const }

  const edit = (patch: Partial<ClipEdits>, commit: boolean): void => {
    if (!clip) return
    onEdit(patch, commit)
  }

  const fx = e?.effects
  const rv = fx?.reverb
  const dl = fx?.delay
  const pt = fx?.pitch

  const setReverb = (patch: Partial<ReverbEffect>, commit: boolean): void => {
    if (!fx?.reverb) return
    edit({ effects: { ...fx, reverb: { ...fx.reverb, ...patch } } }, commit)
  }
  const setDelay = (patch: Partial<DelayEffect>, commit: boolean): void => {
    if (!fx?.delay) return
    edit({ effects: { ...fx, delay: { ...fx.delay, ...patch } } }, commit)
  }
  const setPitch = (semitones: number, commit: boolean): void => {
    if (!fx?.pitch) return
    edit({ effects: { ...fx, pitch: { semitones } } }, commit)
  }
  const quant = (v: number): number => Math.round(v / PITCH_STEP) * PITCH_STEP

  return (
    <>
    <div className="clipbar">
      {prompt && clip && (
        <FragmentPrompt
          onSubmit={(t) => onPromptSubmit?.(t)}
          onClose={() => onPromptClose?.()}
        />
      )}

      <span className="cp-tag">
        {busy && <i className="spin" />}
        {clip ? 'CLIP' : 'NO CLIP'}
      </span>

      <DragNumber
        label="Gain"
        unit="dB"
        title="Clip gain — drag, or click to type (Shift = fine)"
        value={e?.gainDb ?? 0}
        min={GAIN_MIN_DB}
        max={GAIN_MAX_DB}
        perPx={0.2}
        decimals={1}
        disabled={off}
        onInput={(v) => edit({ gainDb: v }, false)}
        onCommit={(v) => edit({ gainDb: v }, true)}
      />

      <DragNumber
        label="Speed"
        unit="×"
        title="Playback rate — tempo and pitch together (use Pitch to shift back)"
        value={e ? clipSpeed(e) : 1}
        min={SPEED_MIN}
        max={SPEED_MAX}
        perPx={0.01}
        decimals={2}
        disabled={off}
        onInput={(v) => edit({ timeStretch: v }, false)}
        onCommit={(v) => edit({ timeStretch: v }, true)}
      />

      <DragNumber
        label="Fade in"
        unit="ms"
        title="Fade in length"
        value={Math.round(fadeIn.duration * 1000)}
        min={0}
        max={10000}
        perPx={5}
        decimals={0}
        disabled={off}
        onInput={(v) => edit({ fadeIn: { ...fadeIn, duration: v / 1000 } }, false)}
        onCommit={(v) => edit({ fadeIn: { ...fadeIn, duration: v / 1000 } }, true)}
      />

      <DragNumber
        label="Fade out"
        unit="ms"
        title="Fade out length"
        value={Math.round(fadeOut.duration * 1000)}
        min={0}
        max={10000}
        perPx={5}
        decimals={0}
        disabled={off}
        onInput={(v) => edit({ fadeOut: { ...fadeOut, duration: v / 1000 } }, false)}
        onCommit={(v) => edit({ fadeOut: { ...fadeOut, duration: v / 1000 } }, true)}
      />

      <button
        className="btn danger cp-del"
        onClick={onRemove}
        disabled={off}
        title="Remove the selected clip"
      >
        Remove <kbd>Del</kbd>
      </button>
    </div>

    {rv && (
      <div className="fxbar">
        <span className="cp-tag fx">REVERB</span>
        <DragNumber
          label="Mix"
          unit="%"
          title="Dry / wet balance"
          value={Math.round(rv.mix * 100)}
          min={MIX_MIN * 100}
          max={MIX_MAX * 100}
          perPx={0.5}
          decimals={0}
          onInput={(v) => setReverb({ mix: v / 100 }, false)}
          onCommit={(v) => setReverb({ mix: v / 100 }, true)}
        />
        <DragNumber
          label="Size"
          unit="%"
          title="Room size — density and darkness of the tail"
          value={Math.round(rv.size * 100)}
          min={REVERB_SIZE_MIN * 100}
          max={REVERB_SIZE_MAX * 100}
          perPx={0.5}
          decimals={0}
          onInput={(v) => setReverb({ size: v / 100 }, false)}
          onCommit={(v) => setReverb({ size: v / 100 }, true)}
        />
        <DragNumber
          label="Decay"
          unit="s"
          title="Time to fall to −60 dB"
          value={rv.decay}
          min={REVERB_DECAY_MIN}
          max={REVERB_DECAY_MAX}
          perPx={0.02}
          decimals={2}
          onInput={(v) => setReverb({ decay: v }, false)}
          onCommit={(v) => setReverb({ decay: v }, true)}
        />
      </div>
    )}

    {dl && (
      <div className="fxbar">
        <span className="cp-tag fx">DELAY</span>
        <DragNumber
          label="Time"
          unit="ms"
          title="Delay time — longer is an echo"
          value={Math.round(dl.time * 1000)}
          min={DELAY_TIME_MIN * 1000}
          max={DELAY_TIME_MAX * 1000}
          perPx={4}
          decimals={0}
          onInput={(v) => setDelay({ time: v / 1000 }, false)}
          onCommit={(v) => setDelay({ time: v / 1000 }, true)}
        />
        <DragNumber
          label="Feedback"
          unit="%"
          title="How much of each repeat feeds back — capped at 90%"
          value={Math.round(dl.feedback * 100)}
          min={DELAY_FEEDBACK_MIN * 100}
          max={DELAY_FEEDBACK_MAX * 100}
          perPx={0.4}
          decimals={0}
          onInput={(v) => setDelay({ feedback: v / 100 }, false)}
          onCommit={(v) => setDelay({ feedback: v / 100 }, true)}
        />
        <DragNumber
          label="Mix"
          unit="%"
          title="Dry / wet balance"
          value={Math.round(dl.mix * 100)}
          min={MIX_MIN * 100}
          max={MIX_MAX * 100}
          perPx={0.5}
          decimals={0}
          onInput={(v) => setDelay({ mix: v / 100 }, false)}
          onCommit={(v) => setDelay({ mix: v / 100 }, true)}
        />
      </div>
    )}

    {pt && (
      <div className="fxbar">
        <span className="cp-tag fx">PITCH</span>
        <DragNumber
          label="Shift"
          unit="st"
          title="Pitch in semitones — length stays the same (Speed changes tempo, this does not)"
          value={pt.semitones}
          min={PITCH_SEMITONES_MIN}
          max={PITCH_SEMITONES_MAX}
          perPx={0.1}
          decimals={1}
          onInput={(v) => setPitch(quant(v), false)}
          onCommit={(v) => setPitch(quant(v), true)}
        />
      </div>
    )}
    </>
  )
}
