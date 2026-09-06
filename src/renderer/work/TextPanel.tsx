import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import type {
  Character,
  Cue,
  ProviderModeSettings,
  Term,
  VoiceSettings,
} from '@shared/domain'
import { highlightRanges, matchTerms } from '@shared/prompt'
import {
  clampSpeed,
  fromPercent,
  targetRange,
  toPercent,
  type GenTarget,
  type TextRange,
} from '@shared/generation'
import {
  AUDIO_TAGS,
  insertTag,
  isV3,
  modelsFor,
  supportedSettings,
  supportsLanguageCode,
  type GenMode,
  type ProviderModel,
} from '@shared/provider-models'
import { DragNumber } from '../cue/DragNumber'
import { useContextMenu, type MenuEntry } from '../shell/ContextMenu'

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
  originalMenu?: () => MenuEntry[]
  translationMenu?: (range: TextRange, el: HTMLTextAreaElement) => MenuEntry[]
  onCopy?: (kind: 'source' | 'translation' | 'prompt') => void
  mode?: GenMode
  onMode?: (mode: GenMode) => void
  models?: ProviderModel[]
  model?: ProviderModel
  onProvider?: (patch: ProviderModeSettings) => void
  language?: string
  cost?: number
  remaining?: number
}

const Caret = (): ReactNode => (
  <svg className="caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

const count = (n: number): string => n.toLocaleString('en-US').replace(/,/g, ' ')

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

function Original({
  cue,
  terms,
  menu,
}: {
  cue?: Cue
  terms: Term[]
  menu?: () => MenuEntry[]
}) {
  const pop = useContextMenu()
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
      <div
        className="body"
        onContextMenu={(e) => {
          if (cue && menu) pop.open(e, menu())
        }}
      >
        {cue && <Marked text={cue.sourceText} ranges={ranges} />}
      </div>
      {pop.node}
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
  menu,
}: Pick<
  TextPanelProps,
  'cue' | 'textRef' | 'target' | 'onText' | 'onSelection' | 'onAcceptSuggestion' | 'onRejectSuggestion'
> & { menu?: (range: TextRange, el: HTMLTextAreaElement) => MenuEntry[] }) {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const pop = useContextMenu()
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
              onContextMenu={(e) => {
                const el = e.currentTarget
                if (menu) pop.open(e, menu({ start: el.selectionStart, end: el.selectionEnd }, el))
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
      {pop.node}
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

function Select({
  label,
  value,
  disabled,
  wide,
  onChange,
  children,
}: {
  label: string
  value: string
  disabled?: boolean
  wide?: boolean
  onChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <label className={'g' + (wide ? ' w2' : '')}>
      <span className="lab">{label}</span>
      <span className="field">
        <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {children}
        </select>
        <Caret />
      </span>
    </label>
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
  originalMenu,
  translationMenu,
  mode = 'tts',
  onMode,
  models = [],
  model,
  onProvider,
  language,
  cost,
  remaining,
}: TextPanelProps) {
  const off = !cue
  const settings = voice
  const genOff = off || !!genDisabled
  const shows = useMemo(() => supportedSettings(model, mode), [model, mode])
  const options = useMemo(() => modelsFor(models, mode), [models, mode])
  const tags = mode === 'tts' && isV3(model)

  const addTag = (tag: string): void => {
    const el = textRef?.current
    if (!el || !cue) return
    const next = insertTag(el.value, el.selectionStart, el.selectionEnd, tag)
    onText?.(next.text)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  return (
    <>
      <Original cue={cue} terms={terms} menu={originalMenu} />
      <Translation
        cue={cue}
        textRef={textRef}
        target={target}
        onText={onText}
        onSelection={onSelection}
        onAcceptSuggestion={onAcceptSuggestion}
        onRejectSuggestion={onRejectSuggestion}
        menu={translationMenu}
      />

      <div className={'gen' + (off ? ' dis' : '')}>
        <Select
          label="Voice"
          value={cue?.characterId ?? ''}
          disabled={off}
          onChange={(v) => onCharacter?.(v)}
        >
          <option value="">No character</option>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        <div className="g">
          <span className="lab">Mode</span>
          <span className="seg" role="group">
            <button
              className={mode === 'tts' ? 'on' : ''}
              aria-pressed={mode === 'tts'}
              onClick={() => onMode?.('tts')}
            >
              Generate
            </button>
            <button
              className={mode === 'sts' ? 'on' : ''}
              aria-pressed={mode === 'sts'}
              onClick={() => onMode?.('sts')}
            >
              Record
            </button>
          </span>
        </div>

        {mode === 'tts' ? (
          <div className="g w2">
            <span className="lh">
              <span className="lab">Generate</span>
              <span className="n">
                {cost !== undefined ? `${count(cost)} chars` : ''}
                {cost !== undefined && remaining !== undefined ? ' · ' : ''}
                {remaining !== undefined ? `${count(remaining)} left` : ''}
              </span>
            </span>
            <span className="split">
              <button
                className="btn primary"
                data-hk="generate"
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
        ) : (
          <div className="g w2">
            <span className="lh">
              <span className="lab">Record</span>
              <span className="n">
                {remaining !== undefined ? `${count(remaining)} left` : ''}
              </span>
            </span>
            <button
              className={'btn rec' + (recording ? ' on' : '')}
              data-hk="toggleRecord"
              disabled={off || !!recordDisabled}
              onClick={() => onRecord?.()}
            >
              {recording ? 'Stop' : 'Record'}
            </button>
          </div>
        )}

        <div className="gsec">
          <span className="lab">ElevenLabs</span>
        </div>

        <Select
          label="Model"
          value={model?.id ?? ''}
          wide
          onChange={(v) => onProvider?.({ model: v })}
        >
          {model && !options.some((m) => m.id === model.id) && (
            <option value={model.id}>{model.name}</option>
          )}
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </Select>

        {supportsLanguageCode(model, mode) && (
          <Select
            label="Language"
            value={language ?? ''}
            onChange={(v) => onProvider?.({ language: v })}
          >
            <option value="">Auto</option>
            {model?.languages.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        )}

        {shows.includes('stability') && (
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
        )}
        {shows.includes('similarity') && (
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
        )}
        {shows.includes('style') && (
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
        )}
        {shows.includes('speed') && (
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
        )}
        {shows.includes('boost') && (
          <label className="g">
            <span className="lab">Boost</span>
            <span className="tog">
              <input
                type="checkbox"
                checked={settings?.boost ?? false}
                disabled={off}
                onChange={(e) => onVoiceChange?.({ boost: e.target.checked })}
              />
              {settings?.boost ? 'On' : 'Off'}
            </span>
          </label>
        )}

        {tags && (
          <div className="tags">
            {AUDIO_TAGS.map((tag) => (
              <button key={tag} disabled={off} onClick={() => addTag(tag)}>
                [{tag}]
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
