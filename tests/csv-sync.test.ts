import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'

let project: Project

vi.mock('../src/main/project-store', () => ({
  getProject: () => project,
}))

import { syncCsv } from '../src/main/csv-sync'

let sandbox: string | undefined

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true })
  sandbox = undefined
})

describe('CSV approval sync', () => {
  it('keeps the approved flag for a valid legacy approved cue', async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'vostudio-csv-sync-'))
    const csvPath = join(sandbox, 'table.csv')
    const raw = 'WemId,UkrText,Notes\r\n1,Text,approved\r\n'
    await writeFile(csvPath, raw)
    project = {
      cues: [{
        id: 'cue-1',
        characterId: 'ada',
        key: '1',
        fields: {},
        sourceText: 'Source',
        text: 'Text',
        status: 'approved',
        notes: '',
        takes: [{
          id: 't1',
          kind: 'tts',
          createdAt: '2026-08-30T00:00:00.000Z',
          file: { fileId: 't1', relPath: 't1.mp3', format: 'mp3' },
          duration: 1,
          meta: {},
          edits: { trimStart: 0, trimEnd: 0, gainDb: 0, fadeIn: { duration: 0, shape: 'linear' }, fadeOut: { duration: 0, shape: 'linear' } },
        }],
        finalTakeId: 't1',
      }],
      csvBinding: {
        csvPath,
        mapping: { key: 'WemId', text: 'UkrText', approvedFlag: { column: 'Notes', value: 'approved' } },
      },
    } as Project

    expect(await syncCsv()).toEqual({ changedCells: 0, path: csvPath })
    expect(await readFile(csvPath, 'utf-8')).toBe(raw)
  })
})
