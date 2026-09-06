import { z } from 'zod'
import { isProjectDirIn, isValidProjectName } from '@shared/project-summary'
import {
  DUCK_MAX_DB,
  DUCK_MIN_DB,
  ORIGINAL_START_MAX,
  TRACK_GAIN_MAX_DB,
  TRACK_GAIN_MIN_DB,
} from '@shared/domain'
import {
  DELAY_FEEDBACK_MAX,
  DELAY_FEEDBACK_MIN,
  DELAY_TIME_MAX,
  DELAY_TIME_MIN,
  MIX_MAX,
  MIX_MIN,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  REVERB_DECAY_MAX,
  REVERB_DECAY_MIN,
  REVERB_PREDELAY_MAX,
  REVERB_PREDELAY_MIN,
  REVERB_SIZE_MAX,
  REVERB_SIZE_MIN,
} from '@shared/effects'

export const finite = z.number().finite()

export const projectDirSchema = (root: string) =>
  z
    .string()
    .min(1)
    .max(4096)
    .refine((dir) => isProjectDirIn(root, dir), { message: 'Path is outside the projects root' })

export const projectNameSchema = z
  .string()
  .max(80)
  .transform((s) => s.trim())
  .refine(isValidProjectName, { message: 'Invalid project name' })

const providerModeSchema = z
  .object({ model: z.string().min(1).max(120).optional(), language: z.string().min(1).max(20).optional() })
  .strict()

const providerSettingsSchema = z
  .object({ tts: providerModeSchema.optional(), sts: providerModeSchema.optional() })
  .strict()

export const projectFileSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.number(),
    name: z.string(),
    media: z.object({ referenceDir: z.string(), referencePattern: z.string() }).passthrough(),
    characters: z.array(z.unknown()),
    cues: z.array(z.unknown()),
    sessions: z.array(z.unknown()),
    sources: z.array(z.unknown()).optional(),
    versions: z.array(z.unknown()).optional(),
    pronunciationRules: z.string(),
    exportTemplate: z.string(),
    export: z.unknown().optional(),
    terms: z.array(z.unknown()).optional(),
    languages: z.object({ source: z.string(), target: z.string() }).optional(),
    provider: z.unknown().optional(),
    alienMigrated: z.literal(true).optional(),
  })
  .passthrough()

export const exportSettingsSchema = z
  .object({
    outDir: z.string().min(1).max(4096).optional(),
    format: z.enum(['source', 'wav-48-24', 'wav-44-16', 'mp3-192', 'ogg']).optional(),
    loudness: z.enum(['match', 'off']).optional(),
    length: z.enum(['trim', 'pad', 'asis']).optional(),
    video: z.enum(['copy', 'audio']).optional(),
    videoName: z.string().min(1).max(400).optional(),
  })
  .nullable()

export const templateMetaSchema = z.object({
  formatVersion: z.literal(1),
  name: z.string().min(1).max(200),
  sourceLang: z.string().min(1).max(20),
  targetLang: z.string().min(1).max(20),
})

export const templateDirSchema = z.string().min(1).max(4096)

export const batchExportSchema = z.object({
  cueIds: z.array(z.string().min(1).max(200)).max(100_000),
})

const exportedCue = z.object({ cueKey: z.string().min(1).max(4096), name: z.string().min(1).max(4096) })

export const exportSummarySchema = z.object({
  exported: z
    .array(
      exportedCue.extend({
        bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      })
    )
    .max(100_000),
  failed: z.array(exportedCue.extend({ reason: z.string().max(2000) })).max(100_000),
})

const bypass = z.literal(false).optional()

const reverbSchema = z.object({
  mix: finite.min(MIX_MIN).max(MIX_MAX),
  size: finite.min(REVERB_SIZE_MIN).max(REVERB_SIZE_MAX),
  decay: finite.min(REVERB_DECAY_MIN).max(REVERB_DECAY_MAX),
  preDelay: finite.min(REVERB_PREDELAY_MIN).max(REVERB_PREDELAY_MAX).optional(),
  enabled: bypass,
})

const delaySchema = z.object({
  time: finite.min(DELAY_TIME_MIN).max(DELAY_TIME_MAX),
  feedback: finite.min(DELAY_FEEDBACK_MIN).max(DELAY_FEEDBACK_MAX),
  mix: finite.min(MIX_MIN).max(MIX_MAX),
  enabled: bypass,
})

const pitchSchema = z.object({
  semitones: finite.min(PITCH_SEMITONES_MIN).max(PITCH_SEMITONES_MAX),
  enabled: bypass,
})

export const clipEffectsSchema = z.object({
  reverb: reverbSchema.optional(),
  delay: delaySchema.optional(),
  pitch: pitchSchema.optional(),
})

export const clipEditsSchema = z.object({
  trimStart: finite.min(0).max(36000),
  trimEnd: finite.min(0).max(36000),
  gainDb: finite.min(-96).max(24),
  fadeIn: z.object({ duration: finite.min(0).max(3600), shape: z.enum(['linear', 'equalPower', 'sCurve']) }),
  fadeOut: z.object({ duration: finite.min(0).max(3600), shape: z.enum(['linear', 'equalPower', 'sCurve']) }),
  timeStretch: finite.min(0.1).max(10).optional(),
  gainEnvelope: z.array(z.object({ t: finite.min(0), db: finite.min(-96).max(24) })).max(500).optional(),
  effects: clipEffectsSchema.optional(),
})

const trackId = z.string().min(1).max(200)

export const compTrackSchema = z.object({
  id: trackId,
  name: z.string().min(1).max(200),
  characterId: z.string().min(1).max(200).optional(),
  gainDb: finite.min(TRACK_GAIN_MIN_DB).max(TRACK_GAIN_MAX_DB),
  muted: z.boolean(),
  solo: z.boolean(),
  effects: clipEffectsSchema.omit({ pitch: true }).optional(),
})

export const compSchema = z
  .object({
    clips: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            sourceTakeId: z.string().min(1).max(200),
            srcIn: finite.min(0).max(36000),
            srcOut: finite.min(0).max(36000),
            start: finite.min(0).max(36000),
            edits: clipEditsSchema,
            crossfade: finite.min(0).max(3600).optional(),
            trackId: trackId.optional(),
          })
          .refine((c) => c.srcOut > c.srcIn, { message: 'srcOut must be greater than srcIn' })
      )
      .min(1)
      .max(500),
    region: z
      .object({ in: finite.min(0).max(36000), out: finite.min(0).max(36000) })
      .refine((r) => r.out > r.in, { message: 'region out must be greater than in' })
      .optional(),
    tracks: z.array(compTrackSchema).min(1).max(100).optional(),
    originalStart: finite.min(0).max(ORIGINAL_START_MAX).optional(),
  })
  .nullable()

export const originalLaneSchema = z
  .object({
    exportMode: z.enum(['off', 'on']),
    duckDb: finite.min(DUCK_MIN_DB).max(DUCK_MAX_DB).optional(),
    previewMuted: z.literal(true).optional(),
  })
  .nullable()

const audioRefSchema = z.object({
  fileId: z.string().min(1).max(400),
  relPath: z.string().min(1).max(4096),
  format: z.enum(['wav', 'mp3', 'ogg']),
  sampleRate: finite.min(1).max(384000).optional(),
  channels: finite.min(1).max(64).optional(),
})

export const stemsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      name: z.string().min(1).max(200),
      file: audioRefSchema,
      exportMode: z.enum(['off', 'on']),
      duckDb: finite.min(DUCK_MIN_DB).max(DUCK_MAX_DB).optional(),
    })
  )
  .min(1)
  .max(20)
  .nullable()

export const cueRegionSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    in: finite.min(0).max(360000),
    out: finite.min(0).max(360000),
  })
  .refine((r) => r.out > r.in, { message: 'region out must be greater than in' })
  .nullable()

export const detectSchema = z.object({
  sourceId: z.string().min(1).max(200),
  mode: z.enum(['silence', 'transcribe']),
})

export const saveVersionSchema = z.object({ name: z.string().max(200).optional() })

const revisionSchema = z.number().int().min(0).max(2_147_483_647)

export const cueOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('take'), takeId: z.string().min(1).max(200), revision: revisionSchema }),
  z.object({ kind: z.literal('comp'), revision: revisionSchema }),
]).nullable()

export const cueApprovalSchema = z.object({
  textRevision: revisionSchema,
  outputRevision: revisionSchema,
  approvedAt: z.string().min(1),
}).nullable()

export const cueRevisionFieldsSchema = z.object({
  textRevision: revisionSchema.optional(),
  output: cueOutputSchema.optional(),
  approval: cueApprovalSchema.optional(),
})

const voiceSettingsSchema = z.object({
  stability: finite.min(0).max(1), similarity: finite.min(0).max(1),
  style: finite.min(0).max(1), speed: finite.min(0.7).max(1.2), boost: z.boolean(),
})
export const ttsSchema = z.object({
  cueId: z.string().min(1),
  text: z.string().min(1).max(5000),
  voiceSettings: voiceSettingsSchema,
  model: z.string().min(1).max(120).optional(),
  fragment: z.boolean().optional(),
  selectOutput: z.boolean().optional(),
})

export const stsSchema = z.object({
  cueId: z.string().min(1),
  sourceTakeId: z.string().min(1),
  voiceSettings: voiceSettingsSchema,
  fragment: z.boolean().optional(),
  selectOutput: z.boolean().optional(),
})

export function autoSelectsOutput(
  req: { fragment?: boolean; selectOutput?: boolean },
  approved: boolean
): boolean {
  if (req.fragment || req.selectOutput === false) return false
  return !approved
}

const cueId = z.object({ cueId: z.string().min(1).max(200) })
const characterId = z.object({ characterId: z.string().min(1).max(200) })
const characterName = z.string().min(1).max(120)
const modelId = z.string().min(1).max(120)

export const projectCommandSchema = z.discriminatedUnion('type', [
  cueId.extend({ type: z.literal('cue.saveText'), text: z.string().max(5000) }),
  cueId.extend({ type: z.literal('cue.approve'), approved: z.boolean(), approvedAt: z.string().min(1).optional() }),
  cueId.extend({ type: z.literal('cue.setFinalTake'), takeId: z.string().min(1).max(200) }),
  cueId.extend({ type: z.literal('cue.setComp'), comp: compSchema }),
  cueId.extend({ type: z.literal('cue.setOriginal'), original: originalLaneSchema }),
  cueId.extend({ type: z.literal('cue.setStems'), stems: stemsSchema }),
  cueId.extend({
    type: z.literal('cue.setTakePinned'),
    takeId: z.string().min(1).max(200),
    pinned: z.boolean(),
  }),
  cueId.extend({
    type: z.literal('cue.setTakeEffects'),
    takeId: z.string().min(1).max(200),
    effects: clipEffectsSchema.nullable(),
  }),
  cueId.extend({ type: z.literal('cue.setRegion'), region: cueRegionSchema }),
  cueId.extend({ type: z.literal('cue.acceptSuggestion') }),
  cueId.extend({ type: z.literal('cue.rejectSuggestion') }),
  cueId.extend({ type: z.literal('cue.setVoiceOverride'), override: voiceSettingsSchema.partial().nullable() }),
  cueId.extend({ type: z.literal('cue.deleteTake'), takeId: z.string().min(1).max(200), deletedAt: z.string().min(1).optional() }),
  cueId.extend({ type: z.literal('cue.setCharacter'), characterId: z.string().max(200) }),
  cueId.extend({ type: z.literal('cue.setExcluded'), excluded: z.boolean() }),
  characterId.extend({ type: z.literal('character.setVoiceSettings'), settings: voiceSettingsSchema }),
  z.object({ type: z.literal('character.create'), id: z.string().min(1).max(200), name: characterName }),
  characterId.extend({ type: z.literal('character.rename'), name: characterName }),
  characterId.extend({
    type: z.literal('character.setProvider'),
    voiceId: z.string().max(200).optional(),
    ttsModel: modelId.optional(),
    stsModel: modelId.optional(),
  }),
  characterId.extend({ type: z.literal('character.delete'), reassignTo: z.string().max(200) }),
  z.object({ type: z.literal('rules.set'), text: z.string().max(100_000) }),
  z.object({ type: z.literal('project.rename'), name: z.string().min(1).max(200) }),
  z.object({
    type: z.literal('project.setLanguages'),
    languages: z
      .object({ source: z.string().min(1).max(20), target: z.string().min(1).max(20) })
      .nullable(),
  }),
  z.object({ type: z.literal('project.setExport'), settings: exportSettingsSchema }),
  z.object({ type: z.literal('project.setProvider'), provider: providerSettingsSchema.nullable() }),
  z.object({ type: z.literal('project.setExportTemplate'), template: z.string().min(1).max(400) }),
])

export const appSettingsSchema = z.object({
  micDeviceId: z.string().max(500).optional(),
  micDeviceLabel: z.string().max(500).optional(),
  outputDeviceLabel: z.string().max(500).optional(),
  countIn: z.boolean(),
  autoReference: z.boolean(),
})
