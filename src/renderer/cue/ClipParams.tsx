import { GAIN_MAX_DB, GAIN_MIN_DB, MIN_CLIP_SRC, SPEED_MAX, SPEED_MIN } from '@shared/comp'
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
import { DragNumber } from './DragNumber'

export type EffectName = 'reverb' | 'delay' | 'pitch'

export interface EffectsTarget {
  label: string
  clip: CompClip
  sourceDuration: number
  busy: boolean
}

const FX_LABEL: Record<EffectName, string> = { reverb: 'Reverb', delay: 'Delay', pitch: 'Pitch' }

interface Props {
  target: EffectsTarget | null
  emptyLabel: string
  onEdit: (patch: Partial<ClipEdits>, commit: boolean) => void
  onTrim: (edge: 'start' | 'end', at: number, commit: boolean) => void
  onEffect: (which: EffectName) => void
  onEditAsComposition?: () => void
}

export function ClipParams({
  target,
  emptyLabel,
  onEdit,
  onTrim,
  onEffect,
  onEditAsComposition,
}: Props) {
  if (!target) {
    return (
      <div className="insp-pad">
        <div className="insp-h">Target</div>
        <div className="fx-target">{emptyLabel}</div>
        {onEditAsComposition && (
          <div className="insp-actions">
            <button className="btn ghost" onClick={onEditAsComposition}>
              Edit as composition <kbd>D</kbd>
            </button>
          </div>
        )}
      </div>
    )
  }

  const clip = target.clip
  const e = clip.edits
  const fadeIn = e.fadeIn
  const fadeOut = e.fadeOut
  const fx = e.effects
  const rv = fx?.reverb
  const dl = fx?.delay
  const pt = fx?.pitch
  const speed = clipSpeed(e)
  const srcMax = target.sourceDuration > 0 ? target.sourceDuration : clip.srcOut

  const setReverb = (patch: Partial<ReverbEffect>, commit: boolean): void => {
    if (!fx?.reverb) return
    onEdit({ effects: { ...fx, reverb: { ...fx.reverb, ...patch } } }, commit)
  }
  const setDelay = (patch: Partial<DelayEffect>, commit: boolean): void => {
    if (!fx?.delay) return
    onEdit({ effects: { ...fx, delay: { ...fx.delay, ...patch } } }, commit)
  }
  const setPitch = (semitones: number, commit: boolean): void => {
    if (!fx?.pitch) return
    onEdit({ effects: { ...fx, pitch: { semitones: Math.round(semitones / PITCH_STEP) * PITCH_STEP } } }, commit)
  }

  const missing = (['reverb', 'delay', 'pitch'] as EffectName[]).filter((k) => !fx?.[k])

  return (
    <div className="insp-pad">
      <div className="insp-h">Target</div>
      <div className="fx-target">
        {target.busy && <i className="spin" />}
        {target.label}
      </div>

      <DragNumber
        label="Gain"
        unit="dB"
        value={e.gainDb ?? 0}
        min={GAIN_MIN_DB}
        max={GAIN_MAX_DB}
        perPx={0.2}
        decimals={1}
        onInput={(v) => onEdit({ gainDb: v }, false)}
        onCommit={(v) => onEdit({ gainDb: v }, true)}
      />
      <DragNumber
        label="Speed"
        unit="×"
        value={speed}
        min={SPEED_MIN}
        max={SPEED_MAX}
        perPx={0.01}
        decimals={2}
        onInput={(v) => onEdit({ timeStretch: v }, false)}
        onCommit={(v) => onEdit({ timeStretch: v }, true)}
      />
      <DragNumber
        label="Fade in"
        unit="ms"
        value={Math.round(fadeIn.duration * 1000)}
        min={0}
        max={10000}
        perPx={5}
        decimals={0}
        onInput={(v) => onEdit({ fadeIn: { ...fadeIn, duration: v / 1000 } }, false)}
        onCommit={(v) => onEdit({ fadeIn: { ...fadeIn, duration: v / 1000 } }, true)}
      />
      <DragNumber
        label="Fade out"
        unit="ms"
        value={Math.round(fadeOut.duration * 1000)}
        min={0}
        max={10000}
        perPx={5}
        decimals={0}
        onInput={(v) => onEdit({ fadeOut: { ...fadeOut, duration: v / 1000 } }, false)}
        onCommit={(v) => onEdit({ fadeOut: { ...fadeOut, duration: v / 1000 } }, true)}
      />

      <div className="insp-h">Clip</div>
      <DragNumber
        label="Trim in"
        unit="s"
        value={clip.srcIn}
        min={0}
        max={Math.max(0, clip.srcOut - MIN_CLIP_SRC)}
        perPx={0.01 * speed}
        decimals={3}
        onInput={(v) => onTrim('start', v, false)}
        onCommit={(v) => onTrim('start', v, true)}
      />
      <DragNumber
        label="Trim out"
        unit="s"
        value={clip.srcOut}
        min={clip.srcIn + MIN_CLIP_SRC}
        max={srcMax}
        perPx={0.01 * speed}
        decimals={3}
        onInput={(v) => onTrim('end', v, false)}
        onCommit={(v) => onTrim('end', v, true)}
      />

      {missing.length > 0 && (
        <div className="fx-add">
          <span className="cp-k">+ Effect</span>
          {missing.map((k) => (
            <button key={k} className="btn ghost" onClick={() => onEffect(k)}>
              {FX_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      {rv && (
        <>
          <div className="insp-h">
            Reverb
            <button className="icon-btn fx-off" onClick={() => onEffect('reverb')}>
              ×
            </button>
          </div>
          <DragNumber
            label="Mix"
            unit="%"
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
            value={rv.decay}
            min={REVERB_DECAY_MIN}
            max={REVERB_DECAY_MAX}
            perPx={0.02}
            decimals={2}
            onInput={(v) => setReverb({ decay: v }, false)}
            onCommit={(v) => setReverb({ decay: v }, true)}
          />
        </>
      )}

      {dl && (
        <>
          <div className="insp-h">
            Delay
            <button className="icon-btn fx-off" onClick={() => onEffect('delay')}>
              ×
            </button>
          </div>
          <DragNumber
            label="Time"
            unit="ms"
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
            value={Math.round(dl.mix * 100)}
            min={MIX_MIN * 100}
            max={MIX_MAX * 100}
            perPx={0.5}
            decimals={0}
            onInput={(v) => setDelay({ mix: v / 100 }, false)}
            onCommit={(v) => setDelay({ mix: v / 100 }, true)}
          />
        </>
      )}

      {pt && (
        <>
          <div className="insp-h">
            Pitch
            <button className="icon-btn fx-off" onClick={() => onEffect('pitch')}>
              ×
            </button>
          </div>
          <DragNumber
            label="Shift"
            unit="st"
            value={pt.semitones}
            min={PITCH_SEMITONES_MIN}
            max={PITCH_SEMITONES_MAX}
            perPx={0.1}
            decimals={1}
            onInput={(v) => setPitch(v, false)}
            onCommit={(v) => setPitch(v, true)}
          />
        </>
      )}
    </div>
  )
}
