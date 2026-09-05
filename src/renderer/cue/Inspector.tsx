import type { Character, CueComp, Take, VoiceSettings } from '@shared/domain'
import { compDuration } from '@shared/comp'
import { fmt } from '../Waveform'
import { stamp } from './shared'
import { knobText, KNOBS } from './voice'
import { VoicePanel } from './VoicePanel'

export type InspectorTab = 'take' | 'voice'

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'voice', label: 'Voice' },
  { id: 'take', label: 'Take' },
]

interface Props {
  tab: InspectorTab
  onTab: (tab: InspectorTab) => void
  take?: Take
  comp?: CueComp
  isFinal: boolean
  canSetFinal: boolean
  onSetFinal: () => void
  onDelete: () => void
  character?: Character
  voice: VoiceSettings
  voiceOverride?: Partial<VoiceSettings>
  onVoiceChange: (patch: Partial<VoiceSettings>) => void
  onVoiceReset: () => void
  onVoiceDefault: () => void
}

export function Inspector({
  tab,
  onTab,
  take,
  comp,
  isFinal,
  canSetFinal,
  onSetFinal,
  onDelete,
  character,
  voice,
  voiceOverride,
  onVoiceChange,
  onVoiceReset,
  onVoiceDefault,
}: Props) {
  return (
    <div className="insp">
      <div className="insp-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={'insp-tab' + (tab === t.id ? ' on' : '')}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="insp-body">
        {tab === 'take' && (
          <TakeTab
            take={take}
            comp={comp}
            isFinal={isFinal}
            canSetFinal={canSetFinal}
            onSetFinal={onSetFinal}
            onDelete={onDelete}
          />
        )}

        {tab === 'voice' && (
          <VoicePanel
            character={character}
            value={voice}
            override={voiceOverride}
            onChange={onVoiceChange}
            onReset={onVoiceReset}
            onUseAsDefault={onVoiceDefault}
          />
        )}
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
  comp,
  isFinal,
  canSetFinal,
  onSetFinal,
  onDelete,
}: {
  take?: Take
  comp?: CueComp
  isFinal: boolean
  canSetFinal: boolean
  onSetFinal: () => void
  onDelete: () => void
}) {
  if (!take) {
    if (!comp) return <div className="insp-empty">No take selected</div>
    return (
      <div className="insp-pad">
        <Row label="Source" value="Composition" />
        <Row label="Clips" value={String(comp.clips.length)} />
        <Row label="Duration" value={fmt(compDuration(comp))} />
        <Row label="Final" value={isFinal ? 'yes' : 'no'} />
        <div className="insp-actions">
          <button className="btn ghost" onClick={onSetFinal} disabled={!canSetFinal}>
            Set final <kbd>F</kbd>
          </button>
        </div>
      </div>
    )
  }

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

