import { useState } from 'react'
import type { Character, VoiceSettings } from '@shared/domain'
import { fromSlider, isOverridden, knobText, KNOBS, toSlider } from './voice'

interface Props {
  character?: Character
  value: VoiceSettings
  override?: Partial<VoiceSettings>
  onChange: (patch: Partial<VoiceSettings>) => void
  onReset: () => void
  onUseAsDefault: () => void
}

export function VoicePanel({
  character,
  value,
  override,
  onChange,
  onReset,
  onUseAsDefault,
}: Props) {
  const [confirm, setConfirm] = useState(false)

  if (!character) return <div className="insp-empty">No character for this cue</div>

  const modified = !!override && Object.keys(override).length > 0

  return (
    <div className="insp-pad">
      <div className="insp-h">
        <span className="char-dot" style={{ background: character.color }} />
        {character.name} · this cue
      </div>

      {KNOBS.map((k) => {
        const on = isOverridden(override, k.key)
        return (
          <label key={k.key} className={'knob wide' + (on ? ' mod' : '')} title={k.title}>
            <span className="knob-l">
              {k.title}
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

      <label className={'tgl insp-tgl' + (isOverridden(override, 'boost') ? ' mod' : '')}>
        <input
          type="checkbox"
          checked={value.boost}
          onChange={(e) => onChange({ boost: e.target.checked })}
        />
        Speaker boost
      </label>

      <div className="kv">
        <span className="kv-k">Voice ID</span>
        <span className="kv-v">{character.provider.voiceId || '— not set —'}</span>
      </div>
      <div className="kv">
        <span className="kv-k">TTS model</span>
        <span className="kv-v">{character.provider.ttsModel}</span>
      </div>

      <div className="insp-actions">
        <button
          className="btn ghost"
          onClick={onReset}
          disabled={!modified}
          title={modified ? 'Back to the character defaults' : 'Using the character defaults'}
        >
          ↺ Reset override
        </button>
        {confirm ? (
          <>
            <button
              className="btn primary"
              onClick={() => {
                setConfirm(false)
                onUseAsDefault()
              }}
            >
              Set for {character.name}
            </button>
            <button className="btn ghost" autoFocus onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn ghost" onClick={() => setConfirm(true)}>
            Use as default
          </button>
        )}
      </div>
    </div>
  )
}
