import type { VoiceSettings } from '@shared/domain'
import { isOverridden, knobText, KNOBS, fromSlider, toSlider } from './voice'

interface Props {
  value: VoiceSettings
  override?: Partial<VoiceSettings>
  onChange: (patch: Partial<VoiceSettings>) => void
  onResetOverride: () => void
  onGenerate: () => void
  onApprove: (approved: boolean) => void
  approved: boolean
  approveDisabled: boolean
  generating: boolean
  genDisabled: boolean
  genTitle: string
}

export function GenerateBar({
  value,
  override,
  onChange,
  onResetOverride,
  onGenerate,
  onApprove,
  approved,
  approveDisabled,
  generating,
  genDisabled,
  genTitle,
}: Props) {
  const modified = !!override && Object.keys(override).length > 0

  return (
    <div className="gen">
      <div className="knobs">
        {KNOBS.map((k) => {
          const on = isOverridden(override, k.key)
          return (
            <label key={k.key} className={'knob' + (on ? ' mod' : '')} title={k.title}>
              <span className="knob-l">
                {k.label}
                {on && <i className="knob-dot" />}
              </span>
              <input
                type="range"
                min={k.min}
                max={k.max}
                value={toSlider(value[k.key])}
                onChange={(e) => onChange({ [k.key]: fromSlider(Number(e.target.value)) })}
              />
              <span className="knob-v">{knobText(k, value[k.key])}</span>
            </label>
          )
        })}

        <label className={'knob tgl' + (isOverridden(override, 'boost') ? ' mod' : '')}>
          <input
            type="checkbox"
            checked={value.boost}
            onChange={(e) => onChange({ boost: e.target.checked })}
          />
          Boost
        </label>

        <button
          className="btn ghost knob-reset"
          onClick={onResetOverride}
          disabled={!modified}
          title={
            modified
              ? 'Reset this cue to the character defaults'
              : 'Using the character defaults'
          }
        >
          ↺ Reset
        </button>
      </div>

      <div className="gen-actions">
        <button className="btn primary" onClick={onGenerate} disabled={genDisabled} title={genTitle}>
          {generating ? <span className="spin" /> : '▶'} Generate <kbd>Ctrl+G</kbd>
        </button>
        <span className="sp" />
        <button
          className={approved ? 'btn ok' : 'btn ghost'}
          onClick={() => onApprove(!approved)}
          disabled={!approved && approveDisabled}
          title={approved ? 'Remove approval' : approveDisabled ? 'No voiced output' : 'Approve this cue'}
        >
          {approved ? '✓ Approved' : '✓ Approve'} <kbd>A</kbd>
        </button>
      </div>
    </div>
  )
}
