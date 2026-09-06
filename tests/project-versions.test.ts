import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-versions-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const store = await import('../src/main/project-store')

const base = (): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> => ({
  name: 'versions-test',
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

describe('project:saveVersion', () => {
  const DIR = path.join(H.root, 'VOStudio', 'versions-test.vostudio')

  it('copies project.json to versions/v1.json and records the entry', async () => {
    await store.createProject('versions-test', base())
    const versions = await store.saveVersion()

    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ n: 1 })
    expect(versions[0]).not.toHaveProperty('name')
    expect(typeof versions[0].createdAt).toBe('string')

    const copy = await readJson(path.join(DIR, 'versions', 'v1.json'))
    expect(copy['cues']).toHaveLength(1)
    expect(copy).not.toHaveProperty('versions')
    expect((await readJson(path.join(DIR, 'project.json')))['versions']).toEqual(versions)
  })

  it('the next version is the last n plus one and keeps a trimmed name', async () => {
    const versions = await store.saveVersion('  Draft to review  ')
    expect(versions.map((v) => v.n)).toEqual([1, 2])
    expect(versions[1]).toMatchObject({ n: 2, name: 'Draft to review' })

    const copy = await readJson(path.join(DIR, 'versions', 'v2.json'))
    expect((copy['versions'] as unknown[]) ?? []).toHaveLength(1)
  })

  it('a blank name is not stored', async () => {
    const versions = await store.saveVersion('   ')
    expect(versions[2]).not.toHaveProperty('name')
  })

  it('the versions survive a reopen', async () => {
    const reopened = await store.openProjectDir(DIR)
    expect(reopened.versions?.map((v) => v.n)).toEqual([1, 2, 3])
  })
})

describe('a project.json without the new fields is rewritten byte for byte', () => {
  const DIR = path.join(H.root, 'VOStudio', 'untouched.vostudio')

  it('open then persist changes nothing', async () => {
    await fs.mkdir(path.join(DIR, 'autosave'), { recursive: true })
    const { ui: _ui, ...rest } = {
      ...base(),
      id: 'legacy',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    const file = path.join(DIR, 'project.json')
    const raw = JSON.stringify(rest, null, 2)
    await fs.writeFile(file, raw)

    const opened = await store.openProjectDir(DIR)
    expect(opened).not.toHaveProperty('sources')
    expect(opened).not.toHaveProperty('versions')
    await store.persistProjectSnapshot(opened)

    expect(await fs.readFile(file, 'utf-8')).toBe(raw)
  })
})

describe('ui.json target track', () => {
  const DIR = path.join(H.root, 'VOStudio', 'versions-test.vostudio')

  it('is stored when usable and dropped when not', async () => {
    await store.openProjectDir(DIR)
    await store.saveUi({ filter: '', search: '', targetTrack: { 'cue-1': 'track-2' } })
    expect(await readJson(path.join(DIR, 'ui.json'))).toEqual({
      filter: '',
      search: '',
      targetTrack: { 'cue-1': 'track-2' },
    })

    await store.saveUi({ filter: '', search: '', targetTrack: {} })
    expect(await readJson(path.join(DIR, 'ui.json'))).toEqual({ filter: '', search: '' })
  })
})
