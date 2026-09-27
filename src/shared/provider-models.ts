import {
  sanitizeProviderSettings,
  type Character,
  type Cue,
  type Project,
  type ProviderModeSettings,
  type ProviderSettings,
} from './domain'
import { targetText, type GenTarget } from './generation'
import { applyRules } from './pronunciation'
import type { GenJob, JobPlan, PlannedVoice, TtsRequest } from './ipc'

export interface ProviderModel {
  id: string
  name: string
  tts: boolean
  sts: boolean
  style: boolean
  boost: boolean
  languages: string[]
  costMultiplier: number
}

export type GenMode = 'tts' | 'sts'

export const V3_MODEL_PREFIX = 'eleven_v3'

export const NO_LANGUAGE_CODE_MODEL = 'eleven_multilingual_v2'

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function parseModels(raw: unknown): ProviderModel[] {
  const rows = (raw as { models?: unknown })?.models ?? raw
  if (!Array.isArray(rows)) return []
  const out: ProviderModel[] = []
  const seen = new Set<string>()
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row['model_id'] === 'string' ? row['model_id'] : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const rates = (row['model_rates'] ?? {}) as Record<string, unknown>
    const cost = finite(rates['character_cost_multiplier']) ?? 1
    const discount = finite(rates['cost_discount_multiplier']) ?? 1
    const languages: string[] = []
    if (Array.isArray(row['languages'])) {
      for (const lang of row['languages']) {
        const code = (lang as { language_id?: unknown })?.language_id
        if (typeof code === 'string' && code && !languages.includes(code)) languages.push(code)
      }
    }
    out.push({
      id,
      name: typeof row['name'] === 'string' && row['name'] ? row['name'] : id,
      tts: row['can_do_text_to_speech'] === true,
      sts: row['can_do_voice_conversion'] === true,
      style: row['can_use_style'] === true,
      boost: row['can_use_speaker_boost'] === true,
      languages,
      costMultiplier: cost > 0 ? cost * (discount > 0 ? discount : 1) : 1,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export const modelsFor = (models: ProviderModel[], mode: GenMode): ProviderModel[] =>
  models.filter((m) => (mode === 'tts' ? m.tts : m.sts))

export const isV3 = (model: ProviderModel | undefined): boolean =>
  !!model && model.id.startsWith(V3_MODEL_PREFIX)

export type VoiceSettingKey = 'stability' | 'similarity' | 'style' | 'speed' | 'boost'

export function supportedSettings(
  model: ProviderModel | undefined,
  mode: GenMode
): VoiceSettingKey[] {
  if (isV3(model)) return ['stability']
  const out: VoiceSettingKey[] = ['stability', 'similarity']
  if (model?.style ?? true) out.push('style')
  if (mode === 'tts') out.push('speed')
  if (model?.boost ?? true) out.push('boost')
  return out
}

export const supportsLanguageCode = (
  model: ProviderModel | undefined,
  mode: GenMode
): boolean => mode === 'tts' && !!model && model.id !== NO_LANGUAGE_CODE_MODEL && model.languages.length > 0

export function nextProviderSettings(
  current: ProviderSettings | undefined,
  mode: GenMode,
  patch: ProviderModeSettings,
  models: ProviderModel[] = []
): ProviderSettings | undefined {
  const merged: ProviderModeSettings = { ...current?.[mode], ...patch }
  if (patch.model !== undefined && patch.language === undefined && merged.language) {
    const model = models.find((m) => m.id === patch.model)
    if (!supportsLanguageCode(model, mode) || !model?.languages.includes(merged.language))
      merged.language = undefined
  }
  return sanitizeProviderSettings({ ...current, [mode]: merged })
}

export function estimateChars(
  cueText: string,
  target: GenTarget,
  rules: string,
  model?: ProviderModel
): number {
  const text = applyRules(targetText(cueText, target), rules)
  if (!text) return 0
  return Math.ceil(text.length * (model?.costMultiplier ?? 1))
}

export interface TtsPlan {
  character: Character
  voiceId: string
  text: string
  model: string
  language?: string
}

export const VOICE_CHANGED = 'The line\'s character or voice changed after planning; run generate again'

function voicedCharacter(project: Project, cue: Cue): Character & { provider: { voiceId: string } } {
  const character = project.characters.find((c) => c.id === cue.characterId)
  if (!character) throw new Error('Line has no character')
  if (!character.provider.voiceId) {
    throw new Error(`No voice configured for character "${character.name}"`)
  }
  return character
}

function plannedCharacter(project: Project, cue: Cue, planned: PlannedVoice): Character {
  const character = project.characters.find((c) => c.id === cue.characterId)
  if (!character || character.id !== planned.characterId || character.provider.voiceId !== planned.voiceId) {
    throw new Error(VOICE_CHANGED)
  }
  return character
}

export function ttsPlan(project: Project, cue: Cue, text: string, model?: string): TtsPlan {
  const character = voicedCharacter(project, cue)
  const mode = project.provider?.tts
  const projectModel = mode?.model ?? character.provider.ttsModel
  const chosen = model ?? projectModel
  return {
    character,
    voiceId: character.provider.voiceId,
    text: applyRules(text, project.pronunciationRules),
    model: chosen,
    ...(mode?.language && chosen === projectModel && chosen !== NO_LANGUAGE_CODE_MODEL ? { language: mode.language } : {}),
  }
}

export function jobTtsPlan(project: Project, cue: Cue, req: TtsRequest & JobPlan): TtsPlan {
  const text = req.providerText ?? applyRules(req.text, project.pronunciationRules)
  if (!req.planned) return { ...ttsPlan(project, cue, req.text, req.model), text }
  const { voiceId, model, language } = req.planned
  return { character: plannedCharacter(project, cue, req.planned), voiceId, text, model, ...(language ? { language } : {}) }
}

export interface StsPlan {
  character: Character
  voiceId: string
  model: string
}

export function stsPlan(project: Project, cue: Cue, planned?: PlannedVoice): StsPlan {
  if (planned) return { character: plannedCharacter(project, cue, planned), voiceId: planned.voiceId, model: planned.model }
  const character = voicedCharacter(project, cue)
  return { character, voiceId: character.provider.voiceId, model: project.provider?.sts?.model ?? character.provider.stsModel }
}

export const jobChars = (req: GenJob, rules: string): number =>
  req.kind === 'tts' ? (req.providerText ?? applyRules(req.text, rules)).length : 0

export const AUDIO_TAGS = [
  'whispers',
  'laughs',
  'sighs',
  'exhales',
  'excited',
  'curious',
  'sarcastic',
  'crying',
  'mischievously',
  'sings',
] as const

export function insertTag(
  text: string,
  start: number,
  end: number,
  tag: string
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(text.length, Math.trunc(start)))
  const to = Math.max(at, Math.min(text.length, Math.trunc(end)))
  const before = text.slice(0, at)
  const after = text.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const insert = `${lead}[${tag}]${trail}`
  return { text: before + insert + after, caret: at + insert.length }
}
