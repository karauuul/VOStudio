import { targetText, type GenTarget } from './generation'
import { applyRules } from './pronunciation'

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
