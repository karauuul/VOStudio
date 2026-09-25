import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../src/shared/domain'
import { isInsideDir } from '../src/shared/project-summary'

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))

const { exportDir } = await import('../src/main/export')

const project = (outDir?: string): Project => ({
  id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', media: { referenceDir: '', referencePattern: '' },
  characters: [], cues: [], sessions: [], pronunciationRules: '', exportTemplate: '{EventName}.{ext}',
  ui: { filter: '', search: '' }, ...(outDir ? { export: { outDir } } : {}),
})

describe('reveal after export', () => {
  const dir = path.resolve('/work/P.vostudio')
  const custom = path.resolve('/elsewhere/deliver')

  it('accepts files in a custom export folder outside the project', () => {
    const root = exportDir(project(custom), dir)
    expect(isInsideDir(path.join(custom, 'audio', 'Line 1.wav'), root)).toBe(true)
    expect(isInsideDir(path.join(dir, 'export', 'audio', 'Line 1.wav'), root)).toBe(false)
  })

  it('accepts files in the default export folder and nothing beside it', () => {
    const root = exportDir(project(), dir)
    expect(isInsideDir(path.join(dir, 'export', 'audio', 'Line 1.wav'), root)).toBe(true)
    expect(isInsideDir(path.resolve('/elsewhere/deliver/x.wav'), root)).toBe(false)
    expect(isInsideDir(path.join(dir, 'export'), root)).toBe(false)
  })
})
