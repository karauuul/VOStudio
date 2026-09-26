import { mkdtempSync, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { emptyEdits, type Cue, type Project, type Take } from '../src/shared/domain'
import { exportSignature, type ExportSettings } from '../src/shared/export-settings'
import { exportedLines, type DeliverExported } from '../src/shared/deliver'
import {
  matchesLineFilter,
  readinessRows,
  statusWords,
  summarize,
  type ExportedLines,
} from '../src/shared/readiness'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const store = await import('../src/main/project-store')
const { exportInfo, finishExport, planBatchExport } = await import('../src/main/export')

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
    })
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
})
