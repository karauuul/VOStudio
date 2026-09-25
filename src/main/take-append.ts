import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { changeTakeOutput } from '@shared/approval'
import { cueVoiceUnchanged, emptyEdits, type AudioRef, type Cue, type Take } from '@shared/domain'
import type { CommandResult } from '@shared/project-commands'
import { takeFileKind } from '@shared/take-import'
import type { SerialProjectRepository } from './project-repository'
import { writeTakeFile } from './project-store'
import { probeDuration } from './audio-import'
import { runFfmpeg } from './ffmpeg'

const MAX_IMPORT_BYTES = 200 * 1024 * 1024

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

async function readAudio(src: string): Promise<{ bytes: Buffer; format: AudioRef['format']; duration?: number }> {
  const kind = takeFileKind(src)
  if (kind === 'video') throw new Error('Video goes to Import')
  if (kind === 'unsupported') throw new Error('Unsupported file type')
  const { size } = await fs.stat(src)
  if (size > MAX_IMPORT_BYTES) throw new Error('File is too large')
  if (kind === 'keep') {
    const format = path.extname(src).slice(1).toLowerCase() as AudioRef['format']
    return { bytes: await fs.readFile(src), format, duration: await probeDuration(src) }
  }
  const tmp = path.join(os.tmpdir(), `vostudio-import-${randomUUID()}.wav`)
  try {
    await runFfmpeg(['-i', src, '-vn', '-c:a', 'pcm_s16le', tmp])
    return { bytes: await fs.readFile(tmp), format: 'wav', duration: await probeDuration(tmp) }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

export async function importTakeFile(
  session: TakeSession,
  cueId: string,
  src: string,
  baseName: string,
  publish: (result: CommandResult) => void
): Promise<Take> {
  const { bytes, format, duration } = await readAudio(src)
  const fileName = `${baseName}.${format}`
  return appendTake(session, cueId, fileName, bytes, publish, (cue, abs) => ({
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
