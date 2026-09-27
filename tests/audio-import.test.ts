import { execFile } from 'child_process'
import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-audio-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const { importAudio, probeDuration } = await import('../src/main/audio-import')
const ffmpegStatic = (await import('ffmpeg-static')).default as unknown as string

const run = promisify(execFile)
const SRC = path.join(H.root, 'src')
const PROJECT_DIR = path.join(H.root, 'proj.vostudio')

const tone = (name: string, seconds: number): Promise<unknown> =>
  run(ffmpegStatic, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${seconds}`,
    '-ar',
    '48000',
    '-ac',
    '1',
    path.join(SRC, name),
  ])

const project = (): Project =>
  ({
    id: 'p',
    schemaVersion: 1,
    name: 'proj',
    createdAt: '',
    media: { referenceDir: '', referencePattern: '' },
    characters: [],
    cues: [],
    sessions: [],
    pronunciationRules: '',
    exportTemplate: '',
    ui: { filter: '', search: '' },
  }) as Project

beforeAll(async () => {
  await fs.mkdir(SRC, { recursive: true })
  await fs.mkdir(PROJECT_DIR, { recursive: true })
  await tone('LINE_A.wav', 1)
  await tone('LINE_B.wav', 2)
})

afterAll(async () => {
  await fs.rm(H.root, { recursive: true, force: true })
})

describe('probeDuration', () => {
  it('reads the duration out of the container', async () => {
    expect(await probeDuration(path.join(SRC, 'LINE_B.wav'))).toBeCloseTo(2, 1)
  })

  it('returns undefined for a file ffmpeg cannot read', async () => {
    const bad = path.join(H.root, 'not-audio.wav')
    await fs.writeFile(bad, 'nonsense')
    expect(await probeDuration(bad)).toBeUndefined()
  })
})

describe('importAudio', () => {
  it('creates one line per file, copies it and probes the duration', async () => {
    const p = project()
    const { result } = await importAudio(p, PROJECT_DIR, [SRC], 'id')
    expect(result).toEqual({ added: 2, updated: 0, files: 2 })
    expect(p.cues.map((c) => c.key).sort()).toEqual(['LINE_A', 'LINE_B'])
    const a = p.cues.find((c) => c.key === 'LINE_A')!
    expect(a.fields['EventName']).toBe('LINE_A')
    expect(a.sourceText).toBe('')
    expect(a.referenceDuration).toBeCloseTo(1, 1)
    expect(a.referenceAudio?.relPath.startsWith(path.join(PROJECT_DIR, 'audio', 'reference'))).toBe(true)
    await expect(fs.stat(a.referenceAudio!.relPath)).resolves.toBeTruthy()
  })

  it('re-importing the same folder adds only new files and refreshes durations', async () => {
    const p = project()
    await importAudio(p, PROJECT_DIR, [SRC], 'id')
    const ids = p.cues.map((c) => c.id)
    for (const cue of p.cues) delete cue.referenceDuration

    await tone('LINE_C.wav', 3)
    const { result, changes } = await importAudio(p, PROJECT_DIR, [SRC], 'id')

    expect(result).toEqual({ added: 1, updated: 2, files: 3 })
    expect(p.cues.map((c) => c.key).sort()).toEqual(['LINE_A', 'LINE_B', 'LINE_C'])
    expect(p.cues.slice(0, 2).map((c) => c.id)).toEqual(ids)
    expect(p.cues.find((c) => c.key === 'LINE_B')?.referenceDuration).toBeCloseTo(2, 1)
    expect(p.cues.find((c) => c.key === 'LINE_C')?.referenceDuration).toBeCloseTo(3, 1)
    expect(changes.cues).toHaveLength(3)
  })

  it('matches existing lines by exportName when the rule says so', async () => {
    const p = project()
    p.cues.push({
      id: 'cue-1',
      characterId: '',
      key: 'other-key',
      fields: { exportName: 'LINE_A' },
      sourceText: 'kept',
      text: '',
      status: 'empty',
      notes: '',
      takes: [],
    })
    const { result } = await importAudio(p, PROJECT_DIR, [path.join(SRC, 'LINE_A.wav')], 'exportName')
    expect(result.updated).toBe(1)
    expect(result.added).toBe(0)
    expect(p.cues[0].sourceText).toBe('kept')
    expect(p.cues[0].referenceDuration).toBeCloseTo(1, 1)
  })

  it('ignores files that are not wav, mp3 or ogg', async () => {
    const p = project()
    await fs.writeFile(path.join(SRC, 'notes.txt'), 'ignore me')
    const { result } = await importAudio(p, PROJECT_DIR, [SRC], 'id')
    expect(result.files).toBe(3)
  })
})

describe('importAudio into lines that come from a table', () => {
  const line = (key: string): Project['cues'][number] => ({
    id: `cue-${key}`,
    characterId: '',
    key,
    fields: { EventName: key },
    sourceText: '',
    text: `text ${key}`,
    status: 'translated',
    notes: '',
    takes: [],
  })

  it('attaches matched files, creates no line and copies nothing for the rest', async () => {
    const dir = path.join(H.root, 'attach-src')
    const projectDir = path.join(H.root, 'attach.vostudio')
    await fs.mkdir(path.join(dir, 'stray'), { recursive: true })
    await fs.copyFile(path.join(SRC, 'LINE_A.wav'), path.join(dir, 'LINE_A.wav'))
    await fs.copyFile(path.join(SRC, 'LINE_B.wav'), path.join(dir, 'ORPHAN.wav'))
    await fs.copyFile(path.join(SRC, 'LINE_B.wav'), path.join(dir, 'stray', 'STRAY.wav'))
    const p = project()
    p.linesFromTable = true
    p.cues.push(line('LINE_A'), line('LINE_Z'))

    const { result, changes } = await importAudio(p, projectDir, [dir], 'id')

    expect(result).toEqual({ added: 0, updated: 1, unmatched: 2, files: 3 })
    expect(p.cues.map((c) => c.key)).toEqual(['LINE_A', 'LINE_Z'])
    expect(p.cues[0].referenceDuration).toBeCloseTo(1, 1)
    expect(p.cues[0].referenceAudio?.relPath).toBe(path.join(projectDir, 'audio', 'reference', 'attach-src', 'LINE_A.wav'))
    expect(p.cues[1].referenceAudio).toBeUndefined()
    expect(changes.cues?.map((c) => c.key)).toEqual(['LINE_A'])
    const copied = await fs.readdir(path.join(projectDir, 'audio', 'reference'), { recursive: true })
    expect(copied.map((f) => f.replace(/\\/g, '/')).sort()).toEqual(['attach-src', 'attach-src/LINE_A.wav'])
  })

  it('reports every file as unmatched when no line matches', async () => {
    const p = project()
    p.template = { name: 'Demo' }
    p.cues.push(line('OTHER'))
    const projectDir = path.join(H.root, 'none.vostudio')
    const { result, changes } = await importAudio(p, projectDir, [path.join(SRC, 'LINE_A.wav')], 'id')
    expect(result).toEqual({ added: 0, updated: 0, unmatched: 1, files: 1 })
    expect(p.cues.map((c) => c.key)).toEqual(['OTHER'])
    expect(changes.cues).toEqual([])
    await expect(fs.stat(path.join(projectDir, 'audio', 'reference', 'LINE_A.wav'))).rejects.toThrow()
  })
})

describe('importAudio from nested folders', () => {
  it('keeps the relative folder, leaves flat files untouched and skips later duplicate names', async () => {
    const dir = path.join(H.root, 'nested-src')
    const projectDir = path.join(H.root, 'nested.vostudio')
    await fs.mkdir(path.join(dir, 'a', 'deep'), { recursive: true })
    await fs.mkdir(path.join(dir, 'b'), { recursive: true })
    await fs.copyFile(path.join(SRC, 'LINE_A.wav'), path.join(dir, 'a', 'deep', 'hit.wav'))
    await fs.copyFile(path.join(SRC, 'LINE_B.wav'), path.join(dir, 'b', 'hit.wav'))
    await fs.copyFile(path.join(SRC, 'LINE_B.wav'), path.join(dir, 'top.wav'))
    const p = project()

    const { result, changes } = await importAudio(p, projectDir, [dir], 'id')

    expect(result).toEqual({ added: 2, updated: 0, files: 3, duplicates: ['nested-src/b/hit.wav'] })
    const hit = p.cues.find((c) => c.key === 'hit')!
    expect(hit.fields).toEqual({ EventName: 'hit', path: 'a/deep' })
    expect(hit.referenceAudio?.relPath).toBe(path.join(projectDir, 'audio', 'reference', 'nested-src', 'a', 'deep', 'hit.wav'))
    expect(hit.referenceDuration).toBeCloseTo(1, 1)
    expect(p.cues.find((c) => c.key === 'top')!.fields).toEqual({ EventName: 'top' })
    expect(changes.cues).toHaveLength(2)
    await expect(fs.stat(path.join(projectDir, 'audio', 'reference', 'nested-src', 'b', 'hit.wav'))).rejects.toThrow()
  })

  it('refreshes the stored folder when a nested source moves and is imported again', async () => {
    const dir = path.join(H.root, 'moved-src')
    const projectDir = path.join(H.root, 'moved.vostudio')
    await fs.mkdir(path.join(dir, 'a'), { recursive: true })
    await fs.copyFile(path.join(SRC, 'LINE_A.wav'), path.join(dir, 'a', 'hit.wav'))
    const p = project()
    await importAudio(p, projectDir, [dir], 'id')
    await fs.mkdir(path.join(dir, 'b'), { recursive: true })
    await fs.rename(path.join(dir, 'a', 'hit.wav'), path.join(dir, 'b', 'hit.wav'))
    const { result } = await importAudio(p, projectDir, [dir], 'id')
    expect(result).toMatchObject({ added: 0, updated: 1 })
    expect(p.cues.find((c) => c.key === 'hit')!.fields).toEqual({ EventName: 'hit', path: 'b' })
  })

  it('stores no folder for files picked one by one', async () => {
    const p = project()
    await importAudio(p, path.join(H.root, 'picked.vostudio'), [path.join(SRC, 'LINE_A.wav')], 'id')
    expect(p.cues[0].fields).toEqual({ EventName: 'LINE_A' })
  })
})
