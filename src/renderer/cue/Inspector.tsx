import type { ClipEditPatch } from '@shared/domain'
import { ClipParams, type EffectName, type EffectsTarget } from './ClipParams'

interface Props {
  effects: EffectsTarget | null
  effectsLabel: string
  onClipEdit: (patch: ClipEditPatch, commit: boolean) => void
  onClipTrim: (edge: 'start' | 'end', at: number, commit: boolean) => void
  onClipEffect: (which: EffectName) => void
}

export function Inspector({
  effects,
  effectsLabel,
  onClipEdit,
  onClipTrim,
  onClipEffect,
}: Props) {
  return (
    <div className="insp">
      <div className="insp-tabs">
        <button className="insp-tab on">Effects</button>
      </div>

      <div className="insp-body">
        <ClipParams
          target={effects}
          emptyLabel={effectsLabel}
          onEdit={onClipEdit}
          onTrim={onClipTrim}
          onEffect={onClipEffect}
        />
      </div>
    </div>
  )
}
