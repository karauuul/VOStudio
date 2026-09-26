import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'
import { autosaveName, freshSummary } from '../src/shared/project-file'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-persist-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const store = await import('../src/main/project-store')
const ROOT = path.join(H.root, 'VOStudio')

const base = (name: string): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> => ({
  name,
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues: [
    { id: 'a', characterId: 'x', key: 'A', fields: {}, sourceText: 's', text: 'текст', status: 'empty', notes: '', takes: [] },
    { id: 'b', characterId: 'x', key: 'B', fields: {}, sourceText: 's', text: '', status: 'empty', notes: '', takes: [] },
  ],
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '',
  ui: { filter: '', search: '' },
})

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

async function save(text: string): Promise<void> {
  await tick()
  const p = store.getProject()!
  p.cues[1].text = text
  await store.persistProjectSnapshot(p)
}

const projectJson = (dir: string): string => path.join(dir, 'project.json')
const autosaves = async (dir: string): Promise<string[]> => (await fs.readdir(path.join(dir, 'autosave'))).sort()
const readBackup = (dir: string, name: string): Promise<string> => fs.readFile(path.join(dir, 'autosave', name), 'utf-8')

afterEach(() => {
  vi.restoreAllMocks()
  store.closeProject()
})

describe('autosave backups', () => {
  it('keep the previous project.json byte for byte and are never touched by later saves', async () => {
    await store.createProject('backups', base('Backups'))
    const dir = path.join(ROOT, 'backups.vostudio')
    const first = await fs.readFile(projectJson(dir), 'utf-8')
    const firstInode = (await fs.stat(projectJson(dir))).ino

    await save('one')
    const [backup] = await autosaves(dir)
    expect(await autosaves(dir)).toHaveLength(1)
    expect(await readBackup(dir, backup)).toBe(first)
    expect((await fs.stat(path.join(dir, 'autosave', backup))).ino).toBe(firstInode)
    expect((await fs.stat(projectJson(dir))).ino).not.toBe(firstInode)

    const second = await fs.readFile(projectJson(dir), 'utf-8')
    await save('two')
    await save('three')
    const names = await autosaves(dir)
    expect(names).toHaveLength(3)
    expect(await readBackup(dir, names[0])).toBe(first)
    expect(await readBackup(dir, names[1])).toBe(second)
    expect(JSON.parse(await readBackup(dir, names[2])).cues[1].text).toBe('two')
    expect(JSON.parse(await fs.readFile(projectJson(dir), 'utf-8')).cues[1].text).toBe('three')
  })

  it('rotate to the ten newest', async () => {
    await store.createProject('rotation', base('Rotation'))
    const dir = path.join(ROOT, 'rotation.vostudio')
    const old = Array.from({ length: 12 }, (_, i) => autosaveName(new Date(Date.UTC(2020, 0, 1, 0, 0, i))))
    for (const name of old) await fs.writeFile(path.join(dir, 'autosave', name), 'old')
    const previous = await fs.readFile(projectJson(dir), 'utf-8')

    await save('one')

    const names = await autosaves(dir)
    expect(names).toHaveLength(10)
    expect(names.slice(0, 9)).toEqual(old.slice(3))
    expect(await readBackup(dir, names[9])).toBe(previous)
  })

  it('fall back to a copy where the file system refuses a hard link', async () => {
    await store.createProject('nolink', base('No link'))
    const dir = path.join(ROOT, 'nolink.vostudio')
    const previous = await fs.readFile(projectJson(dir), 'utf-8')
    const link = vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('not supported'), { code: 'EPERM' }))

    await save('one')
    await save('two')

    expect(link).toHaveBeenCalledTimes(2)
    const names = await autosaves(dir)
    expect(names).toHaveLength(2)
    expect(await readBackup(dir, names[0])).toBe(previous)
    expect(JSON.parse(await readBackup(dir, names[1])).cues[1].text).toBe('one')
  })

  it('stay untouched when the new project.json cannot be written', async () => {
    await store.createProject('diskfull', base('Disk full'))
    const dir = path.join(ROOT, 'diskfull.vostudio')
    await save('one')
    const before = await fs.readFile(projectJson(dir), 'utf-8')
    const names = await autosaves(dir)
    const backups = await Promise.all(names.map((name) => readBackup(dir, name)))
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('no space left'), { code: 'ENOSPC' }))

    await expect(save('lost')).rejects.toThrow('no space left')

    expect(await fs.readFile(projectJson(dir), 'utf-8')).toBe(before)
    expect(await autosaves(dir)).toEqual(names)
    expect(await Promise.all(names.map((name) => readBackup(dir, name)))).toEqual(backups)
    await save('two')
    expect(await autosaves(dir)).toHaveLength(names.length + 1)
  })

  it('stay absent for a project without an autosave folder, and the save still lands', async () => {
    const dir = path.join(ROOT, 'bare.vostudio')
    await fs.mkdir(dir, { recursive: true })
    const { ui: _ui, ...rest } = { ...base('Bare'), id: 'bare', schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    await fs.writeFile(projectJson(dir), JSON.stringify(rest, null, 2))
    await store.openProjectDir(dir)

    await save('one')

    expect(JSON.parse(await fs.readFile(projectJson(dir), 'utf-8')).cues[1].text).toBe('one')
    await expect(fs.stat(path.join(dir, 'autosave'))).rejects.toThrow()
  })
})

describe('summary sidecar', () => {
  const rowOf = async (dir: string) => (await store.listProjects()).find((row) => row.dir === dir)!

  it('is written with every project.json and describes exactly that file', async () => {
    await store.createProject('sidecar', base('Sidecar'))
    const dir = path.join(ROOT, 'sidecar.vostudio')
    const read = async () => freshSummary(JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf-8')), await fs.stat(projectJson(dir)))

    expect(await read()).toEqual({ name: 'Sidecar', stats: { cues: 2, translated: 1, voiced: 0, approved: 0 } })
    await save('now translated')
    expect(await read()).toEqual({ name: 'Sidecar', stats: { cues: 2, translated: 2, voiced: 0, approved: 0 } })
    expect(JSON.parse(await fs.readFile(projectJson(dir), 'utf-8'))).not.toHaveProperty('stats')
  })

  it('lets Home skip reading project.json while it is fresh', async () => {
    const dir = path.join(ROOT, 'sidecar.vostudio')
    const readFile = vi.spyOn(fs, 'readFile')

    const row = await rowOf(dir)

    expect(row).toMatchObject({ name: 'Sidecar', stats: { cues: 2, translated: 2, voiced: 0, approved: 0 } })
    expect(readFile.mock.calls.map(([file]) => String(file))).not.toContain(projectJson(dir))
  })

  it('is trusted only for the exact project.json it was written for', async () => {
    const dir = path.join(ROOT, 'sidecar.vostudio')
    const stamp = await fs.stat(projectJson(dir))
    const cached = { name: 'Cached', stats: { cues: 9, translated: 9, voiced: 9, approved: 9 } }
    await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ ...cached, size: stamp.size, mtimeMs: stamp.mtimeMs }))
    expect(await rowOf(dir)).toMatchObject(cached)

    await fs.utimes(projectJson(dir), stamp.atime, new Date(stamp.mtimeMs + 5000))
    expect(await rowOf(dir)).toMatchObject({ name: 'Sidecar', stats: { cues: 2, translated: 2, voiced: 0, approved: 0 } })
  })

  it('broken or missing falls back to project.json exactly like before', async () => {
    const dir = path.join(ROOT, 'sidecar.vostudio')
    const expected = { name: 'Sidecar', stats: { cues: 2, translated: 2, voiced: 0, approved: 0 } }
    await fs.writeFile(path.join(dir, 'summary.json'), '{ not json')
    expect(await rowOf(dir)).toMatchObject(expected)
    await fs.rm(path.join(dir, 'summary.json'))
    expect(await rowOf(dir)).toMatchObject(expected)
  })

  it('is not required for a project.json that never had one', async () => {
    const dir = path.join(ROOT, 'legacy.vostudio')
    await fs.mkdir(dir, { recursive: true })
    const { ui: _ui, ...rest } = { ...base('  '), id: 'legacy', schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z' }
    await fs.writeFile(projectJson(dir), JSON.stringify(rest, null, 2))
    expect(await rowOf(dir)).toMatchObject({ name: 'legacy', stats: { cues: 2, translated: 1, voiced: 0, approved: 0 } })
  })
})
