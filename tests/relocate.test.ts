import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Cue, Project, Take } from '../src/shared/domain'
import { projectFile } from '../src/shared/project-file'
import { projectPaths, rebasePaths, relocatedPath } from '../src/shared/relocate'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-relocate-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const store = await import('../src/main/project-store')
const ROOT = path.join(H.root, 'VOStudio')

afterAll(async () => {
  store.closeProject()
  await fs.rm(H.root, { recursive: true, force: true })
})

const win = path.win32
const posix = path.posix

describe('relocatedPath — Windows paths', () => {
  const stored = win.join('E:\\Prj\\VO', 'Foo.vostudio', 'audio', 'takes', 'c1', 'take1.wav')

  it('maps a moved project onto the new folder on another drive', () => {
    const dir = win.join('D:\\Moved', 'Bar.vostudio')
    expect(relocatedPath(dir, stored)).toBe(win.join(dir, 'audio', 'takes', 'c1', 'take1.wav'))
  })

  it('maps a renamed project in the same parent', () => {
    const dir = win.join('E:\\Prj\\VO', 'Foo renamed.vostudio')
    expect(relocatedPath(dir, stored)).toBe('E:\\Prj\\VO\\Foo renamed.vostudio\\audio\\takes\\c1\\take1.wav')
  })

  it('reads mixed separators and any case of the suffix', () => {
    const dir = 'D:\\Moved\\Bar.vostudio'
    expect(relocatedPath(dir, 'E:/Prj\\VO/Foo.VOSTUDIO/audio\\takes/c1\\take1.wav')).toBe(
      'D:\\Moved\\Bar.vostudio\\audio\\takes\\c1\\take1.wav'
    )
    expect(relocatedPath(dir, 'E:\\Prj\\Foo.VoStudio\\audio\\reference\\vo\\a.wav')).toBe(
      'D:\\Moved\\Bar.vostudio\\audio\\reference\\vo\\a.wav'
    )
  })

  it('handles UNC shares and a trailing separator on the project folder', () => {
    expect(relocatedPath('D:\\Bar.vostudio\\', '\\\\nas\\share\\Foo.vostudio\\audio\\stems\\c1\\voice.wav')).toBe(
      'D:\\Bar.vostudio\\audio\\stems\\c1\\voice.wav'
    )
  })

  it('picks the innermost project folder', () => {
    expect(relocatedPath('D:\\Bar.vostudio', 'E:\\Old.vostudio\\VOStudio\\Foo.vostudio\\audio\\a.wav')).toBe(
      'D:\\Bar.vostudio\\audio\\a.wav'
    )
  })

  it('leaves a path already inside the project alone, ignoring case and separators', () => {
    const dir = 'E:\\Prj\\VO\\Foo.vostudio'
    expect(relocatedPath(dir, stored)).toBeNull()
    expect(relocatedPath('e:\\prj\\vo\\foo.vostudio', stored)).toBeNull()
    expect(relocatedPath(dir, 'E:/Prj/VO/Foo.vostudio/audio/takes/c1/take1.wav')).toBeNull()
  })

  it('never touches files outside a project folder', () => {
    const dir = 'D:\\Bar.vostudio'
    expect(relocatedPath(dir, 'E:\\Refs\\ada.wav')).toBeNull()
    expect(relocatedPath(dir, 'E:\\Refs\\notes.vostudio-src\\ada.wav')).toBeNull()
    expect(relocatedPath(dir, 'E:\\Refs\\.vostudio\\ada.wav')).toBeNull()
    expect(relocatedPath(dir, 'E:\\Prj\\Foo.vostudio')).toBeNull()
    expect(relocatedPath(dir, 'E:\\Prj\\Foo.vostudio\\')).toBeNull()
  })

  it('refuses a stored path that climbs out of its project folder', () => {
    expect(relocatedPath('D:\\Bar.vostudio', 'E:\\Foo.vostudio\\..\\..\\Windows\\evil.dll')).toBeNull()
    expect(relocatedPath('D:\\Bar.vostudio', 'E:\\Foo.vostudio\\audio\\.\\a.wav')).toBeNull()
  })
})

describe('relocatedPath — POSIX paths', () => {
  const stored = posix.join('/home/a/VOStudio', 'Foo.vostudio', 'audio', 'takes', 'c1', 't.wav')

  it('maps a moved project onto the new folder', () => {
    const dir = posix.join('/mnt/b', 'Bar.vostudio')
    expect(relocatedPath(dir, stored)).toBe(posix.join(dir, 'audio', 'takes', 'c1', 't.wav'))
  })

  it('leaves a path already inside the project alone', () => {
    expect(relocatedPath('/home/a/VOStudio/Foo.vostudio/', stored)).toBeNull()
  })

  it('treats a case-only rename as a move on a case-sensitive system', () => {
    expect(relocatedPath('/home/a/VOStudio/foo.vostudio', stored)).toBe('/home/a/VOStudio/foo.vostudio/audio/takes/c1/t.wav')
  })

  it('maps a Windows path onto a POSIX project folder and back', () => {
    expect(relocatedPath('/Users/x/Foo.vostudio', 'E:\\Prj\\Foo.vostudio\\audio\\takes\\c1\\t.wav')).toBe(
      '/Users/x/Foo.vostudio/audio/takes/c1/t.wav'
    )
    expect(relocatedPath('D:\\Foo.vostudio', stored)).toBe('D:\\Foo.vostudio\\audio\\takes\\c1\\t.wav')
  })

  it('never touches files outside a project folder', () => {
    expect(relocatedPath('/mnt/b/Bar.vostudio', '/srv/refs/ada.wav')).toBeNull()
    expect(relocatedPath('/mnt/b/Bar.vostudio', '/srv/Foo.vostudio/../../etc/passwd')).toBeNull()
  })
})

const edits = {
  trimStart: 0,
  trimEnd: 0,
  gainDb: 0,
  fadeIn: { duration: 0, shape: 'equalPower' as const },
  fadeOut: { duration: 0, shape: 'equalPower' as const },
}

const takeAt = (id: string, file: string, over: Partial<Take> = {}): Take => ({
  id,
  kind: 'recording',
  createdAt: '2026-01-01T00:00:00.000Z',
  file: { fileId: `c1/${id}`, relPath: file, format: 'wav' },
  duration: 1,
  meta: {},
  edits,
  ...over,
})

function projectAt(dir: string, external: string): Project {
  const inside = (...parts: string[]): string => path.join(dir, ...parts)
  const cue: Cue = {
    id: 'c1',
    characterId: '',
    key: 'K1',
    fields: {},
    sourceText: 's',
    text: 't',
    status: 'translated',
    notes: '',
    referenceAudio: { fileId: 'K1', relPath: inside('audio', 'reference', 'vo', 'k1.wav'), format: 'wav' },
    stems: [
      { id: 'c1-voice', name: 'Voice', file: { fileId: 'c1/v.wav', relPath: inside('audio', 'stems', 'c1', 'v.wav'), format: 'wav' }, exportMode: 'off' },
    ],
    takes: [
      takeAt('t1', inside('audio', 'takes', 'c1', 't1.wav')),
      takeAt('t2', inside('audio', 'takes', 'c1', 't2.wav'), { deletedAt: '2026-01-02T00:00:00.000Z' }),
      takeAt('gen', path.join(external, 'generated', 'K1.mp3')),
    ],
  }
  return {
    id: 'p',
    schemaVersion: 1,
    name: 'Moved',
    createdAt: '2026-01-01T00:00:00.000Z',
    media: { referenceDir: inside('audio', 'reference'), referencePattern: '' },
    characters: [],
    cues: [cue],
    sessions: [
      {
        id: 's',
        name: 's',
        sampleRate: 48000,
        markers: [],
        tracks: [
          {
            id: 'tr',
            name: 'Guide',
            kind: 'guide',
            gainDb: 0,
            muted: false,
            solo: false,
            clips: [
              { id: 'a', source: { takeId: 't1' }, start: 0, edits },
              { id: 'b', source: { fileRef: { fileId: 'g', relPath: inside('audio', 'guide.wav'), format: 'wav' } }, start: 0, edits },
            ],
          },
        ],
      },
    ],
    sources: [
      {
        id: 'src',
        name: 'movie.mp4',
        kind: 'video',
        file: { fileId: 'src', relPath: inside('audio', 'sources', 'src.wav'), format: 'wav' },
        duration: 10,
        media: path.join(external, 'movie.mp4'),
      },
    ],
    csvBinding: { csvPath: path.join(external, 'lines.csv'), encoding: 'utf-8-sig', columnOrder: [], mapping: { key: 'id' } },
    export: { outDir: inside('export', 'final') },
    pronunciationRules: '',
    exportTemplate: '{EventName}.{ext}',
    ui: { filter: '', search: '' },
  }
}

describe('project path fields', () => {
  it('enumerates every stored path, live and deleted takes included', () => {
    const project = projectAt('/old/Foo.vostudio', '/ext')
    expect(projectPaths(project)).toEqual([
      '/old/Foo.vostudio/audio/takes/c1/t1.wav',
      '/old/Foo.vostudio/audio/takes/c1/t2.wav',
      '/ext/generated/K1.mp3',
      '/old/Foo.vostudio/audio/reference/vo/k1.wav',
      '/old/Foo.vostudio/audio/stems/c1/v.wav',
      '/old/Foo.vostudio/audio/sources/src.wav',
      '/ext/movie.mp4',
      '/old/Foo.vostudio/audio/guide.wav',
      '/old/Foo.vostudio/audio/reference',
      '/ext/lines.csv',
      '/old/Foo.vostudio/export/final',
    ])
  })

  it('rewrites only the mapped paths and keeps the file shape', () => {
    const project = projectAt('/old/Foo.vostudio', '/ext')
    const moved = new Map(
      projectPaths(project).flatMap((p) => {
        const next = relocatedPath('/new/Bar.vostudio', p)
        return next ? [[p, next] as const] : []
      })
    )
    expect(rebasePaths(project, moved)).toBe(true)
    expect(project).toEqual(projectAt('/new/Bar.vostudio', '/ext'))
  })

  it('leaves the serialized project byte-identical when nothing moved', () => {
    const project = projectAt('/old/Foo.vostudio', '/ext')
    const before = projectFile(project).json
    expect(rebasePaths(project, new Map())).toBe(false)
    expect(projectFile(project).json).toBe(before)
  })
})

async function touch(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, 'x')
}

async function writeProject(dir: string, project: Project): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const { ui: _ui, ...rest } = project
  const json = JSON.stringify(rest, null, 2)
  await fs.writeFile(path.join(dir, 'project.json'), json)
  return json
}

describe('relocateMovedFiles', () => {
  it('rebases every file of a renamed project folder onto the new folder', async () => {
    const oldDir = path.join(ROOT, 'Old.vostudio')
    const newDir = path.join(ROOT, 'New.vostudio')
    const external = path.join(H.root, 'external')
    const project = projectAt(oldDir, external)
    for (const parts of [
      ['takes', 'c1', 't1.wav'],
      ['reference', 'vo', 'k1.wav'],
      ['stems', 'c1', 'v.wav'],
      ['sources', 'src.wav'],
      ['guide.wav'],
    ]) {
      await touch(path.join(oldDir, 'audio', ...parts))
    }
    await fs.mkdir(path.join(oldDir, 'export', 'final'), { recursive: true })
    await writeProject(oldDir, project)
    await fs.rename(oldDir, newDir)

    const opened = await store.openProjectDir(newDir)
    expect(await store.relocateMovedFiles(opened, newDir)).toBe(true)

    const expected = projectAt(newDir, external)
    expected.cues[0].takes[1].file.relPath = path.join(oldDir, 'audio', 'takes', 'c1', 't2.wav')
    const { ui: _a, ...got } = opened
    const { ui: _b, ...want } = expected
    expect(got).toEqual(want)
    await expect(fs.stat(opened.cues[0].takes[0].file.relPath)).resolves.toBeTruthy()
    store.closeProject()
  })

  it('prefers the copy inside the project over the original it was copied from', async () => {
    const original = path.join(ROOT, 'Original.vostudio')
    const copy = path.join(ROOT, 'Copy.vostudio')
    const project = projectAt(original, path.join(H.root, 'external'))
    await touch(project.cues[0].takes[0].file.relPath)
    await writeProject(original, project)
    await fs.cp(original, copy, { recursive: true })

    const opened = await store.openProjectDir(copy)
    expect(await store.relocateMovedFiles(opened, copy)).toBe(true)
    expect(opened.cues[0].takes[0].file.relPath).toBe(path.join(copy, 'audio', 'takes', 'c1', 't1.wav'))
    store.closeProject()
  })

  it('leaves a project whose files resolve byte-identical on disk', async () => {
    const dir = path.join(ROOT, 'Stays.vostudio')
    const project = projectAt(dir, path.join(H.root, 'external'))
    for (const take of project.cues[0].takes) await touch(take.file.relPath)
    const json = await writeProject(dir, project)

    const opened = await store.openProjectDir(dir)
    expect(await store.relocateMovedFiles(opened, dir)).toBe(false)
    expect(await fs.readFile(path.join(dir, 'project.json'), 'utf-8')).toBe(json)
    store.closeProject()
  })
})
