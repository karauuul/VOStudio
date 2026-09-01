import { useState } from 'react'
import type { Character, Take, VoiceSettings } from '@shared/domain'
import { RulesPanel } from '../RulesPanel'
import { fmt } from '../Waveform'
import { stamp } from './shared'
import { knobText, KNOBS, fromSlider, toSlider } from './voice'

export type InspectorTab = 'take' | 'voice' | 'rules'

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'take', label: 'Take' },
  { id: 'voice', label: 'Voice' },
  { id: 'rules', label: 'Rules' },
]

interface Props {
  take?: Take
  isFinal: boolean
  canSetFinal: boolean
  onSetFinal: () => void
  onDelete: () => void
  character?: Character
  onCharacterVoice: (settings: VoiceSettings) => void
  rules: string
  onRulesSaved: (text: string) => void
}

export function Inspector({
  take,
  isFinal,
  canSetFinal,
  onSetFinal,
  onDelete,
  character,
  onCharacterVoice,
  rules,
  onRulesSaved,
}: Props) {
  const [tab, setTab] = useState<InspectorTab>('take')

  return (
    <div className="insp">
      <div className="insp-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={'insp-tab' + (tab === t.id ? ' on' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="insp-body">
        {tab === 'take' && (
          <TakeTab
            take={take}
            isFinal={isFinal}
            canSetFinal={canSetFinal}
            onSetFinal={onSetFinal}
            onDelete={onDelete}
          />
        )}

        {tab === 'voice' && (
          <VoiceTab character={character} onChange={onCharacterVoice} />
        )}

        {tab === 'rules' && <RulesPanel rules={rules} onSaved={onRulesSaved} />}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv">
      <span className="kv-k">{label}</span>
      <span className="kv-v">{value}</span>
    </div>
  )
}

function TakeTab({
  take,
  isFinal,
  canSetFinal,
  onSetFinal,
  onDelete,
}: {
  take?: Take
  isFinal: boolean
  canSetFinal: boolean
  onSetFinal: () => void
  onDelete: () => void
}) {
  if (!take) return <div className="insp-empty">No take selected</div>

  const vs = take.meta.voiceSettings

  return (
    <div className="insp-pad">
      <Row label="Kind" value={take.kind} />
      <Row label="Created" value={stamp(take.createdAt)} />
      <Row label="Duration" value={fmt(take.duration)} />
      <Row label="Format" value={take.file.format.toUpperCase()} />
      {take.meta.model && <Row label="Model" value={take.meta.model} />}
      {isFinal && <Row label="Final" value="★ yes" />}

      {vs && (
        <>
          <div className="insp-h">Generated with</div>
          {KNOBS.map((k) => (
            <Row key={k.key} label={k.title} value={knobText(k, vs[k.key])} />
          ))}
          <Row label="Speaker boost" value={vs.boost ? 'on' : 'off'} />
        </>
      )}

      <div className="insp-actions">
        <button
          className="btn ghost"
          onClick={onSetFinal}
          disabled={!canSetFinal}
          title={
            isFinal
              ? 'Already the final take'
              : canSetFinal
                ? 'Make this the final take'
                : 'A raw recording cannot be final — convert it first'
          }
        >
          ★ Set final <kbd>F</kbd>
        </button>
        <button
          className="btn danger"
          onClick={onDelete}
          disabled={isFinal}
          title={isFinal ? 'The final take cannot be deleted' : 'Remove from the strip'}
        >
          Delete <kbd>Del</kbd>
        </button>
      </div>
    </div>
  )
}

function VoiceTab({
  character,
  onChange,
}: {
  character?: Character
  onChange: (s: VoiceSettings) => void
}) {
  if (!character) return <div className="insp-empty">No character for this cue</div>

  const v = character.voiceSettings

  return (
    <div className="insp-pad">
      <div className="insp-h">
        <span className="char-dot" style={{ background: character.color }} />
        {character.name} defaults
      </div>

      {KNOBS.map((k) => (
        <label key={k.key} className="knob wide" title={k.title}>
          <span className="knob-l">{k.title}</span>
          <input
            type="range"
            min={k.min}
            max={k.max}
            value={toSlider(v[k.key])}
            onChange={(e) => onChange({ ...v, [k.key]: fromSlider(Number(e.target.value)) })}
          />
          <span className="knob-v">{knobText(k, v[k.key])}</span>
        </label>
      ))}

      <label className="tgl insp-tgl">
        <input
          type="checkbox"
          checked={v.boost}
          onChange={(e) => onChange({ ...v, boost: e.target.checked })}
        />
        Speaker boost
      </label>

      <Row label="Voice ID" value={character.provider.voiceId || '— not set —'} />
      <Row label="TTS model" value={character.provider.ttsModel} />
    </div>
  )
}
