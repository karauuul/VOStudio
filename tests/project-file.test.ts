import { describe, expect, it } from 'vitest'
import type { Project } from '../src/shared/domain'
import {
  AUTOSAVE_KEEP,
  autosaveName,
  expiredAutosaves,
  freshSummary,
  projectFile,
  summaryRecord,
} from '../src/shared/project-file'
import { parseSnapshot, serializeSnapshot } from '../src/shared/project-commands'
import { summarizeProject } from '../src/shared/project-summary'

const project = (): Project => ({
  id: 'p',
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  name: 'Workshop',
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues: [
    { id: 'a', characterId: 'x', key: 'A', fields: {}, sourceText: 's', text: 'текст', status: 'empty', notes: '', takes: [] },
    { id: 'b', characterId: 'x', key: 'B', fields: {}, sourceText: 's', text: '', status: 'excluded', notes: '', takes: [] },
  ],
  sessions: [],
  pronunciationRules: '',
  exportTemplate: '',
  ui: { activeCueId: 'a', filter: 'all', search: 'q' },
})

describe('projectFile', () => {
  it('is the exact project.json text the store always wrote: no ui, two-space indent', () => {
    const p = project()
    const { ui: _ui, ...rest } = p
    const file = projectFile(p)
    expect(file.json).toBe(JSON.stringify(rest, null, 2))
    expect(JSON.parse(file.json)).not.toHaveProperty('ui')
  })

  it('carries the Home name and counts of the same instant', () => {
    const p = project()
    expect(projectFile(p)).toMatchObject({ name: 'Workshop', stats: summarizeProject(p) })
    expect(projectFile(p).stats).toEqual({ cues: 2, translated: 1, voiced: 0, approved: 0 })
  })

  it('is a detached capture: later edits do not reach it', () => {
    const p = project()
    const file = projectFile(p)
    p.cues[0].text = 'later'
    p.name = 'later'
    expect(JSON.parse(file.json).cues[0].text).toBe('текст')
    expect(file.name).toBe('Workshop')
  })
})

describe('autosave rotation', () => {
  it('names a backup exactly like before', () => {
    expect(autosaveName(new Date('2026-09-26T11:02:02.525Z'))).toBe('project-2026-09-26T11-02-02-525Z.json')
  })

  it('keeps the newest ten and expires the oldest by name order', () => {
    const names = Array.from({ length: AUTOSAVE_KEEP + 3 }, (_, i) => autosaveName(new Date(Date.UTC(2026, 0, 1, 0, 0, i))))
    const shuffled = [...names.slice(5), ...names.slice(0, 5)].reverse()
    expect(AUTOSAVE_KEEP).toBe(10)
    expect(expiredAutosaves(shuffled)).toEqual(names.slice(0, 3))
    expect(expiredAutosaves(names.slice(0, AUTOSAVE_KEEP))).toEqual([])
    expect(expiredAutosaves([])).toEqual([])
  })
})

describe('summary sidecar', () => {
  const stamp = { size: 1234, mtimeMs: 1727349034123.4567 }

  it('round-trips while project.json is the file it was written for', () => {
    const file = projectFile(project())
    expect(freshSummary(JSON.parse(summaryRecord(file, stamp)), stamp)).toEqual({ name: file.name, stats: file.stats })
  })

  it('is stale as soon as project.json has another size or mtime', () => {
    const raw = JSON.parse(summaryRecord(projectFile(project()), stamp))
    expect(freshSummary(raw, { ...stamp, size: 1235 })).toBeNull()
    expect(freshSummary(raw, { ...stamp, mtimeMs: stamp.mtimeMs + 1 })).toBeNull()
  })

  it('keeps a project without countable cues as null stats', () => {
    const raw = { name: 'x', stats: null, ...stamp }
    expect(freshSummary(raw, stamp)).toEqual({ name: 'x', stats: null })
  })

  it('rejects anything malformed', () => {
    const stats = { cues: 1, translated: 1, voiced: 0, approved: 0 }
    for (const raw of [
      null,
      'text',
      [],
      { stats, ...stamp },
      { name: 7, stats, ...stamp },
      { name: 'x', ...stamp },
      { name: 'x', stats: { ...stats, voiced: -1 }, ...stamp },
      { name: 'x', stats: { ...stats, cues: 1.5 }, ...stamp },
      { name: 'x', stats: { ...stats, approved: '0' }, ...stamp },
      { name: 'x', stats, size: '1234', mtimeMs: stamp.mtimeMs },
      { name: 'x', stats, size: stamp.size },
    ]) {
      expect(freshSummary(raw, stamp)).toBeNull()
    }
  })
})

describe('serialized snapshot', () => {
  it('reaches the renderer as the same project, ui included', () => {
    const p = project()
    const wire = serializeSnapshot(4, p)
    expect(typeof wire.json).toBe('string')
    expect(parseSnapshot(wire)).toEqual({ revision: 4, project: p })
  })
})
