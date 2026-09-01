import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-ui-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const store = await import('../src/main/project-store')

const PROJECT_DIR = path.join(H.root, 'VOStudio', 'ui-test.vostudio')

const base = (): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> => ({
  name: 'ui-test',
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues: [
    {
      id: 'cue-1',
      characterId: 'ada',
      key: 'K1',
      fields: {},
      sourceText: 'src',
      text: '',
      status: 'empty',
      notes: '',
      takes: [],
    },
  ],
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '',
  ui: { filter: '', search: '' },
})

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>

const autosaveCount = async (dir: string): Promise<number> =>
  (await fs.readdir(path.join(dir, 'autosave'))).length

describe('ui.json', () => {
  beforeAll(async () => {
    await store.createProject('ui-test', base())
  })

  it('project creation: ui.json exists, project.json has no ui', async () => {
    const ui = await readJson(path.join(PROJECT_DIR, 'ui.json'))
    expect(ui).toEqual({ filter: '', search: '' })
    expect(await readJson(path.join(PROJECT_DIR, 'project.json'))).not.toHaveProperty('ui')
  })

  it('10 active cue switches: zero project.json writes and zero autosaves', async () => {
    const file = path.join(PROJECT_DIR, 'project.json')
    const before = await fs.readFile(file, 'utf-8')
    const beforeMtime = (await fs.stat(file)).mtimeMs
    const beforeAutosave = await autosaveCount(PROJECT_DIR)

    for (let i = 0; i < 10; i++) {
      await store.saveUi({ activeCueId: `cue-${i}`, filter: 'all', search: '' })
    }

    expect(await fs.readFile(file, 'utf-8')).toBe(before)
    expect((await fs.stat(file)).mtimeMs).toBe(beforeMtime)
    expect(await autosaveCount(PROJECT_DIR)).toBe(beforeAutosave)
    expect(await readJson(path.join(PROJECT_DIR, 'ui.json'))).toEqual({
      activeCueId: 'cue-9',
      filter: 'all',
      search: '',
    })
  })

  it('a real mutation: one project.json persist + one autosave, ui does not land in project.json', async () => {
    const beforeAutosave = await autosaveCount(PROJECT_DIR)
    const p = store.getProject()!
    p.cues[0]!.text = 'новий текст'
    await store.saveProject(p)

    const saved = await readJson(path.join(PROJECT_DIR, 'project.json'))
    expect(saved).not.toHaveProperty('ui')
    expect((saved['cues'] as Array<{ text: string }>)[0]!.text).toBe('новий текст')
    expect(await autosaveCount(PROJECT_DIR)).toBe(beforeAutosave + 1)
    expect(await readJson(path.join(PROJECT_DIR, 'ui.json'))).toHaveProperty('activeCueId', 'cue-9')
  })

  it('reopening restores the same active cue', async () => {
    const reopened = await store.openProjectDir(PROJECT_DIR)
    expect(reopened?.ui.activeCueId).toBe('cue-9')
    expect(reopened?.cues[0]?.text).toBe('новий текст')
  })

  it('does not publish the new project or path when the target write fails', async () => {
    const previousProject = store.getProject()
    const previousDir = store.getProjectDir()
    const originalWriteFile = fs.writeFile.bind(fs)
    const failingWrite = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file).endsWith(path.join('broken.vostudio', 'ui.json.tmp'))) throw new Error('read only')
      return originalWriteFile(file, data, options)
    })
    try {
      await expect(store.createProject('broken', base())).rejects.toThrow('read only')
      expect(store.getProject()).toBe(previousProject)
      expect(store.getProjectDir()).toBe(previousDir)
    } finally {
      failingWrite.mockRestore()
    }
  })
})

describe('migration of an old project.json', () => {
  const LEGACY_DIR = path.join(H.root, 'VOStudio', 'legacy.vostudio')

  it('ui from an old project.json moves into ui.json, project.json is not rewritten', async () => {
    await fs.mkdir(path.join(LEGACY_DIR, 'autosave'), { recursive: true })
    const legacy = {
      ...base(),
      id: 'legacy',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      ui: { activeCueId: 'legacy-cue', filter: 'work', search: 'foo' },
    }
    const file = path.join(LEGACY_DIR, 'project.json')
    await fs.writeFile(file, JSON.stringify(legacy, null, 2))
    const before = await fs.readFile(file, 'utf-8')

    const opened = await store.openProjectDir(LEGACY_DIR)

    expect(opened?.ui).toEqual({ activeCueId: 'legacy-cue', filter: 'work', search: 'foo' })
    expect(await readJson(path.join(LEGACY_DIR, 'ui.json'))).toEqual(opened?.ui)
    expect(await fs.readFile(file, 'utf-8')).toBe(before)
    expect(await autosaveCount(LEGACY_DIR)).toBe(0)
  })

  it('migration is idempotent: a second open does not rewrite ui.json', async () => {
    const uiFile = path.join(LEGACY_DIR, 'ui.json')
    const mtime = (await fs.stat(uiFile)).mtimeMs
    const opened = await store.openProjectDir(LEGACY_DIR)
    expect(opened?.ui.activeCueId).toBe('legacy-cue')
    expect((await fs.stat(uiFile)).mtimeMs).toBe(mtime)
  })

  it('a corrupted ui.json does not break opening', async () => {
    await fs.writeFile(path.join(LEGACY_DIR, 'ui.json'), '{ not json')
    const opened = await store.openProjectDir(LEGACY_DIR)
    expect(opened).not.toBeNull()
    expect(opened?.ui.activeCueId).toBe('legacy-cue')
  })
})
