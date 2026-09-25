import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../src/shared/project-commands'
import type { Project } from '../src/shared/domain'
import { DECODE_BUDGET_BYTES, maxRecordSeconds } from '../src/shared/take-import'
import { WAV_HEADER_BYTES, wavDataBytes, wavHeader } from '../src/shared/wav-header'
import { encodeWav } from '../src/renderer/audio/wav'
import { recAbortSchema, recBeginSchema, recChunkSchema, recFinishSchema, REC_CHUNK_MAX_BYTES } from '../src/main/schemas'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { SerialProjectRepository } = await import('../src/main/project-repository')
const {
  abortRecording,
  appendRecording,
  beginRecording,
  closeRecordings,
  finishRecording,
  recordingLimitBytes,
  recordingsDir,
  recoverRecordings,
} = await import('../src/main/recording-session')

const RATE = 48000
const SESSION = '0b8f7f9e-3c1a-4f4e-9d2b-6a0c5e1f2a3b'

function project(): Project {
  return {
    id: 'p', schemaVersion: 1, createdAt: 'now', name: 'p', pronunciationRules: '',
    media: { referenceDir: '', referencePattern: '' }, sessions: [], exportTemplate: '',
    characters: [],
    cues: [{ id: 'c', characterId: '', key: 'c', fields: {}, sourceText: '', text: 'line', status: 'translated', notes: '', takes: [] }],
    ui: { filter: '', search: '' },
  }
}

function setup(): { dir: string; repository: InstanceType<typeof SerialProjectRepository>; persist: ReturnType<typeof vi.fn> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-rec-'))
  const persist = vi.fn(() => Promise.resolve())
  return { dir, repository: new SerialProjectRepository(project(), persist, 1), persist }
}

const pcm = (frames: number, value = 1000): Buffer => {
  const out = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) out.writeInt16LE(value, i * 2)
  return out
}

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false)
const listRecordings = async (dir: string): Promise<string[]> => (await fs.readdir(recordingsDir(dir))).sort()

async function crashLeftovers(dir: string, cueId: string, dataBytes: number, name = 't_crash_rec.wav'): Promise<string> {
  await fs.mkdir(recordingsDir(dir), { recursive: true })
  const abs = path.join(recordingsDir(dir), name)
  await fs.writeFile(abs, Buffer.concat([Buffer.from(wavHeader(0, RATE)), Buffer.alloc(dataBytes, 7)]))
  await fs.writeFile(`${abs}.json`, JSON.stringify({ cueId, sampleRate: RATE, startedAt: 'now' }))
  return abs
}

describe('recording IPC schemas', () => {
  it('accepts well-formed requests', () => {
    expect(recBeginSchema.parse({ cueId: 'c', sampleRate: 48000 })).toEqual({ cueId: 'c', sampleRate: 48000 })
    expect(recChunkSchema.safeParse({ session: SESSION, pcm: new ArrayBuffer(4096) }).success).toBe(true)
    expect(recChunkSchema.safeParse({ session: SESSION, pcm: new Uint8Array(8) }).success).toBe(true)
    expect(recFinishSchema.parse({ session: SESSION, fragment: true })).toEqual({ session: SESSION, fragment: true })
    expect(recAbortSchema.parse({ session: SESSION })).toEqual({ session: SESSION })
  })

  it('rejects malformed requests at the boundary', () => {
    expect(recBeginSchema.safeParse({ cueId: '', sampleRate: 48000 }).success).toBe(false)
    expect(recBeginSchema.safeParse({ cueId: 'c', sampleRate: 44100.5 }).success).toBe(false)
    expect(recBeginSchema.safeParse({ cueId: 'c', sampleRate: 1000 }).success).toBe(false)
    expect(recChunkSchema.safeParse({ session: 'nope', pcm: new ArrayBuffer(2) }).success).toBe(false)
    expect(recChunkSchema.safeParse({ session: SESSION, pcm: new ArrayBuffer(3) }).success).toBe(false)
    expect(recChunkSchema.safeParse({ session: SESSION, pcm: new ArrayBuffer(0) }).success).toBe(false)
    expect(recChunkSchema.safeParse({ session: SESSION, pcm: new ArrayBuffer(REC_CHUNK_MAX_BYTES + 2) }).success).toBe(false)
    expect(recChunkSchema.safeParse({ session: SESSION, pcm: 'bytes' }).success).toBe(false)
    expect(recFinishSchema.safeParse({ session: SESSION, fragment: 'yes' }).success).toBe(false)
    expect(recAbortSchema.safeParse({}).success).toBe(false)
  })
})

describe('wav header', () => {
  it('matches the header encodeWav writes', () => {
    const wav = new Uint8Array(encodeWav(new Float32Array(10), 44100))
    expect(wav.subarray(0, WAV_HEADER_BYTES)).toEqual(wavHeader(20, 44100))
  })

  it('derives data size from the file size and drops a trailing partial frame', () => {
    expect(wavDataBytes(WAV_HEADER_BYTES + 1001)).toBe(1000)
    expect(wavDataBytes(WAV_HEADER_BYTES + 1000)).toBe(1000)
    expect(wavDataBytes(WAV_HEADER_BYTES)).toBe(0)
    expect(wavDataBytes(10)).toBe(0)
  })
})

describe('recording ceiling', () => {
  it('derives the longest take from the decode budget', () => {
    expect(maxRecordSeconds(48000)).toBe(Math.floor(DECODE_BUDGET_BYTES / (48000 * 4)))
    expect(maxRecordSeconds(48000)).toBe(1638)
    expect(maxRecordSeconds(44100)).toBeGreaterThan(maxRecordSeconds(48000))
    expect(maxRecordSeconds(48000, 2)).toBe(Math.floor(maxRecordSeconds(48000) / 2))
  })

  it('bounds the 16-bit file with one second of slack', () => {
    expect(recordingLimitBytes(48000)).toBe((1638 + 1) * 48000 * 2)
  })
})

describe('recording session', () => {
  it('streams chunks to a partial file and finishes into a library take', async () => {
    const { dir, repository } = setup()
    const published: CommandResult[] = []
    const id = await beginRecording({ repository, dir }, 'c', RATE)
    const [partialName, sidecarName] = await listRecordings(dir)
    expect(sidecarName).toBe(`${partialName}.json`)
    expect(JSON.parse(await fs.readFile(path.join(recordingsDir(dir), sidecarName), 'utf-8'))).toMatchObject({ cueId: 'c', sampleRate: RATE })

    await appendRecording(id, pcm(24000, 100))
    await appendRecording(id, pcm(24000, -100))
    expect((await fs.stat(path.join(recordingsDir(dir), partialName))).size).toBe(WAV_HEADER_BYTES + 96000)

    const take = await finishRecording(id, true, (r) => published.push(r))
    expect(take).toMatchObject({
      kind: 'recording',
      duration: 1,
      fragment: true,
      meta: { text: 'line' },
      file: { fileId: `c/${partialName}`, format: 'wav', sampleRate: RATE, channels: 1 },
    })
    expect(take.file.relPath).toBe(path.join(dir, 'audio', 'takes', 'c', partialName))
    const bytes = await fs.readFile(take.file.relPath)
    expect(bytes.subarray(0, WAV_HEADER_BYTES)).toEqual(Buffer.from(wavHeader(96000, RATE)))
    expect(bytes.readInt16LE(WAV_HEADER_BYTES)).toBe(100)
    expect(bytes.readInt16LE(WAV_HEADER_BYTES + 48000)).toBe(-100)
    expect(await listRecordings(dir)).toEqual([])
    expect(published).toHaveLength(1)
    expect(repository.snapshot().project.cues[0].takes).toEqual([take])
  })

  it('completes short positional writes before advancing', async () => {
    const { dir, repository } = setup()
    const realOpen = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args)
      const write = handle.write.bind(handle) as (b: Buffer, o: number, l: number, p: number) => Promise<{ bytesWritten: number; buffer: Buffer }>
      Object.assign(handle, {
        write: (b: Buffer, o: number, l: number, p: number) => write(b, o, Math.min(l, 1000), p),
      })
      return handle
    })
    try {
      const id = await beginRecording({ repository, dir }, 'c', RATE)
      await appendRecording(id, pcm(2000, 5))
      await appendRecording(id, pcm(2000, -5))
      const take = await finishRecording(id, false, () => undefined)
      const bytes = await fs.readFile(take.file.relPath)
      expect(bytes.length).toBe(WAV_HEADER_BYTES + 8000)
      expect(bytes.readInt16LE(WAV_HEADER_BYTES + 3998)).toBe(5)
      expect(bytes.readInt16LE(WAV_HEADER_BYTES + 4000)).toBe(-5)
      expect(bytes.readInt16LE(WAV_HEADER_BYTES + 7998)).toBe(-5)
    } finally {
      spy.mockRestore()
    }
  })

  it('abort deletes the partial and appends nothing', async () => {
    const { dir, repository } = setup()
    const id = await beginRecording({ repository, dir }, 'c', RATE)
    await appendRecording(id, pcm(100))
    await abortRecording(id)
    expect(await listRecordings(dir)).toEqual([])
    expect(repository.snapshot().revision).toBe(0)
    await expect(appendRecording(id, pcm(1))).rejects.toThrow()
  })

  it('refuses a missing cue and odd or oversized chunks', async () => {
    const { dir, repository } = setup()
    await expect(beginRecording({ repository, dir }, 'missing', RATE)).rejects.toThrow('Cue not found')
    const id = await beginRecording({ repository, dir }, 'c', 8000)
    await expect(appendRecording(id, Buffer.alloc(3))).rejects.toThrow('whole samples')
    await expect(appendRecording(id, Buffer.alloc(recordingLimitBytes(8000) + 2))).rejects.toThrow('too long')
    await abortRecording(id)
  })

  it('an empty recording leaves no file and no take', async () => {
    const { dir, repository } = setup()
    const id = await beginRecording({ repository, dir }, 'c', RATE)
    await expect(finishRecording(id, false, vi.fn())).rejects.toThrow('Nothing was recorded')
    expect(await listRecordings(dir)).toEqual([])
    expect(repository.snapshot().revision).toBe(0)
  })

  it('refuses chunks and finish after the project switched and keeps the partial for recovery', async () => {
    const { dir, repository } = setup()
    const id = await beginRecording({ repository, dir }, 'c', RATE)
    await appendRecording(id, pcm(480))
    await repository.detach()
    await expect(appendRecording(id, pcm(480))).rejects.toThrow('closed')
    await expect(finishRecording(id, false, vi.fn())).rejects.toThrow()
    const files = await listRecordings(dir)
    expect(files).toHaveLength(2)
    expect((await fs.stat(path.join(recordingsDir(dir), files[0]))).size).toBe(WAV_HEADER_BYTES + 960)
    expect(await exists(path.join(dir, 'audio', 'takes'))).toBe(false)
  })

  it('closing the project ends its sessions but keeps their files', async () => {
    const { dir, repository } = setup()
    const id = await beginRecording({ repository, dir }, 'c', RATE)
    await appendRecording(id, pcm(480))
    await closeRecordings(repository)
    await expect(finishRecording(id, false, vi.fn())).rejects.toThrow('ended')
    expect(await listRecordings(dir)).toHaveLength(2)
  })

  it('a cue deleted during recording keeps the sealed partial and its sidecar', async () => {
    const { dir, repository } = setup()
    const id = await beginRecording({ repository, dir }, 'c', RATE)
    await appendRecording(id, pcm(480))
    await repository.mutate((p) => {
      p.cues = []
      return { cues: [] }
    })
    await expect(finishRecording(id, false, vi.fn())).rejects.toThrow('Cue not found')
    const [partial, sidecar] = await listRecordings(dir)
    expect(sidecar).toBe(`${partial}.json`)
    const bytes = await fs.readFile(path.join(recordingsDir(dir), partial))
    expect(bytes.subarray(0, WAV_HEADER_BYTES)).toEqual(Buffer.from(wavHeader(960, RATE)))
    expect(await fs.readdir(path.join(dir, 'audio', 'takes', 'c'))).toEqual([])
  })
})

describe('recording recovery', () => {
  it('an old project without recordings stays untouched', async () => {
    const { dir, repository, persist } = setup()
    const before = repository.snapshot()
    expect(await recoverRecordings({ repository, dir })).toBe(0)
    expect(repository.snapshot()).toEqual(before)
    expect(await exists(path.join(dir, 'audio'))).toBe(false)
    expect(persist).not.toHaveBeenCalled()
  })

  it('repairs the header, appends the take to its cue and clears the leftovers', async () => {
    const { dir, repository, persist } = setup()
    await crashLeftovers(dir, 'c', 1001)
    expect(await recoverRecordings({ repository, dir })).toBe(1)
    const takes = repository.snapshot().project.cues[0].takes
    expect(takes).toHaveLength(1)
    expect(takes[0]).toMatchObject({ kind: 'recording', duration: 500 / RATE, file: { fileId: 'c/t_crash_rec.wav' } })
    expect(takes[0].fragment).toBeUndefined()
    const bytes = await fs.readFile(takes[0].file.relPath)
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 1000)
    expect(bytes.subarray(0, WAV_HEADER_BYTES)).toEqual(Buffer.from(wavHeader(1000, RATE)))
    expect(await listRecordings(dir)).toEqual([])
    expect(persist).toHaveBeenCalled()
  })

  it('leaves recordings of a missing cue and unreadable sidecars untouched', async () => {
    const { dir, repository } = setup()
    const orphan = await crashLeftovers(dir, 'gone', 100, 't_a_rec.wav')
    const broken = await crashLeftovers(dir, 'c', 100, 't_b_rec.wav')
    await fs.writeFile(`${broken}.json`, '{not json')
    const before = await Promise.all([orphan, broken].map((f) => fs.readFile(f)))
    expect(await recoverRecordings({ repository, dir })).toBe(0)
    expect(await listRecordings(dir)).toHaveLength(4)
    expect(await Promise.all([orphan, broken].map((f) => fs.readFile(f)))).toEqual(before)
    expect(repository.snapshot().revision).toBe(0)
  })

  it('does not duplicate a take whose finish crashed before cleanup', async () => {
    const { dir, repository } = setup()
    await crashLeftovers(dir, 'c', 100)
    expect(await recoverRecordings({ repository, dir })).toBe(1)
    await crashLeftovers(dir, 'c', 100)
    expect(await recoverRecordings({ repository, dir })).toBe(0)
    expect(repository.snapshot().project.cues[0].takes).toHaveLength(1)
    expect(await listRecordings(dir)).toEqual([])
  })

  it('replaces a stale unreferenced link left in the takes folder', async () => {
    const { dir, repository } = setup()
    const abs = await crashLeftovers(dir, 'c', 100)
    const stale = path.join(dir, 'audio', 'takes', 'c', path.basename(abs))
    await fs.mkdir(path.dirname(stale), { recursive: true })
    await fs.link(abs, stale)
    expect(await recoverRecordings({ repository, dir })).toBe(1)
    expect(repository.snapshot().project.cues[0].takes[0].file.relPath).toBe(stale)
  })

  it('drops an empty partial without adding a take', async () => {
    const { dir, repository } = setup()
    await crashLeftovers(dir, 'c', 1)
    expect(await recoverRecordings({ repository, dir })).toBe(0)
    expect(repository.snapshot().revision).toBe(0)
    expect(await listRecordings(dir)).toEqual([])
  })
})
