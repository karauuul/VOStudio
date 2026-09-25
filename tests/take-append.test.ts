import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '../src/shared/project-commands'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { SerialProjectRepository } = await import('../src/main/project-repository')
const { appendTake, importTakeFile } = await import('../src/main/take-append')

function project(id: string): Project {
  return {
    id, schemaVersion: 1, createdAt: 'now', name: id, pronunciationRules: '',
    media: { referenceDir: '', referencePattern: '' }, sessions: [], exportTemplate: '',
    characters: [],
    cues: [{ id: 'c', characterId: '', key: 'c', fields: {}, sourceText: '', text: 'line', status: 'translated', notes: '', takes: [] }],
    ui: { filter: '', search: '' },
  }
}

const build = (cue: Cue, abs: string): { take: Take; select: boolean } => ({
  take: {
    id: 'rec', kind: 'recording', createdAt: 'now',
    file: { fileId: `${cue.id}/rec.wav`, relPath: abs, format: 'wav' },
    duration: 1, meta: {}, edits: emptyEdits(),
  },
  select: false,
})

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false)

describe('take append', () => {
  it('stores the file in the session directory and publishes the take', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-take-'))
    const repository = new SerialProjectRepository(project('a'), vi.fn(), 1)
    const published: CommandResult[] = []
    const take = await appendTake({ repository, dir }, 'c', 'rec.wav', Buffer.from('wav'), (r) => published.push(r), build)
    expect(take.file.relPath).toBe(path.join(dir, 'audio', 'takes', 'c', 'rec.wav'))
    expect(await exists(take.file.relPath)).toBe(true)
    expect(published.map((r) => r.revision)).toEqual([1])
    expect(repository.snapshot().project.cues[0].takes).toEqual([take])
  })

  it('rejects and removes the file when its repository is detached during the write', async () => {
    const dirA = mkdtempSync(path.join(os.tmpdir(), 'vostudio-take-a-'))
    const repositoryA = new SerialProjectRepository(project('a'), vi.fn(), 1)
    const initialB = project('b')
    const repositoryB = new SerialProjectRepository(initialB, vi.fn(), 1)
    const publish = vi.fn()

    const writing = appendTake({ repository: repositoryA, dir: dirA }, 'c', 'rec.wav', Buffer.from('wav'), publish, build)
    const detaching = repositoryA.detach()

    await expect(writing).rejects.toThrow('detached')
    await detaching
    expect(await exists(path.join(dirA, 'audio', 'takes', 'c', 'rec.wav'))).toBe(false)
    expect(publish).not.toHaveBeenCalled()
    expect(repositoryB.snapshot()).toEqual({ revision: 0, project: initialB })
  })
})

describe('take file import', () => {
  it('copies a wav into the line takes folder as an imported take', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-imp-'))
    const src = path.join(dir, 'voice.wav')
    await fs.writeFile(src, Buffer.from('RIFF'))
    const repository = new SerialProjectRepository(project('a'), vi.fn(), 1)
    const published: CommandResult[] = []
    const take = await importTakeFile({ repository, dir }, 'c', src, 't_1_imp', (r) => published.push(r))
    expect(take).toMatchObject({ kind: 'imported', file: { format: 'wav', fileId: 'c/t_1_imp.wav' } })
    expect(take.file.relPath).toBe(path.join(dir, 'audio', 'takes', 'c', 't_1_imp.wav'))
    expect(await fs.readFile(take.file.relPath, 'utf8')).toBe('RIFF')
    expect(await exists(src)).toBe(true)
    expect(published).toHaveLength(1)
    expect(repository.snapshot().project.cues[0].takes).toEqual([take])
  })

  it('refuses video and unknown files without touching the project', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-imp-'))
    const repository = new SerialProjectRepository(project('a'), vi.fn(), 1)
    const publish = vi.fn()
    await expect(importTakeFile({ repository, dir }, 'c', path.join(dir, 'clip.mp4'), 'x', publish)).rejects.toThrow('Video')
    await expect(importTakeFile({ repository, dir }, 'c', path.join(dir, 'notes.txt'), 'x', publish)).rejects.toThrow('Unsupported')
    expect(publish).not.toHaveBeenCalled()
    expect(repository.snapshot().revision).toBe(0)
  })

  it('removes the copied file when the line is gone', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-imp-'))
    const src = path.join(dir, 'voice.mp3')
    await fs.writeFile(src, Buffer.from('ID3'))
    const repository = new SerialProjectRepository(project('a'), vi.fn(), 1)
    await expect(importTakeFile({ repository, dir }, 'missing', src, 't_1_imp', vi.fn())).rejects.toThrow('Cue not found')
    expect(await exists(path.join(dir, 'audio', 'takes', 'missing', 't_1_imp.mp3'))).toBe(false)
  })
})
