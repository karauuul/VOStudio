import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { emptyEdits, type Cue, type Take } from '@shared/domain'
import type { CommandResult } from '@shared/project-commands'
import { maxRecordSeconds } from '@shared/take-import'
import { WAV_HEADER_BYTES, wavDataBytes, wavHeader, type PcmBitDepth } from '@shared/wav-header'
import type { SerialProjectRepository } from './project-repository'
import { audioFilePath } from './project-store'
import { pcmBitDepthSchema } from './schemas'
import { appendTake, takeBase, type TakeSession } from './take-append'

interface Recording {
  session: TakeSession
  cueId: string
  abs: string
  sampleRate: number
  bitDepth: PcmBitDepth
  handle: FileHandle
  written: number
  limit: number
  queue: Promise<unknown>
}

const recordings = new Map<string, Recording>()

const sidecarSchema = z.object({
  cueId: z.string().min(1).max(200),
  sampleRate: z.number().int().min(8000).max(384000),
  startedAt: z.string().max(100),
  bitDepth: pcmBitDepthSchema.optional(),
})

export const recordingsDir = (root: string): string => path.join(root, 'audio', 'recordings')
const sidecarOf = (abs: string): string => `${abs}.json`

const sampleBytes = (bitDepth: PcmBitDepth): number => bitDepth / 8

export function recordingLimitBytes(sampleRate: number, bitDepth: PcmBitDepth = 16): number {
  return (maxRecordSeconds(sampleRate) + 1) * sampleRate * sampleBytes(bitDepth)
}

function recordingTake(cue: Cue, abs: string, fileName: string, sampleRate: number, frames: number, fragment: boolean): Take {
  return {
    id: randomUUID(),
    kind: 'recording',
    createdAt: new Date().toISOString(),
    file: { fileId: `${cue.id}/${fileName}`, relPath: abs, format: 'wav', sampleRate, channels: 1 },
    duration: frames / sampleRate,
    meta: cue.text ? { text: cue.text } : {},
    edits: emptyEdits(),
    ...(fragment ? { fragment: true as const } : {}),
  }
}

async function seal(handle: FileHandle, sampleRate: number, bitDepth: PcmBitDepth): Promise<number> {
  const { size } = await handle.stat()
  const dataBytes = wavDataBytes(size, sampleBytes(bitDepth))
  const end = WAV_HEADER_BYTES + dataBytes
  if (size !== end + (dataBytes % 2)) {
    await handle.truncate(end)
    if (dataBytes % 2) await handle.truncate(end + 1)
  }
  await handle.write(wavHeader(dataBytes, sampleRate, 1, bitDepth), 0, WAV_HEADER_BYTES, 0)
  await handle.sync()
  return dataBytes / sampleBytes(bitDepth)
}

async function sealFile(abs: string, sampleRate: number, bitDepth: PcmBitDepth): Promise<number> {
  const handle = await fs.open(abs, 'r+')
  try {
    return await seal(handle, sampleRate, bitDepth)
  } finally {
    await handle.close()
  }
}

async function adopt(
  session: TakeSession,
  cueId: string,
  partial: string,
  sampleRate: number,
  frames: number,
  fragment: boolean,
  publish: (result: CommandResult) => void
): Promise<Take> {
  const fileName = path.basename(partial)
  return appendTake(session, cueId, fileName, (abs) => fs.link(partial, abs), publish, (cue, abs) => ({
    take: recordingTake(cue, abs, fileName, sampleRate, frames, fragment),
    select: false,
  }))
}

async function discard(abs: string): Promise<void> {
  await fs.rm(abs, { force: true })
  await fs.rm(sidecarOf(abs), { force: true })
}

function live(id: string): Recording {
  const rec = recordings.get(id)
  if (!rec) throw new Error('Recording session has ended')
  if (!rec.session.repository.isLive()) {
    recordings.delete(id)
    void rec.queue.then(() => rec.handle.close()).catch(() => undefined)
    throw new Error('Project was closed during recording')
  }
  return rec
}

function enqueue<T>(rec: Recording, fn: () => Promise<T>): Promise<T> {
  const run = rec.queue.then(fn)
  rec.queue = run.catch(() => undefined)
  return run
}

export async function beginRecording(
  session: TakeSession,
  cueId: string,
  sampleRate: number,
  bitDepth: PcmBitDepth = 16
): Promise<string> {
  if (!session.repository.isLive()) throw new Error('No project is open')
  if (!session.repository.projectForMain().cues.some((c) => c.id === cueId)) throw new Error('Cue not found')
  const dir = recordingsDir(session.dir)
  await fs.mkdir(dir, { recursive: true })
  const fileName = `${takeBase()}_rec.wav`
  const abs = path.join(dir, fileName)
  const handle = await fs.open(abs, 'wx+')
  try {
    await handle.write(wavHeader(0, sampleRate, 1, bitDepth), 0, WAV_HEADER_BYTES, 0)
    const sidecar = { cueId, sampleRate, startedAt: new Date().toISOString(), ...(bitDepth === 16 ? {} : { bitDepth }) }
    await fs.writeFile(sidecarOf(abs), JSON.stringify(sidecar), { flag: 'wx' })
  } catch (error) {
    await handle.close().catch(() => undefined)
    await discard(abs).catch(() => undefined)
    throw error
  }
  const id = randomUUID()
  recordings.set(id, {
    session,
    cueId,
    abs,
    sampleRate,
    bitDepth,
    handle,
    written: 0,
    limit: recordingLimitBytes(sampleRate, bitDepth),
    queue: Promise.resolve(),
  })
  return id
}

export async function appendRecording(id: string, pcm: Buffer): Promise<void> {
  const rec = live(id)
  if (pcm.length % sampleBytes(rec.bitDepth) !== 0) throw new Error('Recording chunk is not whole samples')
  if (rec.written + pcm.length > rec.limit) throw new Error('Recording is too long')
  const at = WAV_HEADER_BYTES + rec.written
  rec.written += pcm.length
  return enqueue(rec, async () => {
    let done = 0
    while (done < pcm.length) {
      const { bytesWritten } = await rec.handle.write(pcm, done, pcm.length - done, at + done)
      if (bytesWritten <= 0) throw new Error('Recording write stalled')
      done += bytesWritten
    }
  })
}

export async function finishRecording(
  id: string,
  fragment: boolean,
  publish: (result: CommandResult) => void
): Promise<Take> {
  const rec = live(id)
  recordings.delete(id)
  const frames = await enqueue(rec, async () => {
    try {
      return await seal(rec.handle, rec.sampleRate, rec.bitDepth)
    } finally {
      await rec.handle.close()
    }
  })
  if (frames === 0) {
    await discard(rec.abs)
    throw new Error('Nothing was recorded')
  }
  const take = await adopt(rec.session, rec.cueId, rec.abs, rec.sampleRate, frames, fragment, publish)
  await rec.session.repository.flush()
  await discard(rec.abs)
  return take
}

export async function abortRecording(id: string): Promise<void> {
  const rec = recordings.get(id)
  if (!rec) return
  recordings.delete(id)
  await enqueue(rec, () => rec.handle.close()).catch(() => undefined)
  await discard(rec.abs)
}

export async function closeRecordings(repository: SerialProjectRepository): Promise<void> {
  const closing: Promise<unknown>[] = []
  for (const [id, rec] of recordings) {
    if (rec.session.repository !== repository) continue
    recordings.delete(id)
    closing.push(enqueue(rec, () => rec.handle.close()).catch(() => undefined))
  }
  await Promise.all(closing)
}

async function readSidecar(file: string): Promise<z.infer<typeof sidecarSchema> | null> {
  try {
    return sidecarSchema.parse(JSON.parse(await fs.readFile(file, 'utf-8')))
  } catch {
    return null
  }
}

export async function recoverRecordings(session: TakeSession): Promise<number> {
  const dir = recordingsDir(session.dir)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const done: string[] = []
  let recovered = 0
  for (const name of names) {
    if (!name.endsWith('.wav.json')) continue
    const abs = path.join(dir, name.slice(0, -'.json'.length))
    const meta = await readSidecar(path.join(dir, name))
    if (!meta) continue
    const cue = session.repository.projectForMain().cues.find((c) => c.id === meta.cueId)
    if (!cue) continue
    const fileId = `${cue.id}/${path.basename(abs)}`
    if (cue.takes.some((t) => t.file.fileId === fileId)) {
      done.push(abs)
      continue
    }
    try {
      const frames = await sealFile(abs, meta.sampleRate, meta.bitDepth ?? 16)
      if (frames > 0) {
        await fs.rm(audioFilePath(session.dir, 'takes', cue.id, path.basename(abs)), { force: true })
        await adopt(session, cue.id, abs, meta.sampleRate, frames, false, () => undefined)
        recovered++
      }
      done.push(abs)
    } catch (error) {
      console.warn(`recording recovery skipped ${path.basename(abs)}:`, error)
    }
  }
  if (done.length === 0) return 0
  await session.repository.flush()
  for (const abs of done) await discard(abs)
  return recovered
}
