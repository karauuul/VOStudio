import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { emptyEdits, type Cue, type Project, type ProjectVersion } from '../src/shared/domain'
import { restoreBlock } from '../src/shared/versions'

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

async function saveVersion(name?: string): Promise<ProjectVersion[]> {
  const project = store.getProject()!
  project.versions = await store.saveVersion(project.versions ?? [], name)
  await store.persistProjectSnapshot(project)
  return project.versions
}

const readJson = async (file: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>

describe('project:saveVersion', () => {
  const DIR = path.join(H.root, 'VOStudio', 'versions-test.vostudio')

  it('copies project.json to versions/v1.json and records the entry', async () => {
    await store.createProject('versions-test', base())
    const versions = await saveVersion()

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
    const versions = await saveVersion('  Draft to review  ')
    expect(versions.map((v) => v.n)).toEqual([1, 2])
    expect(versions[1]).toMatchObject({ n: 2, name: 'Draft to review' })

    const copy = await readJson(path.join(DIR, 'versions', 'v2.json'))
    expect((copy['versions'] as unknown[]) ?? []).toHaveLength(1)
  })

  it('a blank name is not stored', async () => {
    const versions = await saveVersion('   ')
    expect(versions[2]).not.toHaveProperty('name')
  })

  it('the versions survive a reopen', async () => {
    const reopened = await store.openProjectDir(DIR)
    expect(reopened.versions?.map((v) => v.n)).toEqual([1, 2, 3])
  })

  it('ensureVersion keeps the list while project.json matches the last version', async () => {
    const project = store.getProject()!
    const previous = project.versions!
    expect(await store.ensureVersion(previous)).toBe(previous)
    project.name = 'renamed'
    await store.persistProjectSnapshot(project)
    expect((await store.ensureVersion(previous)).map((v) => v.n)).toEqual([1, 2, 3, 4])
    expect(project.versions).toBe(previous)
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

describe('ui.json timeline view', () => {
  const DIR = path.join(H.root, 'VOStudio', 'versions-test.vostudio')

  it('survives a save and comes back clamped, and an empty map leaves no key', async () => {
    await store.openProjectDir(DIR)
    await store.saveUi({
      filter: '',
      search: '',
      timeline: { 'cue-1': { pxPerSec: 9e9, scroll: 1.5, originalGainDb: -3 } },
    })
    expect(await readJson(path.join(DIR, 'ui.json'))).toEqual({
      filter: '',
      search: '',
      timeline: { 'cue-1': { pxPerSec: 2000, scroll: 1.5, originalGainDb: -3 } },
    })

    await store.saveUi({ filter: '', search: '', timeline: {} })
    expect(await readJson(path.join(DIR, 'ui.json'))).toEqual({ filter: '', search: '' })
  })
})

describe('restoring a version', () => {
  const DIR = path.join(H.root, 'VOStudio', 'restore-test.vostudio')
  const autosaves = async (): Promise<number> => (await fs.readdir(path.join(DIR, 'autosave'))).length
  const line = (id: string, text: string): Cue => ({ ...base().cues[0], id, key: id, text })

  it('saves the current state as Before vN, then loads vN with one write and keeps id and versions', async () => {
    await store.createProject('restore-test', base())
    const project = store.getProject()!
    project.cues = [line('cue-1', 'first'), line('cue-2', 'second')]
    await store.persistProjectSnapshot(project)
    project.versions = await store.saveVersion([])
    project.cues = [line('cue-1', 'edited'), line('cue-2', 'second'), line('cue-3', 'third')]
    await store.persistProjectSnapshot(project)
    const writes = await autosaves()

    const restored = await store.restoreVersion(project, await store.readVersion(1), 1)

    expect(await autosaves()).toBe(writes + 1)
    expect(store.getProject()).toBe(restored)
    expect(restored.id).toBe(project.id)
    expect(restored.versions?.map((v) => [v.n, v.name])).toEqual([
      [1, undefined],
      [2, 'Before v1'],
    ])
    const saved = await readJson(path.join(DIR, 'project.json'))
    expect((saved['cues'] as Cue[]).map((c) => c.text)).toEqual(['first', 'second'])
    expect(saved['id']).toBe(project.id)
    expect(saved['versions']).toEqual(restored.versions)
    const before = await readJson(path.join(DIR, 'versions', 'v2.json'))
    expect((before['cues'] as Cue[]).map((c) => c.text)).toEqual(['edited', 'second', 'third'])
  })

  it('restoring Before vN brings the edited state back', async () => {
    const project = store.getProject()!
    const restored = await store.restoreVersion(project, await store.readVersion(2), 2)
    expect(restored.cues.map((c) => c.text)).toEqual(['edited', 'second', 'third'])
    expect(restored.versions?.map((v) => [v.n, v.name])).toEqual([
      [1, undefined],
      [2, 'Before v1'],
      [3, 'Before v2'],
    ])
  })

  it('a version file is sanitized like project.json, and its own id and versions are ignored', async () => {
    const project = store.getProject()!
    const file = path.join(DIR, 'versions', 'v1.json')
    const raw = await readJson(file)
    await fs.writeFile(
      file,
      JSON.stringify({
        ...raw,
        id: 'someone-else',
        versions: [{ n: 9, createdAt: '2020-01-01T00:00:00.000Z' }],
        terms: [{ term: '  ', translation: 'x' }, 7],
        languages: { source: ' ', target: 'uk' },
      })
    )

    const version = await store.readVersion(1)
    expect(version).not.toHaveProperty('terms')
    expect(version).not.toHaveProperty('languages')

    const restored = await store.restoreVersion(project, version, 1)
    expect(restored.id).toBe(project.id)
    expect(restored.versions?.map((v) => v.n)).toEqual([1, 2, 3, 4])
    const saved = await readJson(path.join(DIR, 'project.json'))
    expect(saved['id']).toBe(project.id)
    expect(saved).not.toHaveProperty('terms')
  })

  it('a version saved before the project folder moved gets its paths rebased', async () => {
    const take = path.join(DIR, 'audio', 'takes', 'cue-1', 't1.wav')
    await fs.mkdir(path.dirname(take), { recursive: true })
    await fs.writeFile(take, '')
    const moved = path.join(H.root, 'Elsewhere', 'Old.vostudio', 'audio', 'takes', 'cue-1', 't1.wav')
    const raw = await readJson(path.join(DIR, 'versions', 'v1.json'))
    const cues = raw['cues'] as Cue[]
    cues[0].takes = [
      {
        id: 't1',
        kind: 'recording',
        createdAt: '2026-01-01T00:00:00.000Z',
        file: { fileId: 'cue-1/t1.wav', relPath: moved, format: 'wav' },
        duration: 1,
        meta: {},
        edits: emptyEdits(),
      },
    ]
    await fs.writeFile(path.join(DIR, 'versions', 'v1.json'), JSON.stringify({ ...raw, cues }))

    const version = await store.readVersion(1)
    expect(await store.relocateMovedFiles(version, DIR)).toBe(true)
    expect(version.cues[0].takes[0].file.relPath).toBe(take)
  })
})

describe('restore refusal', () => {
  const idle = { exporting: false, recording: false, busy: false }

  it('allows a restore only when nothing is running', () => {
    expect(restoreBlock(idle)).toBeNull()
    expect(restoreBlock({ ...idle, exporting: true })).toBe('Export in progress')
    expect(restoreBlock({ ...idle, recording: true })).toBe('Stop the recording first')
    expect(restoreBlock({ ...idle, busy: true })).toBe('Generation is still running')
    expect(restoreBlock({ exporting: true, recording: true, busy: true })).toBe('Export in progress')
  })
})
