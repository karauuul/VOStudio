import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from 'react'
import {
  resolveVoiceSettings,
  type Character,
  type Cue,
  type CueComp,
  type Take,
  type Term,
  type VoiceSettings,
} from '@shared/domain'
import type { PreviewSource, ResolvedPreview } from '@shared/workspace-source'
import { approvalState, hasValidVoicedOutput } from '@shared/approval'
import type { AppSettings } from '@shared/ipc'
import { api, audioUrl } from './api'
import { clipId, transport } from './audio/transport'
import type { WaveformHandle } from './Waveform'
import { CueHeader } from './cue/CueHeader'
import { GenerateBar } from './cue/GenerateBar'
import { RecordBar } from './cue/RecordBar'
import { TakesStrip } from './cue/TakesStrip'
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
  onAcceptSuggestion: () => void
  onRejectSuggestion: () => void
  onVoiceChange: (patch: Partial<VoiceSettings>) => void
  onVoiceReset: () => void
  cueBusy: boolean
  origRef: MutableRefObject<WaveformHandle | null>
  takeRef: MutableRefObject<WaveformHandle | null>
  abRef: MutableRefObject<(() => void) | null>
  compRef: MutableRefObject<CompApi | null>
  onComp: (cueId: string, comp: CueComp | null) => void
  recRef: MutableRefObject<(() => void) | null>
  escRef: MutableRefObject<(() => boolean) | null>
  focusTextRef: MutableRefObject<(() => void) | null>
  appSettings: AppSettings
  onAppSettings: (s: AppSettings) => void
  onTakeAdded: (cueId: string, take: Take) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  isActiveCue: (cueId: string) => boolean
  rulesVersion: string
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
  onAcceptSuggestion,
  onRejectSuggestion,
  onVoiceChange,
  onVoiceReset,
  cueBusy,
  origRef,
  takeRef,
  abRef,
  compRef,
  onComp,
  recRef,
  escRef,
  focusTextRef,
  appSettings,
  onAppSettings,
  onTakeAdded,
  onStatus,
  isActiveCue,
  rulesVersion,
}: Props) {
  const [spoken, setSpoken] = useState('')
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setSpoken('')
  }, [cue.id])

  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      void api['rules:preview'](cue.text).then((p) => {
        if (!cancelled) setSpoken(p)
      })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [cue.text, cue.id, rulesVersion])

  const voice = useMemo(() => resolveVoiceSettings(character, cue), [character, cue])

  const noVoice = !character || !character.provider.voiceId
  const noVoiceReason = !character
    ? 'Cue has no character assigned'
    : noVoice
      ? `No voice configured for character "${character.name}"`
      : ''

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

  const audition = useCallback((take: Take) => {
    void transport.playClip({ id: clipId.take(take.id), url: audioUrl(take.file.relPath) }, 0)
  }, [])

  useWire(recRef, v2v.toggleRec)
  useWire(escRef, v2v.onEscape)
  useWire(focusTextRef, focusText)

  return (
    <div className="editor">
      <CueHeader cue={cue} character={character} characters={characters} onCharacter={onCharacter} />

      <WaveLanes
        cue={cue}
        preview={preview}
        origRef={origRef}
        takeRef={takeRef}
        abRef={abRef}
        compRef={compRef}
        onComp={onComp}
        onStatus={onStatus}
        busyClipId={fragment.busyClipId}
        onFragmentText={fragment.generate}
      />

      <TextBlock
        cue={cue}
        terms={terms}
        textRef={textRef}
        onText={onText}
        onCopy={onCopy}
        onAcceptSuggestion={onAcceptSuggestion}
        onRejectSuggestion={onRejectSuggestion}
        preview={spoken}
      />

      <GenerateBar
        value={voice}
        override={cue.voiceSettingsOverride}
        onChange={onVoiceChange}
        onResetOverride={onVoiceReset}
        onGenerate={onGenerate}
        onApprove={onApprove}
        onApproveNext={onApproveNext}
        approved={approvalState(cue) === 'approved'}
        approveDisabled={!hasValidVoicedOutput(cue)}
        generating={cueBusy}
        genDisabled={cueBusy || !cue.text.trim() || noVoice}
        genTitle={
          noVoice ? noVoiceReason : cueBusy ? 'Already in the queue' : 'Generate a new take'
        }
      />

      <RecordBar
        rec={v2v.rec}
        appSettings={appSettings}
        onAppSettings={onAppSettings}
        onToggle={v2v.toggleRec}
        onConvert={v2v.convertClip}
        converting={v2v.converting}
        convertBlockedReason={v2v.convertBlocked}
        preroll={v2v.preroll}
      />

      <TakesStrip
        cue={cue}
        source={preview.source}
        onSelect={onSelectSource}
        onAudition={audition}
        onReconvert={v2v.reconvert}
        converting={v2v.converting}
        noVoiceReason={noVoiceReason}
      />
    </div>
  )
}
