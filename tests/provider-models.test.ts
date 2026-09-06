import { describe, expect, it } from 'vitest'
import {
  AUDIO_TAGS,
  estimateChars,
  insertTag,
  isV3,
  modelsFor,
  parseModels,
  supportedSettings,
  supportsLanguageCode,
} from '../src/shared/provider-models'
import {
  nextProviderSettings,
  sanitizeGenMode,
  sanitizeProviderSettings,
  type Project,
} from '../src/shared/domain'
import { projectCommandSchema, projectFileSchema } from '../src/main/schemas'
import { applyChangeSet, applyProjectCommand } from '../src/shared/project-commands'

const fixture = {
  models: [
    {
      model_id: 'eleven_multilingual_v2',
      name: 'Eleven Multilingual v2',
      can_do_text_to_speech: true,
      can_do_voice_conversion: false,
      can_use_style: true,
      can_use_speaker_boost: true,
      languages: [
        { language_id: 'en', name: 'English' },
        { language_id: 'uk', name: 'Ukrainian' },
      ],
      model_rates: { character_cost_multiplier: 1, cost_discount_multiplier: 1 },
    },
    {
      model_id: 'eleven_v3',
      name: 'Eleven v3',
      can_do_text_to_speech: true,
      can_do_voice_conversion: false,
      can_use_style: false,
      can_use_speaker_boost: false,
      languages: [{ language_id: 'en', name: 'English' }],
      model_rates: { character_cost_multiplier: 1 },
    },
    {
      model_id: 'eleven_flash_v2_5',
      name: 'Eleven Flash v2.5',
      can_do_text_to_speech: true,
      can_do_voice_conversion: false,
      can_use_style: false,
      can_use_speaker_boost: true,
      languages: [{ language_id: 'en', name: 'English' }],
      model_rates: { character_cost_multiplier: 0.5, cost_discount_multiplier: 1 },
    },
    {
      model_id: 'eleven_multilingual_sts_v2',
      name: 'Eleven Multilingual STS v2',
      can_do_text_to_speech: false,
      can_do_voice_conversion: true,
      can_use_style: true,
      can_use_speaker_boost: true,
      languages: [],
      model_rates: { character_cost_multiplier: 1 },
    },
  ],
}

const models = parseModels(fixture)
const byId = (id: string) => models.find((m) => m.id === id)

describe('parseModels', () => {
  it('keeps the documented flags, languages and cost multiplier', () => {
    expect(byId('eleven_multilingual_v2')).toEqual({
      id: 'eleven_multilingual_v2',
      name: 'Eleven Multilingual v2',
      tts: true,
      sts: false,
      style: true,
      boost: true,
      languages: ['en', 'uk'],
      costMultiplier: 1,
    })
    expect(byId('eleven_flash_v2_5')?.costMultiplier).toBe(0.5)
  })

  it('accepts a bare array, drops junk rows and duplicates', () => {
    expect(parseModels([{ model_id: 'a' }, null, { name: 'x' }, { model_id: 'a' }])).toEqual([
      { id: 'a', name: 'a', tts: false, sts: false, style: false, boost: false, languages: [], costMultiplier: 1 },
    ])
    expect(parseModels(undefined)).toEqual([])
    expect(parseModels({ models: 'no' })).toEqual([])
  })

  it('filters by mode', () => {
    expect(modelsFor(models, 'tts').map((m) => m.id)).toEqual([
      'eleven_flash_v2_5',
      'eleven_multilingual_v2',
      'eleven_v3',
    ])
    expect(modelsFor(models, 'sts').map((m) => m.id)).toEqual(['eleven_multilingual_sts_v2'])
  })
})

describe('supportedSettings', () => {
  it('v3 accepts stability only', () => {
    expect(isV3(byId('eleven_v3'))).toBe(true)
    expect(supportedSettings(byId('eleven_v3'), 'tts')).toEqual(['stability'])
  })

  it('multilingual v2 accepts every setting', () => {
    expect(supportedSettings(byId('eleven_multilingual_v2'), 'tts')).toEqual([
      'stability',
      'similarity',
      'style',
      'speed',
      'boost',
    ])
  })

  it('flash v2.5 drops style', () => {
    expect(supportedSettings(byId('eleven_flash_v2_5'), 'tts')).toEqual([
      'stability',
      'similarity',
      'speed',
      'boost',
    ])
  })

  it('speech to speech has no speed', () => {
    expect(supportedSettings(byId('eleven_multilingual_sts_v2'), 'sts')).toEqual([
      'stability',
      'similarity',
      'style',
      'boost',
    ])
  })

  it('an unknown model in speech to speech keeps everything but speed', () => {
    expect(supportedSettings(undefined, 'sts')).toEqual([
      'stability',
      'similarity',
      'style',
      'boost',
    ])
  })

  it('an unknown model keeps every control', () => {
    expect(supportedSettings(undefined, 'tts')).toEqual([
      'stability',
      'similarity',
      'style',
      'speed',
      'boost',
    ])
  })
})

describe('supportsLanguageCode', () => {
  it('is refused for multilingual v2 and for speech to speech', () => {
    expect(supportsLanguageCode(byId('eleven_multilingual_v2'), 'tts')).toBe(false)
    expect(supportsLanguageCode(byId('eleven_v3'), 'sts')).toBe(false)
    expect(supportsLanguageCode(byId('eleven_multilingual_sts_v2'), 'sts')).toBe(false)
  })

  it('is offered for a model that lists languages', () => {
    expect(supportsLanguageCode(byId('eleven_v3'), 'tts')).toBe(true)
  })
})

describe('estimateChars', () => {
  const text = 'Привіт, світ!'

  it('counts every character of the whole translation', () => {
    expect(estimateChars(text, { kind: 'all' }, '', byId('eleven_multilingual_v2'))).toBe(text.length)
  })

  it('counts only the selected range', () => {
    expect(estimateChars(text, { kind: 'range', start: 0, end: 6 }, '', undefined)).toBe(6)
  })

  it('counts the clip text a regeneration would send', () => {
    expect(estimateChars(text, { kind: 'clip', clipId: 'x', text: 'світ' }, '', undefined)).toBe(4)
  })

  it('counts the text after the pronunciation rules, not before', () => {
    expect(estimateChars('ГАБ', { kind: 'all' }, 'ГАБ → габу-два', undefined)).toBe(8)
  })

  it('applies the model cost multiplier and rounds up', () => {
    expect(estimateChars('abcde', { kind: 'all' }, '', byId('eleven_flash_v2_5'))).toBe(3)
  })

  it('is zero for an empty target', () => {
    expect(estimateChars('', { kind: 'all' }, '', undefined)).toBe(0)
  })
})

describe('insertTag', () => {
  it('inserts at the caret with the spacing the neighbours need', () => {
    expect(insertTag('abc', 3, 3, 'laughs')).toEqual({ text: 'abc [laughs]', caret: 12 })
    expect(insertTag('', 0, 0, 'sighs')).toEqual({ text: '[sighs]', caret: 7 })
    expect(insertTag('a b', 2, 2, 'sings')).toEqual({ text: 'a [sings] b', caret: 10 })
  })

  it('replaces the selection and clamps a caret outside the text', () => {
    expect(insertTag('one two', 4, 7, 'excited')).toEqual({ text: 'one [excited]', caret: 13 })
    expect(insertTag('ab', 99, 99, 'laughs').text).toBe('ab [laughs]')
  })

  it('offers only documented tags', () => {
    expect(AUDIO_TAGS).toContain('whispers')
    expect(AUDIO_TAGS).not.toContain('pause')
  })
})

describe('provider settings on the project', () => {
  it('an empty or junk value stays absent', () => {
    expect(sanitizeProviderSettings(undefined)).toBeUndefined()
    expect(sanitizeProviderSettings({})).toBeUndefined()
    expect(sanitizeProviderSettings({ tts: {}, sts: { model: '' } })).toBeUndefined()
    expect(sanitizeProviderSettings({ tts: { model: 'm', junk: 1 } })).toEqual({ tts: { model: 'm' } })
  })

  it('patches one mode and leaves the other alone', () => {
    const first = nextProviderSettings(undefined, 'tts', { model: 'eleven_v3' })
    expect(first).toEqual({ tts: { model: 'eleven_v3' } })
    const second = nextProviderSettings(first, 'sts', { model: 'sts_v2' })
    expect(second).toEqual({ tts: { model: 'eleven_v3' }, sts: { model: 'sts_v2' } })
    expect(nextProviderSettings(second, 'tts', { language: 'uk' })).toEqual({
      tts: { model: 'eleven_v3', language: 'uk' },
      sts: { model: 'sts_v2' },
    })
  })

  it('the zod mirror keeps the field and never refuses a hand-edited project', () => {
    const parsed = projectFileSchema.parse({
      id: 'p',
      schemaVersion: 1,
      name: 'n',
      media: { referenceDir: '', referencePattern: '' },
      characters: [],
      cues: [],
      sessions: [],
      pronunciationRules: '',
      exportTemplate: '',
      provider: { tts: { model: 'eleven_v3', language: 'uk', extra: 1 }, sts: { model: 'sts_v2' } },
    }) as { provider?: unknown }
    expect(parsed.provider).toEqual({
      tts: { model: 'eleven_v3', language: 'uk', extra: 1 },
      sts: { model: 'sts_v2' },
    })
    expect(sanitizeProviderSettings(parsed.provider)).toEqual({
      tts: { model: 'eleven_v3', language: 'uk' },
      sts: { model: 'sts_v2' },
    })
  })

  it('the command schema refuses an unknown key', () => {
    expect(() =>
      projectCommandSchema.parse({
        type: 'project.setProvider',
        provider: { tts: { model: 'm', extra: 1 } },
      })
    ).toThrow()
  })

  it('a change set carries the provider back to the renderer', () => {
    const base = { id: 'p', characters: [], cues: [], sessions: [] } as unknown as Project
    const set = applyChangeSet(base, { provider: { tts: { model: 'eleven_v3' } } })
    expect(set.provider).toEqual({ tts: { model: 'eleven_v3' } })
    expect(applyChangeSet(set, { provider: null })).not.toHaveProperty('provider')
    expect(applyChangeSet(set, {}).provider).toEqual({ tts: { model: 'eleven_v3' } })
  })

  it('project.setProvider stores the settings and null removes them', () => {
    const project = {
      id: 'p',
      characters: [],
      cues: [],
      sessions: [],
    } as unknown as Project
    applyProjectCommand(
      project,
      projectCommandSchema.parse({
        type: 'project.setProvider',
        provider: { tts: { model: 'eleven_v3' } },
      }) as never
    )
    expect(project.provider).toEqual({ tts: { model: 'eleven_v3' } })
    applyProjectCommand(
      project,
      projectCommandSchema.parse({ type: 'project.setProvider', provider: null }) as never
    )
    expect(project).not.toHaveProperty('provider')
  })
})

describe('genMode in ui.json', () => {
  it('keeps only the two modes', () => {
    expect(sanitizeGenMode('tts')).toBe('tts')
    expect(sanitizeGenMode('sts')).toBe('sts')
    expect(sanitizeGenMode('record')).toBeUndefined()
    expect(sanitizeGenMode(undefined)).toBeUndefined()
  })
})
