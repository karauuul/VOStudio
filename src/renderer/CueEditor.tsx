import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react'
import { resolveVoiceSettings, type Character, type Cue, type CueComp, type Take } from '@shared/domain'
import { isEmptyComp } from '@shared/comp'
import type { GenTarget } from '@shared/generation'
import type { PreviewSource, ResolvedPreview } from '@shared/workspace-source'
import type { AppSettings } from '@shared/ipc'
import type { EffectsTarget } from './cue/ClipParams'
import { compositionLabel } from './cue/shared'
import { TakeSourceMenu } from './cue/TakeSourceMenu'
import { useVoiceToVoice } from './cue/useVoiceToVoice'
import { useWire } from './cue/useWire'
import { WaveLanes, type ClipSelection, type CompApi } from './cue/WaveLanes'
import { TextPanel, type TextPanelProps } from './work/TextPanel'

type SplitMode = 'review' | 'timeline'

const SPLIT_KEY: Record<SplitMode, string> = {
  review: 'vo.script.h.review',
  timeline: 'vo.script.h.timeline',
}

const SCRIPT_MIN = 260
const SCRIPT_DEF = 374
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

interface Props {
  cue: Cue
  cues: Cue[]
  character?: Character
  preview: ResolvedPreview
  onSelectSource: (source: PreviewSource) => void
  onGenerate: (kind: GenTarget['kind']) => void
  onDetails: () => void
  onDeleteTake: (takeId: string) => void
  onSubmit: (cueId: string) => void
  cueBusy: boolean
  compRef: MutableRefObject<CompApi | null>
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>
  onPlace: (cueId: string, take: Take, replaceClipId?: string) => Promise<void>
  replaceClipId?: string
  timelineOpen: boolean
  onTimeline: () => void
  onEffectsTarget: (target: EffectsTarget | null) => void
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
  hasKey: boolean
  text: TextPanelProps
}

export function CueEditor({
  cue,
  cues,
  character,
  preview,
  onSelectSource,
  onGenerate,
  onDetails,
  onDeleteTake,
  onSubmit,
  cueBusy,
  compRef,
  onComp,
  onPlace,
  replaceClipId,
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
  hasKey,
  text,
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
  const scriptH = avail > 0 ? clamp(stored[mode] ?? SCRIPT_DEF, SCRIPT_MIN, maxScript) : 0

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
  useWire(escRef, v2v.onEscape)
  useWire(recActiveRef, recActive)
  useWire(guardRef, v2v.guard)
  useWire(focusTextRef, focusText)

  const pickerProps = {
    cue,
    source: preview.source,
    onSelect: onSelectSource,
    onGenerate: () => onGenerate('all'),
    onDetails,
    onDelete: onDeleteTake,
    onReconvert: v2v.reconvert,
    converting: v2v.converting,
    genDisabled: cueBusy || !cue.text.trim() || providerBlocked,
    noVoiceReason,
  }

  return (
    <div className="ed-split" ref={splitRef}>
      <div className="ed-script" style={avail > 0 ? { height: scriptH } : undefined}>
        <TextPanel
          {...text}
          textRef={textRef}
          generating={cueBusy}
          genDisabled={cueBusy || providerBlocked}
          onGenerate={onGenerate}
          onRecord={v2v.toggleRec}
          recording={v2v.rec.phase !== 'idle'}
          recordDisabled={v2v.converting}
          devices={v2v.rec.devices}
          deviceId={appSettings.micDeviceId}
          onDevice={(micDeviceId) => onAppSettings({ ...appSettings, micDeviceId })}
          onRefreshDevices={v2v.rec.refreshDevices}
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
        cues={cues}
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
        compRef={compRef}
        onComp={onComp}
        onStatus={onStatus}
        onEffectsTarget={onEffectsTarget}
        busyClipId={cueBusy ? (replaceClipId ?? null) : null}
      />
    </div>
  )
}
