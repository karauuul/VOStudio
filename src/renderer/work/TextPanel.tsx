import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import type { Character, Cue, Term, VoiceSettings } from '@shared/domain'
import { highlightRanges, matchTerms } from '@shared/prompt'
import {
  clampSpeed,
  fromPercent,
  targetRange,
  toPercent,
  type GenTarget,
  type TextRange,
} from '@shared/generation'
import { DragNumber } from '../cue/DragNumber'

const SOURCE_LANG = 'EN'
const TARGET_LANG = 'UK'

export interface TextPanelProps {
  cue?: Cue
  terms?: Term[]
  characters?: Character[]
  voice?: VoiceSettings
  textRef?: RefObject<HTMLTextAreaElement>
  target?: GenTarget
  onText?: (text: string) => void
  onSelection?: (range: TextRange | null) => void
  onAcceptSuggestion?: () => void
  onRejectSuggestion?: () => void
  onCharacter?: (characterId: string) => void
  onVoiceChange?: (patch: Partial<VoiceSettings>) => void
  onGenerate?: (kind: GenTarget['kind']) => void
  generating?: boolean
  genDisabled?: boolean
  hasRange?: boolean
  hasClip?: boolean
  onRecord?: () => void
  recording?: boolean
  recordDisabled?: boolean
  devices?: MediaDeviceInfo[]
  deviceId?: string
  onDevice?: (deviceId: string | undefined) => void
  onRefreshDevices?: () => void
}

const Caret = (): ReactNode => (
  <svg className="caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

function Marked({ text, ranges }: { text: string; ranges: { start: number; end: number }[] }) {
  if (ranges.length === 0) return <>{text}</>
  const out: ReactNode[] = []
  let at = 0
  for (const r of ranges) {
    if (r.start > at) out.push(text.slice(at, r.start))
    out.push(<mark key={r.start}>{text.slice(r.start, r.end)}</mark>)
    at = r.end
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

function Original({ cue, terms }: { cue?: Cue; terms: Term[] }) {
  const needles = useMemo(
    () =>
      cue ? matchTerms(terms, cue.sourceText, cue.text).map((t) => t.term) : [],
    [terms, cue?.sourceText, cue?.text]
  )
  const ranges = useMemo(
    () => (cue ? highlightRanges(cue.sourceText, needles) : []),
    [cue?.sourceText, needles]
  )
  return (
    <section className="blk o">
      <div className="lh">
        <span className="k" />
        <span className="lab">Original</span>
        {cue && (
          <span className="r">
            {SOURCE_LANG}
            {cue.referenceDuration !== undefined
              ? ` · ${cue.referenceDuration.toFixed(2)}s`
              : ''}
          </span>
        )}
      </div>
      <div className="body">
        {cue && <Marked text={cue.sourceText} ranges={ranges} />}
      </div>
    </section>
  )
}

function Translation({
  cue,
  textRef,
  target,
  onText,
  onSelection,
  onAcceptSuggestion,
  onRejectSuggestion,
}: Pick<
  TextPanelProps,
  'cue' | 'textRef' | 'target' | 'onText' | 'onSelection' | 'onAcceptSuggestion' | 'onRejectSuggestion'
>) {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const text = cue?.text ?? ''
  const range = useMemo(
    () => (target ? targetRange(text, target) : null),
    [text, target]
  )

  return (
    <section className="blk t">
      <div className="lh">
        <span className="k" />
        <span className="lab">Translation</span>
        {cue && (
          <span className="r">
            {TARGET_LANG} · {text.length}
          </span>
        )}
      </div>
      <div className="body">
        {cue && (
          <>
            <div className="tr-mirror" ref={mirrorRef} aria-hidden="true">
              <Marked text={text} ranges={range ? [range] : []} />
              {'\n'}
            </div>
            <textarea
              ref={textRef}
              className="tr-in"
              value={text}
              spellCheck={false}
              onChange={(e) => onText?.(e.target.value)}
              onScroll={(e) => {
                const mirror = mirrorRef.current
                if (mirror) mirror.scrollTop = e.currentTarget.scrollTop
              }}
              onSelect={(e) => {
                const el = e.currentTarget
                onSelection?.(
                  el.selectionEnd > el.selectionStart
                    ? { start: el.selectionStart, end: el.selectionEnd }
                    : null
                )
              }}
            />
          </>
        )}
      </div>
      {cue?.suggestedText !== undefined && (
        <div className="sugg">
          <span className="sugg-tx">{cue.suggestedText}</span>
          <button className="btn sm ghost" onClick={onAcceptSuggestion}>
            Accept
          </button>
          <button className="btn sm ghost" onClick={onRejectSuggestion}>
            Reject
          </button>
        </div>
      )}
    </section>
  )
}

function GenerateMenu({
  hasRange,
  hasClip,
  disabled,
  onGenerate,
}: {
  hasRange: boolean
  hasClip: boolean
  disabled: boolean
  onGenerate?: (kind: GenTarget['kind']) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const item = (kind: GenTarget['kind'], label: string, enabled: boolean): ReactNode => (
    <button
      className="menu-item"
      role="menuitem"
      disabled={disabled || !enabled}
      onClick={() => {
        setOpen(false)
        onGenerate?.(kind)
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="menu" ref={wrapRef}>
      <button
        className="btn primary caret-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Generation target"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <Caret />
      </button>
      {open && (
        <div className="menu-pop gen-pop" role="menu">
          {item('all', 'Whole text', true)}
          {item('range', 'Selection', hasRange)}
          {item('clip', 'Regenerate clip', hasClip)}
        </div>
      )}
    </div>
  )
}

export function TextPanel({
  cue,
  terms = [],
  characters = [],
  voice,
  textRef,
  target,
  onText,
  onSelection,
  onAcceptSuggestion,
  onRejectSuggestion,
  onCharacter,
  onVoiceChange,
  onGenerate,
  generating,
  genDisabled,
  hasRange = false,
  hasClip = false,
  onRecord,
  recording,
  recordDisabled,
  devices = [],
  deviceId,
  onDevice,
  onRefreshDevices,
}: TextPanelProps) {
  const off = !cue
  const settings = voice
  const genOff = off || !!genDisabled

  return (
    <>
      <Original cue={cue} terms={terms} />
      <Translation
        cue={cue}
        textRef={textRef}
        target={target}
        onText={onText}
        onSelection={onSelection}
        onAcceptSuggestion={onAcceptSuggestion}
        onRejectSuggestion={onRejectSuggestion}
      />

      <div className={'gen' + (off ? ' dis' : '')}>
        <label className="g">
          <span className="lab">Voice</span>
          <span className="field">
            <select
              value={cue?.characterId ?? ''}
              disabled={off}
              onChange={(e) => onCharacter?.(e.target.value)}
            >
              <option value="">No character</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Caret />
          </span>
        </label>

        <div className="g">
          <span className="lab">Generate</span>
          <span className="split">
            <button
              className="btn primary"
              disabled={genOff}
              onClick={() => onGenerate?.(target?.kind ?? 'all')}
            >
              {generating ? <span className="spin" /> : <span className="play" />}
              Generate
            </button>
            <GenerateMenu
              hasRange={hasRange}
              hasClip={hasClip}
              disabled={genOff}
              onGenerate={onGenerate}
            />
          </span>
        </div>

        <div className="g">
          <span className="lab">Record</span>
          <button
            className={'btn rec' + (recording ? ' on' : '')}
            disabled={off || !!recordDisabled}
            onClick={() => onRecord?.()}
          >
            {recording ? 'Stop' : 'Record'}
          </button>
        </div>

        <label className="g">
          <span className="lab">Microphone</span>
          <span className="field">
            <select
              value={deviceId ?? ''}
              disabled={off}
              onFocus={onRefreshDevices}
              onChange={(e) => onDevice?.(e.target.value || undefined)}
            >
              <option value="">Default</option>
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Input ${i + 1}`}
                </option>
              ))}
            </select>
            <Caret />
          </span>
        </label>

        <DragNumber
          label="Stability"
          value={toPercent(settings?.stability ?? 0)}
          min={0}
          max={100}
          perPx={0.5}
          decimals={0}
          unit=""
          disabled={off}
          onInput={(v) => onVoiceChange?.({ stability: fromPercent(v) })}
          onCommit={(v) => onVoiceChange?.({ stability: fromPercent(v) })}
        />
        <DragNumber
          label="Similarity"
          value={toPercent(settings?.similarity ?? 0)}
          min={0}
          max={100}
          perPx={0.5}
          decimals={0}
          unit=""
          disabled={off}
          onInput={(v) => onVoiceChange?.({ similarity: fromPercent(v) })}
          onCommit={(v) => onVoiceChange?.({ similarity: fromPercent(v) })}
        />
        <DragNumber
          label="Style"
          value={toPercent(settings?.style ?? 0)}
          min={0}
          max={100}
          perPx={0.5}
          decimals={0}
          unit=""
          disabled={off}
          onInput={(v) => onVoiceChange?.({ style: fromPercent(v) })}
          onCommit={(v) => onVoiceChange?.({ style: fromPercent(v) })}
        />
        <DragNumber
          label="Speed"
          value={settings?.speed ?? 1}
          min={0.7}
          max={1.2}
          perPx={0.004}
          decimals={2}
          unit="×"
          disabled={off}
          onInput={(v) => onVoiceChange?.({ speed: clampSpeed(v) })}
          onCommit={(v) => onVoiceChange?.({ speed: clampSpeed(v) })}
        />
      </div>
    </>
  )
}
