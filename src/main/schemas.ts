import { z } from 'zod'
import { isProjectDirIn, isValidProjectName } from '@shared/project-summary'
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

export const projectFileSchema = z
  .object({
    id: z.string().min(1),
    schemaVersion: z.number(),
    name: z.string(),
    media: z.object({ referenceDir: z.string(), referencePattern: z.string() }).passthrough(),
    characters: z.array(z.unknown()),
    cues: z.array(z.unknown()),
    sessions: z.array(z.unknown()),
    pronunciationRules: z.string(),
    exportTemplate: z.string(),
  })
  .passthrough()

const reverbSchema = z.object({
  mix: finite.min(MIX_MIN).max(MIX_MAX),
  size: finite.min(REVERB_SIZE_MIN).max(REVERB_SIZE_MAX),
  decay: finite.min(REVERB_DECAY_MIN).max(REVERB_DECAY_MAX),
  preDelay: finite.min(REVERB_PREDELAY_MIN).max(REVERB_PREDELAY_MAX).optional(),
})

const delaySchema = z.object({
  time: finite.min(DELAY_TIME_MIN).max(DELAY_TIME_MAX),
  feedback: finite.min(DELAY_FEEDBACK_MIN).max(DELAY_FEEDBACK_MAX),
  mix: finite.min(MIX_MIN).max(MIX_MAX),
})

const pitchSchema = z.object({
  semitones: finite.min(PITCH_SEMITONES_MIN).max(PITCH_SEMITONES_MAX),
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
          })
          .refine((c) => c.srcOut > c.srcIn, { message: 'srcOut must be greater than srcIn' })
      )
      .min(1)
      .max(500),
    region: z
      .object({ in: finite.min(0).max(36000), out: finite.min(0).max(36000) })
      .refine((r) => r.out > r.in, { message: 'region out must be greater than in' })
      .optional(),
  })
  .nullable()

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
const cueId = z.object({ cueId: z.string().min(1).max(200) })

export const projectCommandSchema = z.discriminatedUnion('type', [
  cueId.extend({ type: z.literal('cue.saveText'), text: z.string().max(5000) }),
  cueId.extend({ type: z.literal('cue.approve'), approved: z.boolean(), approvedAt: z.string().min(1).optional() }),
  cueId.extend({ type: z.literal('cue.setFinalTake'), takeId: z.string().min(1).max(200) }),
  cueId.extend({ type: z.literal('cue.setComp'), comp: compSchema }),
  cueId.extend({ type: z.literal('cue.acceptSuggestion') }),
  cueId.extend({ type: z.literal('cue.rejectSuggestion') }),
  cueId.extend({ type: z.literal('cue.setVoiceOverride'), override: voiceSettingsSchema.partial().nullable() }),
  cueId.extend({ type: z.literal('cue.deleteTake'), takeId: z.string().min(1).max(200), deletedAt: z.string().min(1).optional() }),
  z.object({ type: z.literal('character.setVoiceSettings'), characterId: z.string().min(1).max(200), settings: voiceSettingsSchema }),
  z.object({ type: z.literal('rules.set'), text: z.string().max(100_000) }),
])
