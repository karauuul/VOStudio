import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { isSafeId } from '../src/shared/project-summary'
import { projectCommandSchema, cueSchema } from '../src/main/schemas'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { audioFilePath, writeTakeFile } = await import('../src/main/project-store')

describe('safe ids', () => {
  it('accepts one plain path segment', () => {
    for (const id of ['c', 'line-001', '3f2b8c1e-0000-4000-8000-000000000000', 'a.b', 'Ada_01']) expect(isSafeId(id)).toBe(true)
  })

  it('refuses separators, parent steps, control characters, reserved characters and empty or long ids', () => {
    for (const id of ['', '.', '..', 'a/b', 'a\\b', '../x', 'a..b', 'x\u0000', 'C:x', 'a ', 'x'.repeat(201), 3, null]) {
      expect(isSafeId(id)).toBe(false)
    }
  })

  it('guards created and restored line ids at the command boundary', () => {
    expect(() => projectCommandSchema.parse({ type: 'cue.create', afterCueId: null, lines: [{ id: '../../../../tmp/escape', text: '' }] })).toThrow()
    expect(() => projectCommandSchema.parse({ type: 'cue.create', afterCueId: null, lines: [{ id: 'ok-id', text: '' }] })).not.toThrow()
    const cue = { id: '../x', characterId: '', key: 'k', fields: {}, sourceText: '', text: '', status: 'empty', notes: '', takes: [] }
    expect(() => cueSchema.parse(cue)).toThrow()
    expect(() => cueSchema.parse({ ...cue, id: 'fine' })).not.toThrow()
    const take = { id: 'a/b', kind: 'tts', createdAt: 'n', file: { fileId: 'f', relPath: '/p/f.wav', format: 'wav' }, duration: 1, meta: {}, edits: { trimStart: 0, trimEnd: 0, gainDb: 0, fadeIn: { duration: 0, shape: 'linear' }, fadeOut: { duration: 0, shape: 'linear' } } }
    expect(() => cueSchema.parse({ ...cue, id: 'fine', takes: [take] })).toThrow()
  })
})

describe('audio writes stay inside the project', () => {
  const root = path.resolve('/work/P.vostudio')

  it('builds the path under audio/<kind>/<cue>/', () => {
    expect(audioFilePath(root, 'takes', 'c1', 't.wav')).toBe(path.join(root, 'audio', 'takes', 'c1', 't.wav'))
    expect(audioFilePath(root, 'stems', 'c1', 'voice.wav')).toBe(path.join(root, 'audio', 'stems', 'c1', 'voice.wav'))
  })

  it('refuses traversal through the cue id or the file name', () => {
    for (const cueId of ['../../../../tmp/escape', '..', '.', '', 'a/b', '/abs']) {
      expect(() => audioFilePath(root, 'takes', cueId, 't.wav')).toThrow('outside the project')
    }
    for (const fileName of ['../t.wav', '../../x.wav', '', '.', 'sub/t.wav', '/tmp/t.wav']) {
      expect(() => audioFilePath(root, 'takes', 'c1', fileName)).toThrow('outside the project')
    }
  })

  it('writes nothing outside when a take write is refused', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-path-'))
    await expect(writeTakeFile(dir, '../../escape', 't.wav', Buffer.from('x'))).rejects.toThrow('outside the project')
    await expect(fs.stat(path.join(dir, '..', 'escape'))).rejects.toThrow()
    expect(await fs.readdir(dir)).toEqual([])
  })
})
