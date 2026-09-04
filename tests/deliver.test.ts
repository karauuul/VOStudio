import { describe, expect, it } from 'vitest'
import { buildReport, buildUpdatedIndex } from '../src/shared/deliver'
import { parseCsv } from '../src/shared/csv'
import type { Cue, Project } from '../src/shared/domain'

function cue(fields: Record<string, string>, over: Partial<Cue> = {}): Cue {
  return {
    id: 'id-' + fields['cueId'],
    characterId: 'ada',
    key: fields['cueId'] ?? '',
    fields,
    sourceText: fields['sourceText'] ?? '',
    text: '',
    status: 'translated',
    notes: '',
    takes: [],
    ...over,
  } as Cue
}

const project = (cues: Cue[], name = 'Pack'): Project => ({ name, cues }) as Project

const HEADER = ['cueId', 'note', 'character', 'status', 'sourceText', 'translation', 'exportName']

function row(cueId: string, note: string): Record<string, string> {
  return {
    cueId,
    note,
    character: 'ADA',
    status: '',
    sourceText: 'Source ' + cueId,
    translation: 'stale',
    exportName: 'ADA_' + cueId,
  }
}

describe('buildUpdatedIndex', () => {
  const approved = cue(row('a1', 'first'), {
    text: 'Fresh, "quoted"',
    status: 'approved',
    takes: [
      {
        id: 't1',
        kind: 'tts',
        createdAt: '2026-01-01T00:00:00.000Z',
        file: { fileId: 't1', relPath: 'E:/p/t1.mp3', format: 'mp3' },
        duration: 1,
        meta: {},
        edits: {
          trimStart: 0,
          trimEnd: 0,
          gainDb: 0,
          fadeIn: { duration: 0, shape: 'equalPower' },
          fadeOut: { duration: 0, shape: 'equalPower' },
        },
      },
    ],
    finalTakeId: 't1',
    output: { kind: 'take', takeId: 't1', revision: 1 },
    approval: { textRevision: 0, outputRevision: 1, approvedAt: '2026-01-01T00:00:00.000Z' },
  })
  const excluded = cue(row('a2', 'second'), { text: 'Not needed', status: 'excluded' })
  const plain = cue(row('a3', 'third'), { text: 'Plain\nline' })
  const csv = buildUpdatedIndex(project([approved, excluded, plain]))

  it('keeps the original column order', () => {
    expect(csv).not.toBeNull()
    expect(parseCsv(csv!).headers).toEqual(HEADER)
  })

  it('writes translation from cue.text and the derived status', () => {
    const parsed = parseCsv(csv!)
    const at = (r: number, col: string): string => parsed.rows[r][parsed.headers.indexOf(col)]
    expect(parsed.rows).toHaveLength(3)
    expect(at(0, 'translation')).toBe('Fresh, "quoted"')
    expect(at(0, 'status')).toBe('approved')
    expect(at(1, 'translation')).toBe('Not needed')
    expect(at(1, 'status')).toBe('excluded')
    expect(at(2, 'translation')).toBe('Plain\nline')
    expect(at(2, 'status')).toBe('')
  })

  it('carries every other original cell through untouched', () => {
    const parsed = parseCsv(csv!)
    expect(parsed.rows.map((r) => r[parsed.headers.indexOf('note')])).toEqual(['first', 'second', 'third'])
    expect(parsed.rows[0][parsed.headers.indexOf('exportName')]).toBe('ADA_a1')
  })

  it('uses \\n newlines and no BOM', () => {
    expect(csv!.includes('\r')).toBe(false)
    expect(csv!.charCodeAt(0)).not.toBe(0xfeff)
    expect(csv!.split('\n')[0]).toBe(HEADER.join(','))
  })

  it('appends translation and status when the original header lacks them', () => {
    const bare = cue({ cueId: 'b1', sourceText: 'x' }, { text: 'hi', status: 'excluded' })
    const out = buildUpdatedIndex(project([bare]))
    const parsed = parseCsv(out!)
    expect(parsed.headers).toEqual(['cueId', 'sourceText', 'translation', 'status'])
    expect(parsed.rows[0]).toEqual(['b1', 'x', 'hi', 'excluded'])
  })

  it('returns null without cues or without a cueId column', () => {
    expect(buildUpdatedIndex(project([]))).toBeNull()
    expect(buildUpdatedIndex(project([cue({ WemId: '1', EventName: 'E' })]))).toBeNull()
  })
})

describe('buildReport', () => {
  it('carries the package fields and every entry list', () => {
    const report = buildReport(
      'Pack',
      'all-final',
      {
        exported: [{ cueId: 'a1', exportName: 'ADA_a1', file: 'audio/ADA_a1.mp3', bytes: 12, sha256: 'ab' }],
        failed: [{ cueId: 'a2', exportName: 'ADA_a2', file: 'audio/ADA_a2.mp3', reason: 'render failed' }],
        skipped: [{ cueId: 'a3', reason: 'collision:skip' }],
      },
      '2026-09-04T10:00:00.000Z'
    )
    expect(report).toEqual({
      formatVersion: 1,
      project: 'Pack',
      createdAt: '2026-09-04T10:00:00.000Z',
      scope: 'all-final',
      exported: [{ cueId: 'a1', exportName: 'ADA_a1', file: 'audio/ADA_a1.mp3', bytes: 12, sha256: 'ab' }],
      failed: [{ cueId: 'a2', exportName: 'ADA_a2', file: 'audio/ADA_a2.mp3', reason: 'render failed' }],
      skipped: [{ cueId: 'a3', reason: 'collision:skip' }],
    })
  })
})
