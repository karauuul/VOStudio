import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-stems-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const store = await import('../src/main/project-store')

const base = (): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> => ({
  name: 'stems',
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues: [
    { id: 'c1', characterId: '', key: 'K1', fields: {}, sourceText: '', text: '', status: 'empty', notes: '', takes: [] },
    { id: 'c2', characterId: '', key: 'K2', fields: {}, sourceText: '', text: '', status: 'empty', notes: '', takes: [] },
  ],
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '',
  ui: { filter: '', search: '' },
})

const exists = (file: string): Promise<boolean> => fs.stat(file).then(() => true, () => false)

describe('stem files', () => {
  it('split, merge, split again writes new files and cleanup keeps only the stems in use', async () => {
    const project = await store.createProject('stems-test', base())
    const first = await store.saveStems('c1', Buffer.from('V1'), Buffer.from('R1'))
    project.cues[0].stems = first
    delete project.cues[0].stems
    const second = await store.saveStems('c1', Buffer.from('V2'), Buffer.from('R2'))
    expect(second.map((s) => s.file.relPath)).not.toEqual(first.map((s) => s.file.relPath))
    for (const stem of [...first, ...second]) expect(await exists(stem.file.relPath)).toBe(true)
    project.cues[0].stems = second
    const orphan = await store.saveStems('c2', Buffer.from('V3'), Buffer.from('R3'))
    await store.dropUnusedStems()
    for (const stem of first) expect(await exists(stem.file.relPath)).toBe(false)
    for (const stem of second) expect(await fs.readFile(stem.file.relPath, 'utf8')).toMatch(/^[VR]2$/)
    expect(await exists(path.dirname(orphan[0].file.relPath))).toBe(false)
    expect(second[0].file.fileId).toBe(`c1/${path.basename(second[0].file.relPath)}`)
  })
})
