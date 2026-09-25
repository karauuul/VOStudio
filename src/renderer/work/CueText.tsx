import { useCallback, useMemo, useRef, type MutableRefObject } from 'react'
import { resolveVoiceSettings, type Character, type Cue, type Take } from '@shared/domain'
import type { GenTarget } from '@shared/generation'
import type { AppSettings } from '@shared/ipc'
import { useVoiceToVoice, type PunchPlacement } from '../cue/useVoiceToVoice'
import { useWire } from '../cue/useWire'
import { TextPanel, type TextPanelProps } from './TextPanel'
import type { ClipSelection, CompApi } from './TimelinePanel'

export interface CueTextProps {
  cue: Cue
  character?: Character
  onGenerate: (kind: GenTarget['kind']) => void
  onSubmit: (cueId: string) => void
  cueBusy: boolean
  compRef: MutableRefObject<CompApi | null>
  onPlace: (
    cueId: string,
    take: Take,
    replaceClipId?: string,
    drop?: undefined,
    punch?: PunchPlacement
  ) => Promise<void>
  recRef: MutableRefObject<(() => void) | null>
  punchRef: MutableRefObject<(() => void) | null>
  escRef: MutableRefObject<(() => boolean) | null>
  recActiveRef: MutableRefObject<(() => boolean) | null>
  guardRef: MutableRefObject<((proceed: () => void) => boolean) | null>
  focusTextRef: MutableRefObject<(() => void) | null>
  appSettings: AppSettings
  onTakeAdded: (cueId: string, take: Take, explicit?: boolean) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  isActiveCue: (cueId: string) => boolean
  hasKey: boolean
  text: TextPanelProps
}

export function CueText({
  cue,
  character,
  onGenerate,
  onSubmit,
  cueBusy,
  compRef,
  onPlace,
  recRef,
  punchRef,
  escRef,
  recActiveRef,
  guardRef,
  focusTextRef,
  appSettings,
  onTakeAdded,
  onStatus,
  isActiveCue,
  hasKey,
  text,
}: CueTextProps) {
  const textRef = useRef<HTMLTextAreaElement>(null)
  const voice = useMemo(() => resolveVoiceSettings(character, cue), [character, cue])

  const noVoice = !character || !character.provider.voiceId
  const providerBlocked = !hasKey || noVoice
  const noVoiceReason = !hasKey
    ? 'API key missing — open Settings'
    : !character
      ? 'Cue has no character assigned'
      : noVoice
        ? `No voice configured for character "${character.name}"`
        : ''

  const selection = useCallback(
    (): ClipSelection | null => compRef.current?.selection() ?? null,
    [compRef]
  )
  const playhead = useCallback((): number => compRef.current?.playhead() ?? 0, [compRef])
  const targetTrack = useCallback((): string | undefined => compRef.current?.targetTrack(), [compRef])
  const preroll = useCallback(
    (at: number, lead: number, onInterrupt: () => void): Promise<number> =>
      compRef.current?.preroll(at, lead, onInterrupt) ?? Promise.resolve(performance.now()),
    [compRef]
  )

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
    playhead,
    targetTrack,
    preroll,
    onPlace,
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
  useWire(punchRef, v2v.punch)
  useWire(escRef, v2v.onEscape)
  useWire(recActiveRef, recActive)
  useWire(guardRef, v2v.guard)
  useWire(focusTextRef, focusText)

  return (
    <TextPanel
      {...text}
      textRef={textRef}
      generating={cueBusy}
      genDisabled={cueBusy || providerBlocked}
      onGenerate={onGenerate}
      onHoverGenerate={(on) => compRef.current?.ghost(on ? { generate: true } : null)}
      onRecord={v2v.toggleRec}
      recording={v2v.rec.phase !== 'idle'}
      recordDisabled={v2v.converting}
      recMeter={
        v2v.rec.phase === 'recording'
          ? { elapsed: v2v.rec.elapsed, level: v2v.rec.level, clipped: v2v.rec.clipped, limit: v2v.rec.limit }
          : undefined
      }
    />
  )
}
