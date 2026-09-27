import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { emptyEdits, MAX_STS_SECONDS, type Take } from '@shared/domain'
import type { StsRequest, TtsRequest } from '@shared/ipc'
import type { CommandResult } from '@shared/project-commands'
import { ttsPlan } from '@shared/provider-models'
import { autoSelectsOutput } from './schemas'
import { appendTake, takeBase, type TakeSession } from './take-append'
import type { VoiceProvider } from './providers/voice-provider'

type Publish = (result: CommandResult) => void

export async function createTtsTake(session: TakeSession, req: TtsRequest, provider: VoiceProvider, publish: Publish): Promise<Take> {
  const project = session.repository.projectForMain()
  const cue = project.cues.find((c) => c.id === req.cueId)
  if (!cue) throw new Error('Cue not found')
  const plan = ttsPlan(project, cue, req.text, req.model)
  const { audio, words } = await provider.ttsWithTimestamps({
    text: plan.text,
    voiceId: plan.voiceId,
    model: plan.model,
    ...(plan.language ? { language: plan.language } : {}),
    settings: req.voiceSettings,
  })
  const fileName = `${takeBase()}_tts.mp3`
  return appendTake(
    session,
    req.cueId,
    fileName,
    audio,
    publish,
    (target, abs) => ({
      take: {
        id: randomUUID(),
        kind: 'tts',
        createdAt: new Date().toISOString(),
        file: { fileId: `${target.id}/${fileName}`, relPath: abs, format: 'mp3' },
        duration: 0,
        meta: { text: plan.text, voiceSettings: req.voiceSettings, provider: provider.id, model: plan.model },
        edits: emptyEdits(),
        ...(words ? { words } : {}),
        ...(req.fragment ? { fragment: true as const } : {}),
      },
      select: autoSelectsOutput(req, false),
    }),
    { characterId: plan.character.id, voiceId: plan.voiceId }
  )
}

export async function createStsTake(session: TakeSession, req: StsRequest, provider: VoiceProvider, publish: Publish): Promise<Take> {
  const project = session.repository.projectForMain()
  const cue = project.cues.find((c) => c.id === req.cueId)
  if (!cue) throw new Error('Cue not found')
  const source = cue.takes.find((t) => t.id === req.sourceTakeId)
  if (!source) throw new Error('Source recording not found in this cue')
  if (source.kind !== 'recording') {
    throw new Error('Only a raw voice recording can be converted (take kind "recording")')
  }
  if (source.duration > MAX_STS_SECONDS) {
    throw new Error(
      `Recording is ${source.duration.toFixed(1)}s — ElevenLabs accepts at most ${MAX_STS_SECONDS / 60} min per request`
    )
  }

  const character = project.characters.find((c) => c.id === cue.characterId)
  if (!character) throw new Error('Line has no character')
  if (!character.provider.voiceId) {
    throw new Error(`No voice configured for character "${character.name}"`)
  }

  const audio = await fs.readFile(source.file.relPath)
  const model = project.provider?.sts?.model ?? character.provider.stsModel
  const voiceId = character.provider.voiceId
  const mp3 = await provider.sts({
    audio,
    filename: path.basename(source.file.relPath),
    voiceId,
    model,
    settings: req.voiceSettings,
  })

  const fileName = `${takeBase()}_sts.mp3`
  return appendTake(
    session,
    req.cueId,
    fileName,
    mp3,
    publish,
    (target, abs) => ({
      take: {
        id: randomUUID(),
        kind: 'sts',
        createdAt: new Date().toISOString(),
        file: { fileId: `${target.id}/${fileName}`, relPath: abs, format: 'mp3' },
        duration: source.duration,
        meta: {
          text: target.text,
          voiceSettings: req.voiceSettings,
          sourceTakeId: source.id,
          provider: provider.id,
          model,
        },
        edits: emptyEdits(),
        ...(req.fragment ? { fragment: true as const } : {}),
      },
      select: autoSelectsOutput(req, target.status === 'approved'),
    }),
    { characterId: character.id, voiceId }
  )
}
