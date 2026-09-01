import type { ClipEffects } from './effects'

export type { ClipEffects, DelayEffect, ReverbEffect } from './effects'

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
  rating?: 0 | 1 | 2 | 3
  fragment?: true
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
}

export interface CompRegion {
  in: number
  out: number
}

export interface CueComp {
  clips: CompClip[]
  region?: CompRegion
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

export interface UiSessionState {
  activeCueId?: string
  filter: string
  search: string
  scrollIndex?: number
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
  pronunciationRules: string
  csvBinding?: CsvBinding
  exportTemplate: string
  terms?: Term[]
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
