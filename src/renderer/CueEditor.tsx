import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import {
  resolveVoiceSettings,
  type Character,
  type Cue,
  type CueComp,
  type Take,
  type Term,
} from '@shared/domain'
import { isEmptyComp } from '@shared/comp'
import { applyRules } from '@shared/pronunciation'
import type { PreviewSource, ResolvedPreview } from '@shared/workspace-source'
import type { AppSettings } from '@shared/ipc'
import type { WaveformHandle } from './Waveform'
import type { EffectsTarget } from './cue/ClipParams'
import { CueHeader } from './cue/CueHeader'
import { CreateBar } from './cue/CreateBar'
import { compositionLabel } from './cue/shared'
import { TakeSourceMenu } from './cue/TakeSourceMenu'
import { TextBlock, type CopyKind } from './cue/TextBlock'
import { useFragment } from './cue/useFragment'
import { useVoiceToVoice } from './cue/useVoiceToVoice'
import { useWire } from './cue/useWire'
import { WaveLanes, type ClipSelection, type CompApi } from './cue/WaveLanes'

type SplitMode = 'review' | 'timeline'

const SPLIT_KEY: Record<SplitMode, string> = {
  review: 'vo.script.h.review',
  timeline: 'vo.script.h.timeline',
}

const SCRIPT_MIN = 150
const AUDIO_MIN = 240
const SPLIT_STEP = 12

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

function readHeight(mode: SplitMode): number | null {
  try {
    const v = parseInt(localStorage.getItem(SPLIT_KEY[mode]) ?? '', 10)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

function defaultHeight(mode: SplitMode, avail: number): number {
  return mode === 'timeline'
    ? clamp(Math.round(avail * 0.28), SCRIPT_MIN, 220)
    : clamp(Math.round(avail * 0.4), 210, 360)
}

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
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>
  timelineOpen: boolean
  onTimeline: () => void
  onEffectsTarget: (target: EffectsTarget | null) => void
  recRef: MutableRefObject<((fragment?: boolean) => void) | null>
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
  timelineOpen,
  onTimeline,
  onEffectsTarget,
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
  const splitRef = useRef<HTMLDivElement>(null)
  const [avail, setAvail] = useState(0)
  const [stored, setStored] = useState<Record<SplitMode, number | null>>(() => ({
    review: readHeight('review'),
    timeline: readHeight('timeline'),
  }))

  const mode: SplitMode = timelineOpen ? 'timeline' : 'review'
  const maxScript = Math.max(SCRIPT_MIN, avail - AUDIO_MIN)
  const scriptH =
    avail > 0 ? clamp(stored[mode] ?? defaultHeight(mode, avail), SCRIPT_MIN, maxScript) : 0

  useEffect(() => {
    const el = splitRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setAvail(el.clientHeight))
    ro.observe(el)
    setAvail(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const setHeight = useCallback(
    (v: number) => {
      const h = clamp(Math.round(v), SCRIPT_MIN, maxScript)
      try {
        localStorage.setItem(SPLIT_KEY[mode], String(h))
      } catch {
      }
      setStored((s) => (s[mode] === h ? s : { ...s, [mode]: h }))
    },
    [mode, maxScript]
  )

  const resetHeight = useCallback(() => {
    try {
      localStorage.removeItem(SPLIT_KEY[mode])
    } catch {
    }
    setStored((s) => ({ ...s, [mode]: null }))
  }, [mode])

  const startSplit = useCallback(
    (e: ReactMouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const y0 = e.clientY
      const h0 = scriptH
      document.body.classList.add('resizing-v')
      const move = (ev: MouseEvent): void => setHeight(h0 + ev.clientY - y0)
      const up = (): void => {
        document.body.classList.remove('resizing-v')
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [scriptH, setHeight]
  )

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

  const pickerProps = {
    cue,
    source: preview.source,
    onSelect: onSelectSource,
    onGenerate,
    onDetails,
    onDelete: onDeleteTake,
    onReconvert: v2v.reconvert,
    converting: v2v.converting,
    genDisabled: cueBusy || !cue.text.trim() || noVoice,
    genTitle,
    noVoiceReason,
  }

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

      <div className="ed-split" ref={splitRef}>
        <div className="ed-script" style={avail > 0 ? { height: scriptH } : undefined}>
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
        </div>

        <div
          className="vsplit"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize script and audio"
          tabIndex={0}
          onMouseDown={startSplit}
          onDoubleClick={resetHeight}
          onKeyDown={(e) => {
            if (e.code !== 'ArrowUp' && e.code !== 'ArrowDown') return
            e.preventDefault()
            e.stopPropagation()
            setHeight(scriptH + (e.code === 'ArrowDown' ? SPLIT_STEP : -SPLIT_STEP))
          }}
        />

        <WaveLanes
          cue={cue}
          preview={preview}
          sourceHeader={
            <TakeSourceMenu
              {...pickerProps}
              label={
                timelineOpen &&
                (preview.source.kind === 'comp' ||
                  (!!preview.take && preview.take.kind !== 'recording' && isEmptyComp(cue.comp)))
                  ? compositionLabel(cue)
                  : undefined
              }
            />
          }
          insertMenu={
            <TakeSourceMenu
              {...pickerProps}
              variant="insert"
              onInsert={(take) => compRef.current?.insertTake(take)}
            />
          }
          timelineOpen={timelineOpen}
          onTimeline={onTimeline}
          origRef={origRef}
          takeRef={takeRef}
          abRef={abRef}
          compRef={compRef}
          onComp={onComp}
          onStatus={onStatus}
          onEffectsTarget={onEffectsTarget}
          busyClipId={fragment.busyClipId}
          onFragmentText={fragment.generate}
        />
      </div>
    </div>
  )
}
