import { useCallback, useMemo, useRef, type MutableRefObject } from 'react'
import { resolveVoiceSettings, type Character, type CompRegion, type Cue, type Take } from '@shared/domain'
import type { GenTarget } from '@shared/generation'
import type { AppSettings } from '@shared/ipc'
import { useVoiceToVoice, type RecordPlacement } from '../cue/useVoiceToVoice'
import { useWire } from '../cue/useWire'
import { TextPanel, type TextPanelProps } from './TextPanel'
import type { ClipSelection, CompApi } from './TimelinePanel'
import type { PrerollStart } from '../audio/recorder'

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
    placement?: RecordPlacement
  ) => Promise<void>
  recRef: MutableRefObject<(() => void) | null>
  punchRef: MutableRefObject<(() => void) | null>
  loopRef: MutableRefObject<(() => void) | null>
  escRef: MutableRefObject<(() => boolean) | null>
  recActiveRef: MutableRefObject<(() => boolean) | null>
  guardRef: MutableRefObject<((proceed: () => void) => boolean) | null>
  focusTextRef: MutableRefObject<(() => void) | null>
  appSettings: AppSettings
  onTakeAdded: (cueId: string, take: Take, explicit?: boolean) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  isActiveCue: (cueId: string) => boolean
  hasKey: boolean
  keepMicWarm: boolean
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
  loopRef,
  escRef,
  recActiveRef,
  guardRef,
  focusTextRef,
  appSettings,
  onTakeAdded,
  onStatus,
  isActiveCue,
  hasKey,
  keepMicWarm,
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
    (at: number, lead: number, onInterrupt: () => void): Promise<PrerollStart> =>
      compRef.current?.preroll(at, lead, onInterrupt) ?? Promise.resolve({ at: performance.now(), played: false }),
    [compRef]
  )
  const punchMark = useCallback((at: number | null) => compRef.current?.punchMark(at), [compRef])
  const region = useCallback((): CompRegion | null => compRef.current?.region() ?? null, [compRef])
  const loop = useCallback(
    (
      range: CompRegion,
      lead: number,
      onPass: (at: number) => void,
      onInterrupt: (early: boolean) => void
    ): Promise<PrerollStart> =>
      compRef.current?.loop(range, lead, onPass, onInterrupt) ?? Promise.reject(new Error('No timeline')),
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
    punchMark,
    region,
    loop,
    keepMicWarm,
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
  useWire(loopRef, v2v.loopRecord)
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
      arming={v2v.rec.phase === 'arming'}
      recordDisabled={v2v.converting}
      recMeter={
        v2v.rec.phase === 'recording'
          ? {
              elapsed: v2v.rec.elapsed,
              level: v2v.rec.level,
              clipped: v2v.rec.clipped,
              limit: v2v.rec.limit,
              ...(v2v.loopPass > 0 ? { pass: v2v.loopPass } : {}),
            }
          : undefined
      }
    />
  )
}
