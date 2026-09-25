import { promises as fs } from 'fs'
import { changeTakeOutput } from '@shared/approval'
import { cueVoiceUnchanged, type Cue, type Take } from '@shared/domain'
import type { CommandResult } from '@shared/project-commands'
import type { SerialProjectRepository } from './project-repository'
import { writeTakeFile } from './project-store'

export interface TakeSession {
  repository: SerialProjectRepository
  dir: string
}

export async function appendTake(
  session: TakeSession,
  cueId: string,
  fileName: string,
  bytes: Buffer,
  publish: (result: CommandResult) => void,
  build: (cue: Cue, abs: string) => { take: Take; select: boolean },
  voice?: { characterId: string; voiceId: string }
): Promise<Take> {
  const abs = await writeTakeFile(session.dir, cueId, fileName, bytes)
  let added!: Take
  let result: CommandResult | null
  try {
    result = await session.repository.mutate((project) => {
      const cue = project.cues.find((c) => c.id === cueId)
      if (voice && !cueVoiceUnchanged(project, cueId, voice.characterId, voice.voiceId)) {
        throw new Error('Discarded: cue reassigned during generation')
      }
      if (!cue) throw new Error('Cue not found')
      const { take, select } = build(cue, abs)
      const withTake = { ...cue, takes: [...cue.takes, take] }
      Object.assign(cue, select ? changeTakeOutput(withTake, take.id, project) : withTake)
      added = take
      return { cues: [cue] }
    })
  } catch (error) {
    await fs.rm(abs, { force: true }).catch(() => undefined)
    throw error
  }
  if (result) publish(result)
  return added
}
