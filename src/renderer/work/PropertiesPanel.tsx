import { useMemo, useState, type MutableRefObject, type ReactNode } from 'react'
import {
  clipEnd,
  clipTimelineDuration,
  compDuration,
  GAIN_MAX_DB,
  GAIN_MIN_DB,
} from '@shared/comp'
import {
  clipSpeed,
  DEFAULT_DUCK_DB,
  DUCK_MAX_DB,
  DUCK_MIN_DB,
  TRACK_GAIN_MAX_DB,
  TRACK_GAIN_MIN_DB,
  type Character,
  type ClipEffects,
  type CompClip,
  type CompTrack,
  type Cue,
  type OriginalLane,
  type TakeKind,
} from '@shared/domain'
import {
  DELAY_FEEDBACK_MAX,
  DELAY_FEEDBACK_MIN,
  DELAY_TIME_MAX,
  DELAY_TIME_MIN,
  effectOn,
  MIX_MAX,
  MIX_MIN,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  PITCH_STEP,
  REVERB_DECAY_MAX,
  REVERB_DECAY_MIN,
  REVERB_SIZE_MAX,
  REVERB_SIZE_MIN,
  setEffectEnabled,
  toggleEffect,
  type EffectKind,
} from '@shared/effects'
import { clipText, libraryRow, lineLabel, resolveTake, versionLabel } from '@shared/library'
import { toPercent } from '@shared/generation'
import { DragNumber } from '../cue/DragNumber'
import type { CompApi, TimelineSelection } from './TimelinePanel'
import { useContextMenu } from '../shell/ContextMenu'

export interface PropertiesPanelProps {
  cue: Cue | null
  cues: Cue[]
  characters: Character[]
  selection: TimelineSelection | null
  sourceTakeId: string | null
  original: OriginalLane | undefined
  exportName: string
  compRef: MutableRefObject<CompApi | null>
  onCharacter: (characterId: string) => void
  onOriginal: (patch: Partial<OriginalLane>) => void
  onTakeEffects: (takeId: string, effects: ClipEffects | undefined) => void
  onPinSource: (takeId: string, pinned: boolean) => void
  onDeleteSource: (takeId: string) => void
  onOpenLine: (cueId: string) => void
}

type Tab = 'clip' | 'track' | 'line' | 'source'

const TAB_LABEL: Record<Tab, string> = { clip: 'Clip', track: 'Track', line: 'Line', source: 'Source' }

const FX_LABEL: Record<EffectKind, string> = { reverb: 'Reverb', delay: 'Delay', pitch: 'Pitch' }

const KIND_LABEL: Record<TakeKind, string> = {
  tts: 'generated',
  sts: 'generated',
  recording: 'recorded',
  imported: 'imported',
  composite: 'composite',
}

const secs = (v: number): string => (Number.isFinite(v) && v > 0 ? v.toFixed(2) : '0.00')

const half = (v: number): number => Math.round(v * 2) / 2

export function PropertiesPanel({
  cue,
  cues,
  characters,
  selection,
  sourceTakeId,
  original,
  exportName,
  compRef,
  onCharacter,
  onOriginal,
  onTakeEffects,
  onPinSource,
  onDeleteSource,
  onOpenLine,
}: PropertiesPanelProps) {
  const project = useMemo(() => ({ cues }), [cues])
  const sourceRow = cue && sourceTakeId ? libraryRow(cue, project, sourceTakeId) : undefined
  const clip = selection?.clip ?? null
  const tracks = selection?.tracks ?? []
  const track = tracks.find((t) => t.id === selection?.trackId) ?? tracks[0]

  const auto: Tab = sourceRow
    ? 'source'
    : clip
      ? 'clip'
      : selection?.kind === 'track'
        ? 'track'
        : 'line'
  const signature = sourceRow
    ? `source:${sourceRow.take.id}`
    : clip
      ? `clip:${clip.id}`
      : selection?.kind === 'track'
        ? `track:${selection.trackId}`
        : `line:${cue?.id ?? ''}`

  const [tab, setTab] = useState<Tab>(auto)
  const [shown, setShown] = useState(signature)
  if (shown !== signature) {
    setShown(signature)
    setTab(auto)
  }

  const tabs: Tab[] = sourceRow ? ['source'] : ['clip', 'track', 'line']
  const active: Tab = tabs.includes(tab) ? tab : auto

  const head = (
    <div className="phd">
      Properties
      <span className={'tabs' + (cue ? '' : ' dis')}>
        {tabs.map((t) => (
          <button
            key={t}
            className={active === t ? 'on' : ''}
            disabled={!cue || (t === 'clip' && !clip)}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </span>
    </div>
  )

  if (!cue) return <section className="panel props">{head}</section>

  return (
    <section className="panel props">
      {head}
      <div className="props-body">
        {active === 'source' && sourceRow && (
          <SourceTab
            cue={cue}
            cues={cues}
            characters={characters}
            row={sourceRow}
            onTakeEffects={onTakeEffects}
            onPinSource={onPinSource}
            onDeleteSource={onDeleteSource}
            onOpenLine={onOpenLine}
          />
        )}

        {active === 'clip' && clip && (
          <ClipTab
            cue={cue}
            cues={cues}
            characters={characters}
            clip={clip}
            track={track}
            compRef={compRef}
            onTakeEffects={onTakeEffects}
            onTrackTab={() => setTab('track')}
          />
        )}

        {active === 'track' && track && (
          <TrackTab
            characters={characters}
            track={track}
            clips={cue.comp?.clips.filter((c) => (c.trackId ?? tracks[0]?.id) === track.id) ?? []}
            compRef={compRef}
          />
        )}

        {active === 'line' && (
          <LineTab
            cue={cue}
            characters={characters}
            original={original}
            exportName={exportName}
            region={selection?.region ?? { in: 0, out: 0 }}
            compRef={compRef}
            onCharacter={onCharacter}
            onOriginal={onOriginal}
          />
        )}
      </div>
    </section>
  )
}

function Head({
  name,
  duration,
  subtitle,
  actions,
}: {
  name: string
  duration?: string
  subtitle: string
  actions?: ReactNode
}) {
  return (
    <div className="head">
      <span className="t">{name}</span>
      {actions ? <span className="acts">{actions}</span> : duration && <span className="d">{duration}</span>}
      <span className="s">{subtitle}</span>
    </div>
  )
}

function Sec({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="props-sec">
      <span className="lab">{children}</span>
      {action}
    </div>
  )
}

function Row2({ children }: { children: ReactNode }) {
  return <div className="row2">{children}</div>
}

function Ro({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="cp-num">
      <span className="cp-k">{label}</span>
      <b className="props-v">
        <span className="props-t">{value}</span>
        {unit && <u>{unit}</u>}
      </b>
    </div>
  )
}

function CharacterField({
  label,
  characters,
  value,
  onChange,
}: {
  label: string
  characters: Character[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <div className="cp-num">
      <span className="cp-k">{label}</span>
      <select className="props-sel" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No character</option>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  )
}

function characterName(characters: Character[], id: string | undefined): string {
  return characters.find((c) => c.id === id)?.name ?? 'No character'
}

interface Param {
  key: string
  label: string
  value: number
  min: number
  max: number
  decimals: number
  unit: string
  set: (v: number) => ClipEffects
}

function effectParams(fx: ClipEffects, which: EffectKind): Param[] {
  if (which === 'reverb') {
    const r = fx.reverb!
    return [
      {
        key: 'size',
        label: 'Size',
        value: Math.round(r.size * 100),
        min: REVERB_SIZE_MIN * 100,
        max: REVERB_SIZE_MAX * 100,
        decimals: 0,
        unit: '%',
        set: (v) => ({ ...fx, reverb: { ...r, size: v / 100 } }),
      },
      {
        key: 'decay',
        label: 'Decay',
        value: r.decay,
        min: REVERB_DECAY_MIN,
        max: REVERB_DECAY_MAX,
        decimals: 2,
        unit: 's',
        set: (v) => ({ ...fx, reverb: { ...r, decay: v } }),
      },
      {
        key: 'mix',
        label: 'Mix',
        value: Math.round(r.mix * 100),
        min: MIX_MIN * 100,
        max: MIX_MAX * 100,
        decimals: 0,
        unit: '%',
        set: (v) => ({ ...fx, reverb: { ...r, mix: v / 100 } }),
      },
    ]
  }
  if (which === 'delay') {
    const d = fx.delay!
    return [
      {
        key: 'time',
        label: 'Time',
        value: Math.round(d.time * 1000),
        min: DELAY_TIME_MIN * 1000,
        max: DELAY_TIME_MAX * 1000,
        decimals: 0,
        unit: 'ms',
        set: (v) => ({ ...fx, delay: { ...d, time: v / 1000 } }),
      },
      {
        key: 'feedback',
        label: 'Feedback',
        value: Math.round(d.feedback * 100),
        min: DELAY_FEEDBACK_MIN * 100,
        max: DELAY_FEEDBACK_MAX * 100,
        decimals: 0,
        unit: '%',
        set: (v) => ({ ...fx, delay: { ...d, feedback: v / 100 } }),
      },
      {
        key: 'mix',
        label: 'Mix',
        value: Math.round(d.mix * 100),
        min: MIX_MIN * 100,
        max: MIX_MAX * 100,
        decimals: 0,
        unit: '%',
        set: (v) => ({ ...fx, delay: { ...d, mix: v / 100 } }),
      },
    ]
  }
  const p = fx.pitch!
  return [
    {
      key: 'semitones',
      label: 'Shift',
      value: p.semitones,
      min: PITCH_SEMITONES_MIN,
      max: PITCH_SEMITONES_MAX,
      decimals: 1,
      unit: 'st',
      set: (v) => ({ ...fx, pitch: { ...p, semitones: Math.round(v / PITCH_STEP) * PITCH_STEP } }),
    },
  ]
}

function EffectStack({
  title,
  effects,
  kinds,
  onChange,
  readOnly,
  action,
}: {
  title: string
  effects: ClipEffects | undefined
  kinds: EffectKind[]
  onChange: (next: ClipEffects | undefined) => void
  readOnly?: boolean
  action?: ReactNode
}) {
  const [open, setOpen] = useState<EffectKind | null>(null)
  const pop = useContextMenu()
  const [draft, setDraft] = useState<ClipEffects | null>(null)

  const fx = draft ?? effects
  const present = kinds.filter((k) => !!fx?.[k])
  const missing = kinds.filter((k) => !fx?.[k])

  const apply = (next: ClipEffects | undefined, commit: boolean): void => {
    if (commit) {
      setDraft(null)
      onChange(next)
    } else setDraft(next ?? {})
  }

  return (
    <>
      <Sec
        action={
          action ??
          (readOnly || missing.length === 0 ? undefined : (
            <span className="props-add">
              <button
                className="ico sm"
                aria-label={`Add to ${title}`}
                onClick={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  pop.openAt(
                    box.right,
                    box.bottom + 4,
                    kinds.map((k) => ({
                      label: FX_LABEL[k],
                      disabled: !!fx?.[k],
                      onClick: () => {
                        setOpen(k)
                        apply(toggleEffect(fx, k, true), true)
                      },
                    }))
                  )
                }}
              >
                <svg width="9" height="9" viewBox="0 0 10 10">
                  <path d="M5 0v10M0 5h10" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
              {pop.node}
            </span>
          ))
        }
      >
        {title}
      </Sec>

      {present.length === 0 && <div className="fx empty">—</div>}

      {present.map((k) => (
        <div key={k}>
          <div className="fx">
            <input
              type="checkbox"
              className="fx-cb"
              checked={effectOn(fx?.[k])}
              disabled={readOnly}
              aria-label={`${FX_LABEL[k]} on`}
              onChange={(e) => apply(setEffectEnabled(fx, k, e.target.checked), true)}
            />
            <span className="fx-n">{FX_LABEL[k]}</span>
            {!readOnly && (
              <button
                className="ico sm fx-x"
                aria-label={`Remove ${FX_LABEL[k]}`}
                onClick={() => apply(toggleEffect(fx, k, false), true)}
              >
                &times;
              </button>
            )}
            <button
              className="fx-c"
              aria-label={`${FX_LABEL[k]} parameters`}
              aria-expanded={open === k}
              onClick={() => setOpen((v) => (v === k ? null : k))}
            >
              {open === k ? '▾' : '▸'}
            </button>
          </div>
          {open === k && fx && (
            <div className="fxp">
              {effectParams(fx, k).map((p) => (
                <div className="p" key={p.key}>
                  <span>{p.label}</span>
                  <input
                    type="range"
                    className="fx-r"
                    style={{
                      ['--p' as string]: `${(100 * (p.value - p.min)) / Math.max(1e-6, p.max - p.min)}%`,
                    }}
                    min={p.min}
                    max={p.max}
                    step={p.decimals === 0 ? 1 : 10 ** -p.decimals}
                    value={p.value}
                    disabled={readOnly}
                    aria-label={p.label}
                    onChange={(e) => apply(p.set(Number(e.target.value)), false)}
                    onMouseUp={(e) => apply(p.set(Number(e.currentTarget.value)), true)}
                    onKeyUp={(e) => apply(p.set(Number(e.currentTarget.value)), true)}
                  />
                  <DragNumber
                    label=""
                    unit={p.unit}
                    value={p.value}
                    min={p.min}
                    max={p.max}
                    perPx={(p.max - p.min) / 200}
                    decimals={p.decimals}
                    disabled={readOnly}
                    onInput={(v) => apply(p.set(v), false)}
                    onCommit={(v) => apply(p.set(v), true)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  )
}

const CLIP_KINDS: EffectKind[] = ['reverb', 'delay', 'pitch']
const TRACK_KINDS: EffectKind[] = ['reverb', 'delay']

function ClipTab({
  cue,
  cues,
  characters,
  clip,
  track,
  compRef,
  onTakeEffects,
  onTrackTab,
}: {
  cue: Cue
  cues: Cue[]
  characters: Character[]
  clip: NonNullable<TimelineSelection['clip']>
  track: CompTrack | undefined
  compRef: MutableRefObject<CompApi | null>
  onTakeEffects: (takeId: string, effects: ClipEffects | undefined) => void
  onTrackTab: () => void
}) {
  const project = useMemo(() => ({ cues }), [cues])
  const found = resolveTake(project, cue, clip.sourceTakeId)
  const take = found?.take
  const edits = clip.edits
  const speed = clipSpeed(edits)
  const name = take ? clipText(take, clip.srcIn, clip.srcOut) || take.meta.text?.trim() || '' : ''
  const version = versionLabel(cue, project, clip.sourceTakeId)
  const voice = characterName(characters, track?.characterId ?? cue.characterId)
  const edit = (patch: Parameters<CompApi['editSelected']>[0], commit: boolean): void =>
    compRef.current?.editSelected(patch, commit)

  return (
    <>
      <Head
        name={name || 'Clip'}
        duration={`${secs(clipTimelineDuration(clip))}s`}
        subtitle={[track?.name, version, voice].filter(Boolean).join(' · ')}
      />

      <Sec>Audio</Sec>
      <Row2>
        <DragNumber
          label="Gain"
          unit="dB"
          value={edits.gainDb}
          min={GAIN_MIN_DB}
          max={GAIN_MAX_DB}
          perPx={0.1}
          decimals={1}
          onInput={(v) => edit({ gainDb: half(v) }, false)}
          onCommit={(v) => edit({ gainDb: half(v) }, true)}
        />
        <DragNumber
          label="Speed"
          unit="×"
          value={speed}
          min={0.5}
          max={2}
          perPx={0.01}
          decimals={2}
          onInput={(v) => edit({ timeStretch: v }, false)}
          onCommit={(v) => edit({ timeStretch: v }, true)}
        />
      </Row2>

      <Sec>Timing</Sec>
      <Row2>
        <DragNumber
          label="Start"
          unit="s"
          value={clip.start}
          min={0}
          max={36000}
          perPx={0.01}
          decimals={2}
          onInput={(v) => compRef.current?.moveSelected(v, false)}
          onCommit={(v) => compRef.current?.moveSelected(v, true)}
        />
        <DragNumber
          label="End"
          unit="s"
          value={clipEnd(clip)}
          min={0}
          max={36000}
          perPx={0.01}
          decimals={2}
          onInput={(v) => compRef.current?.trimSelected('end', v, false)}
          onCommit={(v) => compRef.current?.trimSelected('end', v, true)}
        />
        <DragNumber
          label="Fade in"
          unit="s"
          value={edits.fadeIn.duration}
          min={0}
          max={Math.max(0, (clip.srcOut - clip.srcIn) / speed)}
          perPx={0.005}
          decimals={2}
          onInput={(v) => edit({ fadeIn: { ...edits.fadeIn, duration: v } }, false)}
          onCommit={(v) => edit({ fadeIn: { ...edits.fadeIn, duration: v } }, true)}
        />
        <DragNumber
          label="Fade out"
          unit="s"
          value={edits.fadeOut.duration}
          min={0}
          max={Math.max(0, (clip.srcOut - clip.srcIn) / speed)}
          perPx={0.005}
          decimals={2}
          onInput={(v) => edit({ fadeOut: { ...edits.fadeOut, duration: v } }, false)}
          onCommit={(v) => edit({ fadeOut: { ...edits.fadeOut, duration: v } }, true)}
        />
      </Row2>

      <EffectStack
        title="Clip effects"
        effects={take?.edits.effects}
        kinds={CLIP_KINDS}
        onChange={(next) => take && onTakeEffects(take.id, next)}
      />

      <EffectStack
        title="Track effects"
        effects={track?.effects}
        kinds={TRACK_KINDS}
        readOnly
        onChange={() => {}}
        action={
          <button className="ico sm" aria-label="Open the Track tab" onClick={onTrackTab}>
            <svg width="8" height="12" viewBox="0 0 8 12">
              <path d="M2 1l4 5-4 5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        }
      />
    </>
  )
}

function TrackTab({
  characters,
  track,
  clips,
  compRef,
}: {
  characters: Character[]
  track: CompTrack
  clips: CompClip[]
  compRef: MutableRefObject<CompApi | null>
}) {
  const set = (patch: Partial<Omit<CompTrack, 'id'>>, commit = true): void =>
    compRef.current?.editTrack(track.id, patch, commit)

  return (
    <>
      <Head
        name={track.name}
        subtitle={`${clips.length} ${clips.length === 1 ? 'clip' : 'clips'} · ${secs(
          compDuration({ clips })
        )}s`}
      />

      <Sec>Track</Sec>
      <Row2>
        <div className="cp-num">
          <span className="cp-k">Name</span>
          <input
            className="props-in"
            value={track.name}
            onChange={(e) => set({ name: e.target.value }, false)}
            onBlur={(e) => set({ name: e.target.value.trim() || track.name })}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <CharacterField
          label="Voice"
          characters={characters}
          value={track.characterId ?? ''}
          onChange={(id) => set({ characterId: id || undefined })}
        />
      </Row2>

      <Sec>Audio</Sec>
      <Row2>
        <DragNumber
          label="Gain"
          unit="dB"
          value={track.gainDb}
          min={TRACK_GAIN_MIN_DB}
          max={TRACK_GAIN_MAX_DB}
          perPx={0.1}
          decimals={1}
          onInput={(v) => set({ gainDb: half(v) }, false)}
          onCommit={(v) => set({ gainDb: half(v) })}
        />
        <div className="cp-num">
          <span className="cp-k">State</span>
          <span className="props-tg">
            <button
              className={track.muted ? 'on' : ''}
              aria-pressed={track.muted}
              onClick={() => set({ muted: !track.muted })}
            >
              M
            </button>
            <button
              className={track.solo ? 'on' : ''}
              aria-pressed={track.solo}
              onClick={() => set({ solo: !track.solo })}
            >
              S
            </button>
          </span>
        </div>
      </Row2>

      <EffectStack
        title="Track effects"
        effects={track.effects}
        kinds={TRACK_KINDS}
        onChange={(next) => set({ effects: next })}
      />
    </>
  )
}

function LineTab({
  cue,
  characters,
  original,
  exportName,
  region,
  compRef,
  onCharacter,
  onOriginal,
}: {
  cue: Cue
  characters: Character[]
  original: OriginalLane | undefined
  exportName: string
  region: { in: number; out: number }
  compRef: MutableRefObject<CompApi | null>
  onCharacter: (characterId: string) => void
  onOriginal: (patch: Partial<OriginalLane>) => void
}) {
  const id = lineLabel(cue)
  const duration = Math.max(cue.referenceDuration ?? 0, region.out)

  return (
    <>
      <Head
        name={cue.sourceText || cue.text || id}
        duration={`${secs(duration)}s`}
        subtitle={id}
      />

      <Sec>Line</Sec>
      <Row2>
        <Ro label="Id" value={id} />
        <CharacterField
          label="Character"
          characters={characters}
          value={cue.characterId}
          onChange={onCharacter}
        />
      </Row2>

      <Sec>Original</Sec>
      <Row2>
        <div className="cp-num">
          <span className="cp-k">Export</span>
          <span className="props-tg">
            {(['off', 'on'] as const).map((mode) => (
              <button
                key={mode}
                className={(original?.exportMode ?? 'off') === mode ? 'on' : ''}
                onClick={() => onOriginal({ exportMode: mode })}
              >
                {mode === 'off' ? 'Off' : 'On'}
              </button>
            ))}
          </span>
        </div>
        <DragNumber
          label="Duck"
          unit="dB"
          value={original?.duckDb ?? DEFAULT_DUCK_DB}
          min={DUCK_MIN_DB}
          max={DUCK_MAX_DB}
          perPx={0.2}
          decimals={0}
          disabled={original?.exportMode !== 'on'}
          onInput={() => {}}
          onCommit={(v) => onOriginal({ duckDb: v })}
        />
        <div className="cp-num">
          <span className="cp-k">Preview</span>
          <button
            className={'ico sm' + (original?.previewMuted === true ? '' : ' on')}
            aria-label="Preview the original"
            aria-pressed={original?.previewMuted !== true}
            onClick={() =>
              onOriginal({ previewMuted: original?.previewMuted === true ? undefined : true })
            }
          >
            <svg width="13" height="12" viewBox="0 0 14 13">
              <path d="M1 9V7a6 6 0 0 1 12 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <rect x="1" y="8" width="3" height="5" rx="1" fill="currentColor" />
              <rect x="10" y="8" width="3" height="5" rx="1" fill="currentColor" />
            </svg>
          </button>
        </div>
      </Row2>

      <Sec>Region</Sec>
      <Row2>
        <DragNumber
          label="In"
          unit="s"
          value={region.in}
          min={0}
          max={36000}
          perPx={0.01}
          decimals={2}
          onInput={() => {}}
          onCommit={(v) => compRef.current?.setRegion('in', v)}
        />
        <DragNumber
          label="Out"
          unit="s"
          value={region.out}
          min={0}
          max={36000}
          perPx={0.01}
          decimals={2}
          onInput={() => {}}
          onCommit={(v) => compRef.current?.setRegion('out', v)}
        />
      </Row2>

      <Sec>Export</Sec>
      <Row2>
        <Ro label="Name" value={exportName} />
      </Row2>
    </>
  )
}

function SourceTab({
  cue,
  cues,
  characters,
  row,
  onTakeEffects,
  onPinSource,
  onDeleteSource,
  onOpenLine,
}: {
  cue: Cue
  cues: Cue[]
  characters: Character[]
  row: NonNullable<ReturnType<typeof libraryRow>>
  onTakeEffects: (takeId: string, effects: ClipEffects | undefined) => void
  onPinSource: (takeId: string, pinned: boolean) => void
  onDeleteSource: (takeId: string) => void
  onOpenLine: (cueId: string) => void
}) {
  const take = row.take
  const v = take.meta.voiceSettings
  const owner = cues.find((c) => c.id === row.cueId)
  const usedIn = cues.filter((c) =>
    (c.comp?.clips ?? []).some((clip) => clip.sourceTakeId === take.id)
  )

  return (
    <>
      <Head
        name={take.meta.text?.trim() || owner?.text || cue.text}
        subtitle={`${row.label} · ${KIND_LABEL[take.kind]} · ${secs(take.duration)}s`}
        actions={
          <>
            <button
              className={'ico sm' + (take.pinned === true ? ' on' : '')}
              aria-label="Pin to all lines"
              aria-pressed={take.pinned === true}
              onClick={() => onPinSource(take.id, take.pinned !== true)}
            >
              <svg width="12" height="12" viewBox="0 0 11 11">
                <path
                  d="M6.5 1l3.5 3.5-2 .5-2 2 .5 3L4 7.5 1.5 10 1 9.5 3.5 7 1 4.5l3-.5 2-2z"
                  fill="currentColor"
                />
              </svg>
            </button>
            <button className="ico sm" aria-label="Delete source" onClick={() => onDeleteSource(take.id)}>
              <svg width="12" height="13" viewBox="0 0 12 13">
                <path
                  d="M1 3h10M4 3V1h4v2M2 3l1 9h6l1-9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
            </button>
          </>
        }
      />

      <Sec>Generated with</Sec>
      <Row2>
        <Ro label="Voice" value={characterName(characters, owner?.characterId)} />
        <Ro label="Speed" value={(v?.speed ?? 1).toFixed(2)} unit="×" />
        <Ro label="Stability" value={String(toPercent(v?.stability ?? 0))} />
        <Ro label="Similarity" value={String(toPercent(v?.similarity ?? 0))} />
        <Ro label="Style" value={String(toPercent(v?.style ?? 0))} />
        <Ro label="Model" value={take.meta.model ?? '—'} />
      </Row2>

      <Sec>Used in</Sec>
      {usedIn.length === 0 ? (
        <div className="fx empty">—</div>
      ) : (
        usedIn.map((c) => (
          <button key={c.id} className="props-use" onClick={() => onOpenLine(c.id)}>
            {lineLabel(c)}
          </button>
        ))
      )}

      <EffectStack
        title="Source effects"
        effects={take.edits.effects}
        kinds={CLIP_KINDS}
        onChange={(next) => onTakeEffects(take.id, next)}
      />
    </>
  )
}
