import { MAX_STS_SECONDS, resolveVoiceSettings, type Cue, type Project, type VoiceSettings } from './domain'
import { clampVoiceSettings, clipTargetText, hasClip, targetText, type GenTarget } from './generation'
import { ttsPlan } from './provider-models'

export const TTS_TEXT_MAX = 5000

export type AgentTarget = { start: number; end: number } | { clipId: string }

export interface GenerateOptions {
  mode: 'tts' | 'sts'
  target?: AgentTarget
  model?: string
  settings?: Partial<VoiceSettings>
  blocked?: string
}

export interface LinePlan {
  cue: Cue
  mode: 'tts' | 'sts'
  text: string
  rawText: string
  chars: number
  model: string | null
  voice: string | null
  voiceSettings: VoiceSettings
  fragment: boolean
  sourceTakeId?: string
  replaceClipId?: string
  skip?: string
}

function genTarget(project: Project, cue: Cue, target: AgentTarget | undefined): GenTarget {
  if (!target) return { kind: 'all' }
  if ('start' in target) return { kind: 'range', start: target.start, end: target.end }
  if (!hasClip(cue.comp, target.clipId)) {
    throw new Error(`Line ${cue.key} has no clip "${target.clipId}"; call line to list its clips.`)
  }
  return { kind: 'clip', clipId: target.clipId, text: clipTargetText(project, cue, target.clipId) }
}

export function planLine(project: Project, cue: Cue, options: GenerateOptions): LinePlan {
  const character = project.characters.find((c) => c.id === cue.characterId)
  const voiceSettings = clampVoiceSettings(
    resolveVoiceSettings(character, { voiceSettingsOverride: { ...cue.voiceSettingsOverride, ...options.settings } })
  )
  const target = genTarget(project, cue, options.target)
  const base = {
    cue,
    mode: options.mode,
    text: '',
    rawText: '',
    chars: 0,
    model: null,
    voice: character?.provider.voiceId || null,
    voiceSettings,
    fragment: target.kind !== 'all',
    ...(target.kind === 'clip' ? { replaceClipId: target.clipId } : {}),
  }
  const skipped = (skip: string, extra: Partial<LinePlan> = {}): LinePlan => ({ ...base, ...extra, skip })
  if (cue.status === 'excluded') return skipped('excluded')
  if (options.blocked) return skipped(options.blocked)
  if (!character?.provider.voiceId) return skipped('no voice')
  if (options.mode === 'sts') {
    const source = cue.takes.filter((t) => t.kind === 'recording' && !t.deletedAt).at(-1)
    const model = project.provider?.sts?.model ?? character.provider.stsModel
    if (!source) return skipped('no recording', { model })
    const extra = { model, text: source.meta.text ?? '', sourceTakeId: source.id, fragment: source.fragment === true }
    if (source.duration > MAX_STS_SECONDS) return skipped(`recording longer than ${MAX_STS_SECONDS / 60} min`, extra)
    return { ...base, ...extra }
  }
  const text = targetText(cue.text, target)
  const plan = ttsPlan(project, cue, text, options.model)
  const extra = { text: plan.text, rawText: text, chars: plan.text.length, model: plan.model }
  if (!text || !plan.text.trim()) return skipped('no text', { ...extra, chars: 0 })
  if (text.length > TTS_TEXT_MAX) return skipped(`text longer than ${TTS_TEXT_MAX} characters`, { ...extra, chars: 0 })
  return { ...base, ...extra }
}
