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
