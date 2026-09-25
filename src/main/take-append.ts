import { constants, promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { changeTakeOutput } from '@shared/approval'
import { cueVoiceUnchanged, emptyEdits, type AudioRef, type Cue, type Take } from '@shared/domain'
import type { CommandResult } from '@shared/project-commands'
import { DECODE_BUDGET_BYTES, importProblem, takeFileKind } from '@shared/take-import'
import type { SerialProjectRepository } from './project-repository'
import { writeTakeFile, type AudioWriter } from './project-store'
import { probeMedia, runFfmpeg } from './ffmpeg'

export interface TakeSession {
  repository: SerialProjectRepository
  dir: string
}

export async function appendTake(
  session: TakeSession,
  cueId: string,
  fileName: string,
  data: AudioWriter,
  publish: (result: CommandResult) => void,
  build: (cue: Cue, abs: string) => { take: Take; select: boolean },
  voice?: { characterId: string; voiceId: string }
): Promise<Take> {
  const abs = await writeTakeFile(session.dir, cueId, fileName, data)
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

async function transcode(src: string, abs: string): Promise<void> {
  await runFfmpeg(['-i', src, '-vn', '-c:a', 'pcm_s16le', '-fs', String(DECODE_BUDGET_BYTES), abs])
  if ((await fs.stat(abs)).size >= DECODE_BUDGET_BYTES) throw new Error('Converted audio is too large')
}

export async function importTakeFile(
  session: TakeSession,
  cueId: string,
  src: string,
  baseName: string,
  publish: (result: CommandResult) => void
): Promise<Take> {
  const kind = takeFileKind(src)
  if (kind === 'video') throw new Error('Video goes to Import')
  if (kind === 'unsupported') throw new Error('Unsupported file type')
  await fs.access(src)
  const probe = await probeMedia(src)
  if (!probe.hasAudio) throw new Error('No audio in file')
  const problem = importProblem(probe)
  if (problem) throw new Error(problem)
  const duration = probe.duration
  const format: AudioRef['format'] = kind === 'keep' ? (path.extname(src).slice(1).toLowerCase() as AudioRef['format']) : 'wav'
  const fileName = `${baseName}.${format}`
  const write = kind === 'keep' ? (abs: string) => fs.copyFile(src, abs, constants.COPYFILE_EXCL) : (abs: string) => transcode(src, abs)
  return appendTake(session, cueId, fileName, write, publish, (cue, abs) => ({
    take: {
      id: randomUUID(),
      kind: 'imported',
      createdAt: new Date().toISOString(),
      file: { fileId: `${cue.id}/${fileName}`, relPath: abs, format },
      duration: duration ?? 0,
      meta: {},
      edits: emptyEdits(),
    },
    select: false,
  }))
}
