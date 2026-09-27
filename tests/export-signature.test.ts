import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'
import { exportSignature, type ExportSettings } from '../src/shared/export-settings'
import { exportedLines, mergeExported, supersededFiles, type DeliverExported } from '../src/shared/deliver'
import {
  matchesLineFilter,
  readinessRows,
  statusWords,
  summarize,
  type ExportedLines,
} from '../src/shared/readiness'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const store = await import('../src/main/project-store')
const { cancelExports, copyJob, exportInfo, finishExport, planBatchExport, removeSuperseded } = await import('../src/main/export')

const TEMPLATE = '{Key}.{ext}'

function take(id: string): Take {
  return {
    id,
    kind: 'tts',
    createdAt: 'now',
    file: { fileId: id, relPath: `/tmp/${id}.wav`, format: 'wav' },
    duration: 2,
    meta: {},
    edits: emptyEdits(),
  }
}

function cue(key: string): Cue {
  const t = take('t-' + key)
  return {
    id: 'c-' + key,
    characterId: '',
    key,
    fields: {},
    sourceText: '',
    text: 'line',
    status: 'generated',
    notes: '',
    takes: [t],
    finalTakeId: t.id,
    output: { kind: 'take', takeId: t.id, revision: 1 },
  }
}

function project(settings?: ExportSettings, keys: string[] = ['a']): Project {
  return {
    id: 'p',
    schemaVersion: 1,
    createdAt: 'now',
    name: 'P',
    media: { referenceDir: '', referencePattern: '' },
    characters: [],
    cues: keys.map(cue),
    sessions: [],
    pronunciationRules: '',
    exportTemplate: TEMPLATE,
    ui: { filter: '', search: '' },
    ...(settings ? { export: settings } : {}),
  }
}

const sig = (settings?: ExportSettings, template = TEMPLATE): string => exportSignature(settings, template)

describe('export signature', () => {
  it('is a readable canonical string of the file-affecting settings', () => {
    expect(sig(undefined)).toBe('source|off|trim|{Key}.{ext}')
    expect(sig({ format: 'wav-44-16', loudness: 'peak', peakTarget: -3, length: 'pad' })).toBe(
      'wav-44-16|peak:-3|pad|{Key}.{ext}'
    )
    expect(sig({ loudness: 'lufs' })).toBe('source|lufs:-16|trim|{Key}.{ext}')
    expect(sig({ loudness: 'match' })).toBe('source|match|trim|{Key}.{ext}')
  })

  it('absent settings and explicit defaults sign the same', () => {
    expect(sig({ format: 'source', loudness: 'off', length: 'trim' })).toBe(sig(undefined))
    expect(sig({ loudness: 'peak', peakTarget: -1 })).toBe(sig({ loudness: 'peak' }))
    expect(sig({ loudness: 'lufs', lufsTarget: -16 })).toBe(sig({ loudness: 'lufs' }))
    expect(sig({ loudness: 'peak', peakTarget: -0.34 })).toBe(sig({ loudness: 'peak', peakTarget: -0.3 }))
  })

  it('ignores settings that do not touch the line files', () => {
    const base = sig({ format: 'mp3-192' })
    expect(sig({ format: 'mp3-192', outDir: 'D:/elsewhere' })).toBe(base)
    expect(sig({ format: 'mp3-192', video: 'audio', videoName: 'x_{lang}.mp4' })).toBe(base)
    expect(sig({ format: 'mp3-192', lufsTarget: -20, peakTarget: -3 })).toBe(base)
    expect(sig({ loudness: 'peak', lufsTarget: -20 })).toBe(sig({ loudness: 'peak' }))
    expect(sig({ loudness: 'lufs', peakTarget: -3 })).toBe(sig({ loudness: 'lufs' }))
  })

  it('changes with format, loudness mode, the active target, length and the name template', () => {
    const base: ExportSettings = { format: 'wav-48-24', loudness: 'peak', peakTarget: -1, length: 'trim' }
    const variants: ExportSettings[] = [
      { ...base, format: 'wav-44-16' },
      { ...base, format: 'source' },
      { ...base, loudness: 'lufs' },
      { ...base, loudness: 'match' },
      { ...base, loudness: 'off' },
      { ...base, peakTarget: -3 },
      { ...base, length: 'pad' },
      { ...base, length: 'asis' },
    ]
    const all = [sig(base), ...variants.map((v) => sig(v)), sig(base, '{EventName}.{ext}')]
    expect(new Set(all).size).toBe(all.length)
    expect(sig({ loudness: 'lufs', lufsTarget: -20 })).not.toBe(sig({ loudness: 'lufs' }))
  })
})

describe('readiness counts a settings change as changed', () => {
  const settings: ExportSettings = { format: 'wav-48-24', loudness: 'peak' }
  const exportedWith = (s: ExportSettings | undefined, template = TEMPLATE): ExportedLines => ({
    a: { revision: 1, version: 3, signature: sig(s, template) },
  })
  const row = (p: Project, lines: ExportedLines) => readinessRows(p, lines)[0]

  it('a line exported with the current settings stays Ready', () => {
    const r = row(project(settings), exportedWith(settings))
    expect(r.changed).toBe(false)
    expect(statusWords(r)).toBe('Ready')
  })

  it('a file-affecting settings change marks the line changed everywhere changed is used', () => {
    for (const next of [
      { ...settings, format: 'wav-44-16' as const },
      { ...settings, loudness: 'lufs' as const },
      { ...settings, peakTarget: -3 },
      { ...settings, length: 'pad' as const },
    ]) {
      const p = project(next)
      const rows = readinessRows(p, exportedWith(settings))
      expect(rows[0].status).toBe('ready')
      expect(rows[0].changed).toBe(true)
      expect(statusWords(rows[0])).toBe('Ready · changed')
      expect(matchesLineFilter(rows[0], 'changed')).toBe(true)
      expect(summarize(p, rows)).toMatchObject({ ready: 1, changed: 1, unchanged: 0 })
    }
  })

  it('a new name template marks the line changed', () => {
    const p = { ...project(settings), exportTemplate: 'VO_{Key}.{ext}' }
    expect(row(p, exportedWith(settings)).changed).toBe(true)
  })

  it('folder, video and hidden targets do not mark anything changed', () => {
    const p = project({ ...settings, outDir: 'D:/out', video: 'audio', videoName: 'v.mp4', lufsTarget: -20 })
    expect(row(p, exportedWith(settings)).changed).toBe(false)
  })

  it('a moved revision is still changed with matching settings', () => {
    const p = project(settings)
    p.cues[0].output = { kind: 'take', takeId: 't-a', revision: 2 }
    expect(row(p, exportedWith(settings)).changed).toBe(true)
  })

  it('an old export record without a signature behaves exactly as before', () => {
    const old: ExportedLines = { a: { revision: 1, version: 3 } }
    const other: ExportSettings = { format: 'ogg', loudness: 'lufs', length: 'asis' }
    for (const s of [undefined, settings, other]) {
      const r = row({ ...project(s), exportTemplate: '{EventName}.{ext}' }, old)
      expect(r.changed).toBe(false)
      expect(r.exportedVersion).toBe(3)
    }
    const moved = project(settings)
    moved.cues[0].output = { kind: 'take', takeId: 't-a', revision: 2 }
    expect(row(moved, old).changed).toBe(true)
  })
})

describe('the deliver report carries the signature per line', () => {
  const entry = (over: Record<string, unknown> = {}): DeliverExported =>
    ({ cueId: 'a', exportName: 'a', file: 'audio/a.wav', bytes: 1, sha256: 'x', revision: 1, ...over }) as never

  it('reads a string signature back and drops anything else', () => {
    expect(exportedLines({ exported: [entry({ signature: 'source|off|trim|{Key}.{ext}' })] })).toStrictEqual({
      a: { revision: 1, signature: 'source|off|trim|{Key}.{ext}' },
    })
    for (const bad of [42, null, { x: 1 }, ['s']]) {
      expect(exportedLines({ exported: [entry({ signature: bad })] })).toStrictEqual({ a: { revision: 1 } })
    }
  })

  it('an old report reads without a signature key', () => {
    expect(exportedLines({ exported: [entry()] })).toStrictEqual({ a: { revision: 1 } })
  })
})

describe('export records the signature in report.json', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vostudio-signature-'))
  const dir = path.join(root, 'P.vostudio')
  afterAll(async () => {
    store.closeProject()
    await fs.rm(root, { recursive: true, force: true })
  })

  const exportLines = async (keys: string[]): Promise<void> => {
    const plan = await planBatchExport({ cueIds: keys.map((k) => 'c-' + k) })
    await finishExport(plan.token, {
      exported: plan.jobs.map((j) => ({ cueKey: j.cueKey, name: j.name, bytes: 1, sha256: 'f'.repeat(64) })),
      failed: [],
    }, async () => undefined)
  }

  const rows = async (p: Project) => {
    const info = await exportInfo()
    return Object.fromEntries(readinessRows(p, info.last?.lines ?? {}).map((r) => [r.cueKey, r]))
  }

  it('roundtrips through report.json, keeps old entries, and Export changed clears the flag', async () => {
    const p = project({ format: 'wav-48-24', loudness: 'peak' }, ['a', 'b', 'old'])
    store.adoptProject(p, dir)
    const oldEntry = {
      cueId: 'old',
      exportName: 'old',
      file: 'audio/old.wav',
      bytes: 1,
      sha256: 'e'.repeat(64),
      revision: 1,
    }
    await fs.mkdir(path.join(dir, 'export'), { recursive: true })
    await fs.writeFile(
      path.join(dir, 'export', 'report.json'),
      JSON.stringify({
        formatVersion: 1,
        project: 'P',
        createdAt: 'then',
        scope: 'selected',
        exported: [oldEntry],
        failed: [],
        skipped: [],
      })
    )

    await exportLines(['a', 'b'])
    const report = JSON.parse(await fs.readFile(path.join(dir, 'export', 'report.json'), 'utf8'))
    expect(report.exported[0]).toStrictEqual(oldEntry)
    expect(report.exported.slice(1).map((e: DeliverExported) => e.signature)).toEqual([
      sig(p.export),
      sig(p.export),
    ])

    let r = await rows(p)
    expect([r.a.changed, r.b.changed, r.old.changed]).toEqual([false, false, false])

    p.export = { ...p.export, format: 'wav-44-16' }
    r = await rows(p)
    expect([r.a.changed, r.b.changed, r.old.changed]).toEqual([true, true, false])

    await exportLines(['a'])
    r = await rows(p)
    expect([r.a.changed, r.b.changed, r.old.changed]).toEqual([false, true, false])
  })

  it('a line re-exported under a new name replaces its old file and report entry', async () => {
    const p = project({ format: 'wav-48-24' }, ['a', 'b'])
    const renamed = path.join(root, 'R.vostudio')
    store.adoptProject(p, renamed)
    await exportLines(['a', 'b'])
    const audio = path.join(renamed, 'export', 'audio')
    await fs.mkdir(audio, { recursive: true })
    for (const name of ['a.wav', 'b.wav']) await fs.writeFile(path.join(audio, name), 'old')

    p.export = { ...p.export, format: 'mp3-192' }
    await exportLines(['a'])

    const report = JSON.parse(await fs.readFile(path.join(renamed, 'export', 'report.json'), 'utf8'))
    expect(report.exported.map((e: DeliverExported) => e.file).sort()).toEqual(['audio/a.mp3', 'audio/b.wav'])
    expect((await fs.readdir(audio)).sort()).toEqual(['b.wav'])
    expect((await rows(p)).a.changed).toBe(false)
  })

  it('a plan cancelled by a project change refuses jobs and finishes without stamping a version', async () => {
    const p = project({ format: 'wav-48-24' }, ['a'])
    const cancelled = path.join(root, 'C.vostudio')
    store.adoptProject(p, cancelled)
    const plan = await planBatchExport({ cueIds: ['c-a'] })
    cancelExports()
    const stamp = vi.fn(async () => ({ version: 7, changes: 1 }))
    await expect(copyJob(plan.jobs[0].outPath)).rejects.toThrow('Export cancelled: the project changed')
    await expect(
      finishExport(plan.token, { exported: [{ cueKey: 'a', name: 'a.wav', bytes: 1, sha256: 'f'.repeat(64) }], failed: [] }, stamp)
    ).rejects.toThrow('Export cancelled: the project changed')
    expect(stamp).not.toHaveBeenCalled()
    await expect(fs.access(path.join(cancelled, 'export', 'report.json'))).rejects.toThrow()
  })

  it('a live plan stamps the version and records it in the report', async () => {
    const p = project({ format: 'wav-48-24' }, ['a'])
    const stamped = path.join(root, 'S.vostudio')
    store.adoptProject(p, stamped)
    const plan = await planBatchExport({ cueIds: ['c-a'] })
    const result = await finishExport(
      plan.token,
      { exported: [{ cueKey: 'a', name: 'a.wav', bytes: 1, sha256: 'f'.repeat(64) }], failed: [] },
      async () => ({ version: 7, changes: 1 })
    )
    expect(result.version).toBe(7)
    const report = JSON.parse(await fs.readFile(path.join(stamped, 'export', 'report.json'), 'utf8'))
    expect(report.exported[0].version).toBe(7)
  })
})

describe('superseded files', () => {
  const entry = (cueId: string, file: string): DeliverExported => ({ cueId, exportName: cueId, file, bytes: 1, sha256: 'x' })

  it('are the previous files of re-exported lines that the new export did not rewrite', () => {
    const previous = [entry('a', 'audio/a.wav'), entry('b', 'audio/b.wav'), entry('c', 'audio/C.wav')]
    const current = [entry('a', 'audio/a.mp3'), entry('c', 'audio/c.wav')]
    expect(supersededFiles(previous, current)).toEqual(['audio/a.wav'])
    expect(mergeExported(previous, current).map((e) => e.file)).toEqual(['audio/b.wav', 'audio/a.mp3', 'audio/c.wav'])
  })

  it('never point outside the audio folder', () => {
    const previous = ['../a.wav', 'audio/../../a.wav', 'audio/sub/../../a.wav', 'audio/..', 'audio\\..\\a.wav', '/etc/a.wav', 'audio/c:/a.wav'].map((file) =>
      entry('a', file)
    )
    expect(supersededFiles(previous, [entry('a', 'audio/a.mp3')])).toEqual([])
  })

  it('cleans superseded files inside nested export folders', () => {
    expect(supersededFiles([entry('a', 'audio/sfx/old.wav')], [entry('a', 'audio/voice/new.wav')])).toEqual(['audio/sfx/old.wav'])
  })
})

describe('removing superseded files', () => {
  it('deletes nested stale files but never follows a symlinked folder out of the delivery', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vostudio-superseded-'))
    const out = path.join(root, 'export')
    const outside = path.join(root, 'outside')
    await fs.mkdir(path.join(out, 'audio', 'voice'), { recursive: true })
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(out, 'audio', 'voice', 'old.wav'), 'x')
    await fs.writeFile(path.join(outside, 'old.wav'), 'keep')
    await fs.symlink(outside, path.join(out, 'audio', 'sfx'), 'dir')
    await removeSuperseded(out, ['audio/voice/old.wav', 'audio/sfx/old.wav'])
    await expect(fs.stat(path.join(out, 'audio', 'voice', 'old.wav'))).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'old.wav'), 'utf8')).toBe('keep')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('prunes folders it emptied so a later file can take their name', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vostudio-superseded-'))
    await fs.mkdir(path.join(root, 'audio', 'sfx.wav'), { recursive: true })
    await fs.writeFile(path.join(root, 'audio', 'sfx.wav', 'hit.wav'), 'x')
    await removeSuperseded(root, ['audio/sfx.wav/hit.wav'])
    await expect(fs.stat(path.join(root, 'audio', 'sfx.wav'))).rejects.toThrow()
    expect((await fs.stat(path.join(root, 'audio'))).isDirectory()).toBe(true)
    await fs.rm(root, { recursive: true, force: true })
  })
})
