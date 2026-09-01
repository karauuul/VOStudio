import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { Cue, Project } from '../src/shared/domain'
import {
  isProjectDirIn,
  isValidProjectName,
  normalizePath,
  summarizeProject,
} from '../src/shared/project-summary'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-home-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const store = await import('../src/main/project-store')
const ROOT = path.join(H.root, 'VOStudio')

const cue = (over: Partial<Cue> = {}): Cue => ({
  id: 'c1',
  characterId: 'ada',
  key: 'K1',
  fields: {},
  sourceText: 'source',
  text: '',
  status: 'empty',
  notes: '',
  takes: [],
  ...over,
})

const take = (id: string) => ({
  id,
  kind: 'tts' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: id, relPath: `/x/${id}.mp3`, format: 'mp3' as const },
  duration: 1,
  meta: {},
  edits: {
    trimStart: 0,
    trimEnd: 0,
    gainDb: 0,
    fadeIn: { duration: 0, shape: 'equalPower' as const },
    fadeOut: { duration: 0, shape: 'equalPower' as const },
  },
})

describe('summarizeProject', () => {
  it('counts the same three numbers as the header chips', () => {
    const stats = summarizeProject({
      cues: [
        cue({ id: 'a', text: 'текст' }),
        cue({ id: 'b', text: 'текст', takes: [take('t1')], finalTakeId: 't1' }),
        cue({
          id: 'c',
          text: 'текст',
          takes: [take('t2')],
          finalTakeId: 't2',
          status: 'approved',
          textRevision: 1,
          output: { kind: 'take', takeId: 't2', revision: 1 },
          approval: { textRevision: 1, outputRevision: 1, approvedAt: '2026-01-01T00:00:00.000Z' },
        }),
        cue({ id: 'd' }),
      ],
    })
    expect(stats).toEqual({ cues: 4, translated: 3, voiced: 2, approved: 1 })
  })

  it('excluded lands in no counter but stays in the denominator', () => {
    const stats = summarizeProject({
      cues: [
        cue({ id: 'a', text: 'текст', status: 'excluded', takes: [take('t1')], finalTakeId: 't1' }),
        cue({ id: 'b', text: 'текст' }),
      ],
    })
    expect(stats).toEqual({ cues: 2, translated: 1, voiced: 0, approved: 0 })
  })

  it('a raw voice recording does not count as voiced', () => {
    const recording = { ...take('t1'), kind: 'recording' as const }
    const stats = summarizeProject({ cues: [cue({ text: 'текст', takes: [recording], finalTakeId: 't1' })] })
    expect(stats).toEqual({ cues: 1, translated: 1, voiced: 0, approved: 0 })
  })

  it('garbage instead of a project → null, not an exception', () => {
    expect(summarizeProject(null)).toBeNull()
    expect(summarizeProject('nothing')).toBeNull()
    expect(summarizeProject({})).toBeNull()
    expect(summarizeProject({ cues: 'no' })).toBeNull()
  })

  it('broken individual cues are simply skipped', () => {
    const stats = summarizeProject({ cues: [null, 42, { text: 'no takes' }, cue({ text: 'ok' })] })
    expect(stats).toEqual({ cues: 1, translated: 1, voiced: 0, approved: 0 })
  })
})

describe('isValidProjectName', () => {
  it('ordinary names pass', () => {
    expect(isValidProjectName('Satisfactory ADA')).toBe(true)
    expect(isValidProjectName('game-2026_v2')).toBe(true)
    expect(isValidProjectName('Проєкт')).toBe(true)
  })

  it('anything that could escape the root or break the folder is rejected', () => {
    for (const bad of ['', '..', '.', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(isValidProjectName(bad)).toBe(false)
    }
    expect(isValidProjectName('trailing.')).toBe(false)
    expect(isValidProjectName('trailing ')).toBe(false)
    expect(isValidProjectName('x'.repeat(81))).toBe(false)
  })
})

describe('isProjectDirIn', () => {
  const root = 'C:\\Users\\me\\Documents\\VOStudio'

  it('accepts a direct child of the root with the .vostudio suffix', () => {
    expect(isProjectDirIn(root, 'C:\\Users\\me\\Documents\\VOStudio\\game.vostudio')).toBe(true)
    expect(isProjectDirIn(root, 'c:/users/me/documents/vostudio/game.vostudio')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isProjectDirIn(root, root)).toBe(false)
    expect(isProjectDirIn(root, `${root}\\.vostudio`)).toBe(false)
    expect(isProjectDirIn(root, `${root}\\game.vostudio\\audio`)).toBe(false)
    expect(isProjectDirIn(root, `${root}\\sub\\game.vostudio`)).toBe(false)
    expect(isProjectDirIn(root, `${root}\\..\\evil.vostudio`)).toBe(false)
    expect(isProjectDirIn(root, 'C:\\Windows\\System32')).toBe(false)
    expect(isProjectDirIn(root, 'C:\\Users\\me\\Documents\\VOStudioX\\game.vostudio')).toBe(false)
  })
})

describe('normalizePath', () => {
  it('reduces slashes, trailing separator and case to a single form', () => {
    const variants = [
      'C:\\Users\\me\\Documents\\VOStudio\\game.vostudio',
      'C:/Users/me/Documents/VOStudio/game.vostudio',
      'c:\\users\\me\\documents\\vostudio\\GAME.VOSTUDIO\\',
      'C:\\Users\\me\\Documents\\VOStudio\\\\game.vostudio',
    ].map(normalizePath)
    expect(new Set(variants).size).toBe(1)
  })

  it('different folders stay different', () => {
    expect(normalizePath('C:\\a\\x.vostudio')).not.toBe(normalizePath('C:\\a\\y.vostudio'))
  })
})

const base = (name: string): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> => ({
  name,
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues: [cue({ text: 'текст' })],
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '',
  ui: { filter: '', search: '' },
})

describe('listProjects', () => {
  it('the root does not exist yet (fresh install) → an empty list, not an error', async () => {
    await expect(store.listProjects()).resolves.toEqual([])
  })

  it("returns the name from project.json, the numbers and mtime; ignores foreign folders", async () => {
    await store.createProject('alpha', base('Alpha VO'))
    await fs.mkdir(path.join(ROOT, 'not-a-project'), { recursive: true })
    await fs.writeFile(path.join(ROOT, 'loose.vostudio'), 'a file, not a folder')

    const list = await store.listProjects()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      dir: path.join(ROOT, 'alpha.vostudio'),
      name: 'Alpha VO',
      stats: { cues: 1, translated: 1, voiced: 0, approved: 0 },
    })
    expect(list[0]!.modifiedAt).toBeGreaterThan(0)
  })

  it('a broken project.json leaves the row without numbers and does not break the list', async () => {
    const broken = path.join(ROOT, 'broken.vostudio')
    await fs.mkdir(broken, { recursive: true })
    await fs.writeFile(path.join(broken, 'project.json'), '{ not json')

    const list = await store.listProjects()
    const row = list.find((p) => p.dir === broken)
    expect(row).toMatchObject({ name: 'broken', stats: null })
    expect(list.some((p) => p.stats !== null)).toBe(true)
  })

  it('order — by descending mtime', async () => {
    const list = await store.listProjects()
    const times = list.map((p) => p.modifiedAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
  })

  it('a folder with an empty name (exactly ".vostudio") is not listed', async () => {
    const ghost = path.join(ROOT, '.vostudio')
    await fs.mkdir(ghost, { recursive: true })
    const list = await store.listProjects()
    expect(list.some((p) => p.dir === ghost)).toBe(false)
    expect(list.every((p) => isProjectDirIn(ROOT, p.dir))).toBe(true)
  })
})

describe('openProjectDir', () => {
  const write = async (dir: string, json: string): Promise<string> => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'project.json'), json)
    return dir
  }

  it('rejects a project.json without the required fields', async () => {
    const dir = await write(path.join(ROOT, 'shape.vostudio'), '{"cues":[]}')
    await expect(store.openProjectDir(dir)).rejects.toThrow()
    expect(store.getProjectDir()).not.toBe(dir)
  })

  it('rejects invalid JSON', async () => {
    const dir = await write(path.join(ROOT, 'garbage.vostudio'), '{ not json')
    await expect(store.openProjectDir(dir)).rejects.toThrow()
  })

  it('accepts the real shape of project.json: csvBinding and legacy-ui at the root', async () => {
    const dir = path.join(ROOT, 'realshape.vostudio')
    await write(
      dir,
      JSON.stringify({
        ...base('Satisfactory ADA'),
        id: 'real',
        schemaVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        csvBinding: { csvPath: 'C:/x.csv', encoding: 'utf-8-sig', columnOrder: [], mapping: {} },
        ui: { activeCueId: 'c1', filter: 'work', search: '' },
      })
    )
    await expect(store.openProjectDir(dir)).resolves.toMatchObject({ name: 'Satisfactory ADA' })
    store.closeProject()
  })

  it('a valid project opens, and unknown keys SURVIVE', async () => {
    const dir = path.join(ROOT, 'passthrough.vostudio')
    const full = { ...base('Passthrough'), id: 'pt', schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    await write(dir, JSON.stringify({ ...full, someFutureField: { keep: 'me' } }, null, 2))

    const opened = await store.openProjectDir(dir)
    expect(opened.name).toBe('Passthrough')
    expect((opened as unknown as { someFutureField: unknown }).someFutureField).toEqual({ keep: 'me' })
    store.closeProject()
  })
})

describe('closeProject', () => {
  it('releases the folder, so deletion can no longer race with autosave', async () => {
    await store.createProject('closeme', base('closeme'))
    expect(store.getProjectDir()).not.toBeNull()
    store.closeProject()
    expect(store.getProjectDir()).toBeNull()
    expect(store.getProject()).toBeNull()
  })
})
