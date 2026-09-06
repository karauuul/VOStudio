import { sanitizeEffects, type ClipEffects } from './effects'
import type { ExportSettings } from './export-settings'

export type { ClipEffects, DelayEffect, ReverbEffect } from './effects'

const clampTo = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v : undefined

export interface AudioRef {
  fileId: string
  relPath: string
  format: 'wav' | 'mp3' | 'ogg'
  sampleRate?: number
  channels?: number
}

export interface VoiceSettings {
  stability: number
  similarity: number
  style: number
  speed: number
  boost: boolean
}

export interface Character {
  id: string
  name: string
  color: string
  provider: { providerId: 'elevenlabs'; voiceId: string; ttsModel: string; stsModel: string }
  voiceSettings: VoiceSettings
}

export type CueStatus = 'empty' | 'translated' | 'generated' | 'approved' | 'excluded'
export type TakeKind = 'tts' | 'sts' | 'recording' | 'imported' | 'composite'
export type FadeShape = 'linear' | 'equalPower' | 'sCurve'

export interface ClipEdits {
  trimStart: number
  trimEnd: number
  gainDb: number
  fadeIn: { duration: number; shape: FadeShape }
  fadeOut: { duration: number; shape: FadeShape }
  timeStretch?: number
  gainEnvelope?: Array<{ t: number; db: number }>
  effects?: ClipEffects
}

export const emptyEdits = (): ClipEdits => ({
  trimStart: 0,
  trimEnd: 0,
  gainDb: 0,
  fadeIn: { duration: 0, shape: 'equalPower' },
  fadeOut: { duration: 0, shape: 'equalPower' },
})

export function clipSpeed(edits: ClipEdits): number {
  const r = edits.timeStretch
  return r !== undefined && Number.isFinite(r) && r > 0 ? r : 1
}

export function envelopeDbAt(points: Array<{ t: number; db: number }>, t: number): number {
  if (points.length === 0) return 0
  if (t <= points[0].t) return points[0].db
  const last = points[points.length - 1]
  if (t >= last.t) return last.db
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (t <= b.t) {
      const span = b.t - a.t
      if (span <= 0) return b.db
      return a.db + ((b.db - a.db) * (t - a.t)) / span
    }
  }
  return last.db
}

export interface WordTiming {
  text: string
  start: number
  end: number
}

export function sanitizeWords(rows: unknown): WordTiming[] | undefined {
  if (!Array.isArray(rows)) return undefined
  const out: WordTiming[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<WordTiming>
    if (typeof row.text !== 'string') continue
    if (typeof row.start !== 'number' || !Number.isFinite(row.start)) continue
    if (typeof row.end !== 'number' || !Number.isFinite(row.end)) continue
    const start = Math.max(0, row.start)
    out.push({ text: row.text, start, end: Math.max(start, row.end) })
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end)
  return out.length > 0 ? out : undefined
}

export function sanitizePinned(value: unknown): true | undefined {
  return value === true ? true : undefined
}

export interface Take {
  id: string
  kind: TakeKind
  createdAt: string
  file: AudioRef
  duration: number
  meta: {
    text?: string
    voiceSettings?: VoiceSettings
    sourceTakeId?: string
    provider?: string
    model?: string
  }
  edits: ClipEdits
  words?: WordTiming[]
  rating?: 0 | 1 | 2 | 3
  fragment?: true
  pinned?: true
  deletedAt?: string
}

export interface CompClip {
  id: string
  sourceTakeId: string
  srcIn: number
  srcOut: number
  start: number
  edits: ClipEdits
  crossfade?: number
  trackId?: string
}

export const TRACK_GAIN_MIN_DB = -96
export const TRACK_GAIN_MAX_DB = 24

export interface CompTrack {
  id: string
  name: string
  characterId?: string
  gainDb: number
  muted: boolean
  solo: boolean
  effects?: ClipEffects
}

export function sanitizeCompTracks(rows: unknown): CompTrack[] | undefined {
  if (!Array.isArray(rows)) return undefined
  const out: CompTrack[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<CompTrack>
    const id = nonEmptyString(row.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const characterId = nonEmptyString(row.characterId)
    const { pitch: _pitch, ...trackEffects } = (row.effects ?? {}) as ClipEffects
    const effects = sanitizeEffects(trackEffects)
    out.push({
      id,
      name: nonEmptyString(row.name) ?? id,
      ...(characterId ? { characterId } : {}),
      gainDb: clampTo(finiteOr(row.gainDb, 0), TRACK_GAIN_MIN_DB, TRACK_GAIN_MAX_DB),
      muted: row.muted === true,
      solo: row.solo === true,
      ...(effects ? { effects } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

export interface CompRegion {
  in: number
  out: number
}

export interface CueComp {
  clips: CompClip[]
  region?: CompRegion
  tracks?: CompTrack[]
}

export const DUCK_MIN_DB = -60
export const DUCK_MAX_DB = 0
export const DEFAULT_DUCK_DB = -12

export interface OriginalLane {
  exportMode: 'off' | 'on'
  duckDb?: number
  previewMuted?: true
}

export function sanitizeOriginal(value: unknown): OriginalLane | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Partial<OriginalLane>
  const duckDb = typeof row.duckDb === 'number' && Number.isFinite(row.duckDb) ? row.duckDb : undefined
  return {
    exportMode: row.exportMode === 'on' ? 'on' : 'off',
    ...(duckDb === undefined ? {} : { duckDb: clampTo(duckDb, DUCK_MIN_DB, DUCK_MAX_DB) }),
    ...(row.previewMuted === true ? { previewMuted: true as const } : {}),
  }
}

export function nextOriginal(
  current: OriginalLane | undefined,
  patch: Partial<OriginalLane>
): OriginalLane {
  const base: OriginalLane = current ?? { exportMode: 'off' }
  const next: OriginalLane = { ...base, ...patch }
  if (patch.exportMode === 'on' && next.duckDb === undefined) next.duckDb = DEFAULT_DUCK_DB
  if (next.previewMuted !== true) delete next.previewMuted
  return next
}

export interface Stem {
  id: string
  name: string
  file: AudioRef
  exportMode: 'off' | 'on'
  duckDb?: number
}

export function sanitizeStems(rows: unknown): Stem[] | undefined {
  if (!Array.isArray(rows)) return undefined
  const out: Stem[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<Stem>
    const id = nonEmptyString(row.id)
    const file = sanitizeAudioRef(row.file)
    if (!id || !file || seen.has(id)) continue
    seen.add(id)
    const duckDb =
      typeof row.duckDb === 'number' && Number.isFinite(row.duckDb) ? row.duckDb : undefined
    out.push({
      id,
      name: nonEmptyString(row.name) ?? id,
      file,
      exportMode: row.exportMode === 'on' ? 'on' : 'off',
      ...(duckDb === undefined ? {} : { duckDb: clampTo(duckDb, DUCK_MIN_DB, DUCK_MAX_DB) }),
    })
  }
  return out.length > 0 ? out : undefined
}

export interface CueRegion {
  sourceId: string
  in: number
  out: number
}

export function sanitizeCueRegion(value: unknown): CueRegion | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Partial<CueRegion>
  const sourceId = nonEmptyString(row.sourceId)
  if (!sourceId) return undefined
  if (typeof row.in !== 'number' || !Number.isFinite(row.in)) return undefined
  if (typeof row.out !== 'number' || !Number.isFinite(row.out)) return undefined
  const from = Math.max(0, row.in)
  return row.out > from ? { sourceId, in: from, out: row.out } : undefined
}

export interface ProjectSource {
  id: string
  name: string
  kind: 'audio' | 'video'
  file: AudioRef
  duration: number
  media?: string
  width?: number
  height?: number
  channels?: number
}

function sanitizeAudioRef(value: unknown): AudioRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Partial<AudioRef>
  const fileId = nonEmptyString(row.fileId)
  const relPath = nonEmptyString(row.relPath)
  if (!fileId || !relPath) return undefined
  if (row.format !== 'wav' && row.format !== 'mp3' && row.format !== 'ogg') return undefined
  return {
    fileId,
    relPath,
    format: row.format,
    ...(typeof row.sampleRate === 'number' && Number.isFinite(row.sampleRate)
      ? { sampleRate: row.sampleRate }
      : {}),
    ...(typeof row.channels === 'number' && Number.isFinite(row.channels)
      ? { channels: row.channels }
      : {}),
  }
}

export function sanitizeProjectSources(rows: unknown): ProjectSource[] | undefined {
  if (!Array.isArray(rows)) return undefined
  const out: ProjectSource[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<ProjectSource>
    const id = nonEmptyString(row.id)
    if (!id || seen.has(id)) continue
    const file = sanitizeAudioRef(row.file)
    if (!file) continue
    seen.add(id)
    const media = nonEmptyString(row.media)
    const width = Math.round(finiteOr(row.width, 0))
    const height = Math.round(finiteOr(row.height, 0))
    const channels = Math.round(finiteOr(row.channels, 0))
    out.push({
      id,
      name: nonEmptyString(row.name) ?? id,
      kind: row.kind === 'video' ? 'video' : 'audio',
      file,
      duration: Math.max(0, finiteOr(row.duration, 0)),
      ...(media ? { media } : {}),
      ...(width > 0 ? { width } : {}),
      ...(height > 0 ? { height } : {}),
      ...(channels > 0 ? { channels } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

export function sourceLabel(source: ProjectSource): string {
  const total = Math.round(source.duration)
  const clock = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  const channels = source.channels ?? source.file.channels
  const parts = [clock]
  if (source.height && source.height > 0) parts.push(`${source.height}p`)
  if (channels === 1) parts.push('mono')
  else if (channels === 2) parts.push('stereo')
  else if (channels && channels > 2) parts.push(`${channels} ch`)
  return parts.join(' · ')
}

export interface ProjectVersion {
  n: number
  name?: string
  createdAt: string
}

export function sanitizeVersions(rows: unknown): ProjectVersion[] | undefined {
  if (!Array.isArray(rows)) return undefined
  const out: ProjectVersion[] = []
  const seen = new Set<number>()
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<ProjectVersion>
    if (typeof row.n !== 'number' || !Number.isFinite(row.n)) continue
    const n = Math.trunc(row.n)
    if (n < 1 || seen.has(n)) continue
    const createdAt = nonEmptyString(row.createdAt)
    if (!createdAt) continue
    seen.add(n)
    const name = nonEmptyString(row.name)
    out.push({ n, ...(name ? { name } : {}), createdAt })
  }
  out.sort((a, b) => a.n - b.n)
  return out.length > 0 ? out : undefined
}

export type CueOutput =
  | { kind: 'take'; takeId: string; revision: number }
  | { kind: 'comp'; revision: number }

export interface CueApproval {
  textRevision: number
  outputRevision: number
  approvedAt: string
}

export interface Cue {
  id: string
  characterId: string
  key: string
  fields: Record<string, string>
  sourceText: string
  text: string
  suggestedText?: string
  status: CueStatus
  notes: string
  referenceAudio?: AudioRef
  referenceDuration?: number
  original?: OriginalLane
  stems?: Stem[]
  region?: CueRegion
  takes: Take[]
  finalTakeId?: string
  comp?: CueComp
  output?: CueOutput | null
  textRevision?: number
  approval?: CueApproval | null
  voiceSettingsOverride?: Partial<VoiceSettings>
}

export interface Marker {
  id: string
  t: number
  label: string
}

export interface Clip {
  id: string
  source: { takeId: string } | { fileRef: AudioRef }
  start: number
  edits: ClipEdits
  cueId?: string
  crossfadeWithPrev?: number
}

export interface Track {
  id: string
  name: string
  kind: 'dialogue' | 'reference' | 'music' | 'guide'
  gainDb: number
  muted: boolean
  solo: boolean
  clips: Clip[]
}

export interface Session {
  id: string
  name: string
  sampleRate: number
  tracks: Track[]
  markers: Marker[]
}

export interface ColumnMapping {
  key: string
  text?: string
  sourceText?: string
  character?: string | { fixed: string }
  status?: { column: string; map: Record<string, CueStatus> }
  approvedFlag?: { column: string; value: string }
  duration?: string
}

export interface CsvBinding {
  csvPath: string
  encoding: 'utf-8-sig'
  columnOrder: string[]
  mapping: ColumnMapping
}

export interface TimelineViewState {
  pxPerSec: number
  scroll: number
  originalGainDb?: number
}

export type MatchRule = 'id' | 'exportName' | 'tableId'

export function sanitizeMatchRule(value: unknown): MatchRule | undefined {
  return value === 'id' || value === 'exportName' || value === 'tableId' ? value : undefined
}

export interface UiSessionState {
  activeCueId?: string
  filter: string
  search: string
  scrollIndex?: number
  matchBy?: MatchRule
  targetTrack?: Record<string, string>
  timeline?: Record<string, TimelineViewState>
}

export const TIMELINE_PX_MIN = 2
export const TIMELINE_PX_MAX = 2000

export function sanitizeTimelineViews(
  value: unknown
): Record<string, TimelineViewState> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, TimelineViewState> = {}
  for (const [cueId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!cueId || !raw || typeof raw !== 'object') continue
    const row = raw as Partial<TimelineViewState>
    if (typeof row.pxPerSec !== 'number' || !Number.isFinite(row.pxPerSec)) continue
    const gain = row.originalGainDb
    out[cueId] = {
      pxPerSec: clampTo(row.pxPerSec, TIMELINE_PX_MIN, TIMELINE_PX_MAX),
      scroll: Math.max(0, finiteOr(row.scroll, 0)),
      ...(typeof gain === 'number' && Number.isFinite(gain)
        ? { originalGainDb: clampTo(gain, TRACK_GAIN_MIN_DB, TRACK_GAIN_MAX_DB) }
        : {}),
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function sanitizeTargetTrack(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [cueId, trackId] of Object.entries(value as Record<string, unknown>)) {
    if (cueId && typeof trackId === 'string' && trackId) out[cueId] = trackId
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export interface Term {
  term: string
  translation: string
  note?: string
}

export function sanitizeTerms(rows: unknown): Term[] | undefined {
  if (!Array.isArray(rows)) return undefined
  const out: Term[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Partial<Term>
    const term = typeof row.term === 'string' ? row.term.trim() : ''
    const translation = typeof row.translation === 'string' ? row.translation.trim() : ''
    if (!term || !translation) continue
    const note = typeof row.note === 'string' ? row.note.trim() : ''
    out.push(note ? { term, translation, note } : { term, translation })
  }
  return out.length > 0 ? out : undefined
}

export interface ProjectLanguages {
  source: string
  target: string
}

export function sanitizeLanguages(value: unknown): ProjectLanguages | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Partial<ProjectLanguages>
  const source = typeof row.source === 'string' ? row.source.trim().slice(0, 20) : ''
  const target = typeof row.target === 'string' ? row.target.trim().slice(0, 20) : ''
  return source && target ? { source, target } : undefined
}

export interface Project {
  id: string
  schemaVersion: number
  name: string
  createdAt: string
  media: {
    referenceDir: string
    referencePattern: string
  }
  characters: Character[]
  cues: Cue[]
  sessions: Session[]
  sources?: ProjectSource[]
  versions?: ProjectVersion[]
  pronunciationRules: string
  csvBinding?: CsvBinding
  exportTemplate: string
  export?: ExportSettings
  terms?: Term[]
  languages?: ProjectLanguages
  alienMigrated?: true
  ui: UiSessionState
}

export function sanitizeAlienMigrated(value: unknown): true | undefined {
  return value === true ? true : undefined
}

export function singleFlight<T>(
  keys: Set<string>,
  key: string,
  busyMessage: string,
  fn: () => Promise<T>
): Promise<T> {
  if (keys.has(key)) return Promise.reject(new Error(busyMessage))
  keys.add(key)
  return fn().finally(() => keys.delete(key))
}

export function cueVoiceUnchanged(
  project: Pick<Project, 'cues' | 'characters'>,
  cueId: string,
  characterId: string,
  voiceId: string
): boolean {
  const cue = project.cues.find((c) => c.id === cueId)
  if (!cue || cue.characterId !== characterId) return false
  return project.characters.find((c) => c.id === characterId)?.provider.voiceId === voiceId
}

export interface UsageInfo {
  used: number
  limit: number
  remaining: number
  unit: 'chars'
}

export const STS_CREDITS_PER_MINUTE = 1000
export const MAX_STS_SECONDS = 300

export function estimateStsCredits(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0
  return Math.ceil((durationSec / 60) * STS_CREDITS_PER_MINUTE)
}

export function liveTakes(cue: Cue): Take[] {
  return cue.takes.filter((t) => !t.deletedAt)
}

export function hasVoicedTake(cue: Cue): boolean {
  return liveTakes(cue).some((t) => t.kind !== 'recording')
}

export const ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2'
export const ELEVENLABS_STS_MODEL = 'eleven_multilingual_sts_v2'

export const CHARACTER_COLORS = ['#4fc3f7', '#b58cf0', '#e6a23c', '#46c98c', '#f06292', '#7986cb']

export const characterColor = (index: number): string =>
  CHARACTER_COLORS[((index % CHARACTER_COLORS.length) + CHARACTER_COLORS.length) % CHARACTER_COLORS.length]

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.45,
  similarity: 0.51,
  style: 0,
  speed: 1,
  boost: true,
}

export const VOICE_SETTING_KEYS = [
  'stability',
  'similarity',
  'style',
  'speed',
  'boost',
] as const satisfies readonly (keyof VoiceSettings)[]

export function resolveVoiceSettings(
  character: Pick<Character, 'voiceSettings'> | undefined,
  cue: Pick<Cue, 'voiceSettingsOverride'> | undefined,
  fallback: VoiceSettings = DEFAULT_VOICE_SETTINGS
): VoiceSettings {
  const base = character?.voiceSettings ?? fallback
  const over = cue?.voiceSettingsOverride
  if (!over) return { ...base }
  const out = { ...base }
  for (const k of VOICE_SETTING_KEYS) {
    const v = over[k]
    if (v === undefined) continue
    ;(out as Record<string, unknown>)[k] = v
  }
  return out
}

export function normalizeOverride(
  base: VoiceSettings,
  next: Partial<VoiceSettings>
): Partial<VoiceSettings> | null {
  const out: Partial<VoiceSettings> = {}
  let any = false
  for (const k of VOICE_SETTING_KEYS) {
    const v = next[k]
    if (v === undefined || v === base[k]) continue
    ;(out as Record<string, unknown>)[k] = v
    any = true
  }
  return any ? out : null
}
