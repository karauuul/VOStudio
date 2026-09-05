import { useCallback, useMemo, useRef, type MutableRefObject } from 'react'
import {
  resolveVoiceSettings,
  type Character,
  type Cue,
  type CueComp,
  type Take,
  type Term,
} from '@shared/domain'
import { applyRules } from '@shared/pronunciation'
import type { PreviewSource, ResolvedPreview } from '@shared/workspace-source'
import type { AppSettings } from '@shared/ipc'
import type { WaveformHandle } from './Waveform'
import { CueHeader } from './cue/CueHeader'
import { CreateBar } from './cue/CreateBar'
import { TakeSourceMenu } from './cue/TakeSourceMenu'
import { TextBlock, type CopyKind } from './cue/TextBlock'
import { useFragment } from './cue/useFragment'
import { useVoiceToVoice } from './cue/useVoiceToVoice'
import { useWire } from './cue/useWire'
import { WaveLanes, type ClipSelection, type CompApi } from './cue/WaveLanes'

interface Props {
  cue: Cue
  character?: Character
  characters: Character[]
  onCharacter: (characterId: string) => void
  preview: ResolvedPreview
  onSelectSource: (source: PreviewSource) => void
  onText: (text: string) => void
  onCopy: (kind: CopyKind) => void
  terms: Term[]
  onGenerate: () => void
  onApprove: (approved: boolean) => void
  onApproveNext: () => void
  onSetFinal: () => void
  onDetails: () => void
  onDeleteTake: (takeId: string) => void
  onSubmit: (cueId: string) => void
  onAcceptSuggestion: () => void
  onRejectSuggestion: () => void
  cueBusy: boolean
  origRef: MutableRefObject<WaveformHandle | null>
  takeRef: MutableRefObject<WaveformHandle | null>
  abRef: MutableRefObject<(() => void) | null>
  compRef: MutableRefObject<CompApi | null>
  onComp: (cueId: string, comp: CueComp | null) => void
  recRef: MutableRefObject<(() => void) | null>
  escRef: MutableRefObject<(() => boolean) | null>
  recActiveRef: MutableRefObject<(() => boolean) | null>
  guardRef: MutableRefObject<((proceed: () => void) => boolean) | null>
  focusTextRef: MutableRefObject<(() => void) | null>
  appSettings: AppSettings
  onAppSettings: (s: AppSettings) => void
  onTakeAdded: (cueId: string, take: Take, explicit?: boolean) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  isActiveCue: (cueId: string) => boolean
  rules: string
}

export function CueEditor({
  cue,
  character,
  characters,
  onCharacter,
  preview,
  onSelectSource,
  onText,
  onCopy,
  terms,
  onGenerate,
  onApprove,
  onApproveNext,
  onSetFinal,
  onDetails,
  onDeleteTake,
  onSubmit,
  onAcceptSuggestion,
  onRejectSuggestion,
  cueBusy,
  origRef,
  takeRef,
  abRef,
  compRef,
  onComp,
  recRef,
  escRef,
  recActiveRef,
  guardRef,
  focusTextRef,
  appSettings,
  onAppSettings,
  onTakeAdded,
  onStatus,
  isActiveCue,
  rules,
}: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null)

  const spoken = useMemo(() => applyRules(cue.text, rules), [cue.text, rules])

  const voice = useMemo(() => resolveVoiceSettings(character, cue), [character, cue])

  const noVoice = !character || !character.provider.voiceId
  const noVoiceReason = !character
    ? 'Cue has no character assigned'
    : noVoice
      ? `No voice configured for character "${character.name}"`
      : ''
  const genTitle = noVoice ? noVoiceReason : cueBusy ? 'Already in the queue' : 'Generate a new take'

  const fragment = useFragment({
    cue,
    voice,
    compRef,
    onTakeAdded,
    onStatus,
    isActiveCue,
    noVoiceReason,
  })

  const selection = useCallback((): ClipSelection | null => compRef.current?.selection() ?? null, [
    compRef,
  ])

  const v2v = useVoiceToVoice({
    cue,
    voice,
    appSettings,
    onTakeAdded,
    onSubmit,
    onStatus,
    isActiveCue,
    noVoiceReason,
    selection,
    fragment,
  })

  const focusText = useCallback(() => {
    const el = textRef.current
    if (!el) return
    el.focus()
    const n = el.value.length
    el.setSelectionRange(n, n)
  }, [])

  const recActive = useCallback(() => v2v.rec.phase !== 'idle', [v2v.rec.phase])

  useWire(recRef, v2v.toggleRec)
  useWire(escRef, v2v.onEscape)
  useWire(recActiveRef, recActive)
  useWire(guardRef, v2v.guard)
  useWire(focusTextRef, focusText)

  return (
    <div className="editor">
      <CueHeader
        cue={cue}
        character={character}
        characters={characters}
        onCharacter={onCharacter}
        source={preview.source}
        onApprove={onApprove}
        onApproveNext={onApproveNext}
        onSetFinal={onSetFinal}
      />

      <TextBlock
        cue={cue}
        terms={terms}
        textRef={textRef}
        onText={onText}
        onCopy={onCopy}
        onAcceptSuggestion={onAcceptSuggestion}
        onRejectSuggestion={onRejectSuggestion}
        spoken={spoken}
      />

      <CreateBar
        onGenerate={onGenerate}
        generating={cueBusy}
        genDisabled={cueBusy || !cue.text.trim() || noVoice}
        genTitle={genTitle}
        v2v={v2v}
        appSettings={appSettings}
        onAppSettings={onAppSettings}
      />

      <WaveLanes
        cue={cue}
        preview={preview}
        sourceHeader={
          <TakeSourceMenu
            cue={cue}
            source={preview.source}
            onSelect={onSelectSource}
            onGenerate={onGenerate}
            onDetails={onDetails}
            onDelete={onDeleteTake}
            onReconvert={v2v.reconvert}
            converting={v2v.converting}
            genDisabled={cueBusy || !cue.text.trim() || noVoice}
            genTitle={genTitle}
            noVoiceReason={noVoiceReason}
          />
        }
        origRef={origRef}
        takeRef={takeRef}
        abRef={abRef}
        compRef={compRef}
        onComp={onComp}
        onStatus={onStatus}
        busyClipId={fragment.busyClipId}
        onFragmentText={fragment.generate}
      />
    </div>
  )
}
