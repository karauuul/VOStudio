import type { Cue, Project } from './domain'
import { hasValidVoicedOutput, isDone, sanitizeRevision } from './approval'
import {
  exportName,
  findCollisions,
  originalLength,
  outputTakeOf,
  planBatch,
  renderLength,
} from './export-plan'
import { estimateBytes, lengthMode } from './export-settings'

export const LONGER_TOLERANCE = 0.1

export type LineStatus = 'ready' | 'longer' | 'no-audio' | 'collision' | 'excluded'

export interface LineRow {
  cueId: string
  cueKey: string
  name: string
  originalLength?: number
  outputLength?: number
  status: LineStatus
  changed: boolean
  done: boolean
  overBy?: number
  exportedVersion?: number
}

export interface ExportedLine {
  revision: number
  version?: number
}

export type ExportedLines = Record<string, ExportedLine>

export function statusWords(row: LineRow): string {
  if (row.status === 'excluded') return 'Excluded'
  if (row.status === 'no-audio') return 'No audio'
  if (row.status === 'collision') return 'Name collision'
  if (row.status === 'longer') return `Longer by ${(row.overBy ?? 0).toFixed(2)}s`
  return row.changed ? 'Ready · changed' : 'Ready'
}

export function readinessRows(project: Project, exported: ExportedLines = {}): LineRow[] {
  const planned = planBatch(project)
  const byCue = new Map(planned.map((p) => [p.cue.id, p]))
  const collided = new Set(findCollisions(planned).flatMap((c) => c.cueKeys))
  const mode = lengthMode(project.export)

  return project.cues.map((cue: Cue): LineRow => {
    const last = exported[cue.key]
    const version = last?.version
    const base = {
      cueId: cue.id,
      cueKey: cue.key,
      changed: false,
      done: isDone(cue, project),
      ...(originalLength(cue) === undefined ? {} : { originalLength: originalLength(cue) }),
      ...(version === undefined ? {} : { exportedVersion: version }),
    }
    const p = byCue.get(cue.id)
    if (!p) {
      const take = outputTakeOf(cue, project)
      const name = take ? exportName(project, cue, take) : ''
      const status: LineStatus =
        cue.status === 'excluded' ? 'excluded' : 'no-audio'
      return { ...base, name, status }
    }
    const outputLength = renderLength(cue, p.take, project)
    const original = originalLength(cue)
    const over = original === undefined ? 0 : outputLength - original
    const changed =
      last !== undefined && last.revision !== sanitizeRevision(cue.output?.revision)
    if (collided.has(cue.key)) {
      return { ...base, name: p.name, outputLength, status: 'collision', changed }
    }
    if (mode !== 'asis' && over > LONGER_TOLERANCE) {
      return { ...base, name: p.name, outputLength, status: 'longer', changed, overBy: over }
    }
    return { ...base, name: p.name, outputLength, status: 'ready', changed }
  })
}

export interface ReadinessSummary {
  total: number
  translated: number
  voiced: number
  done: number
  ready: number
  changed: number
  unchanged: number
  notReady: number
  noAudio: number
  longer: number
  collision: number
  excluded: number
  bytes: number
}

export function summarize(project: Project, rows: LineRow[]): ReadinessSummary {
  const s: ReadinessSummary = {
    total: project.cues.length,
    translated: 0,
    voiced: 0,
    done: 0,
    ready: 0,
    changed: 0,
    unchanged: 0,
    notReady: 0,
    noAudio: 0,
    longer: 0,
    collision: 0,
    excluded: 0,
    bytes: 0,
  }
  const byId = new Map(project.cues.map((c) => [c.id, c]))
  for (const row of rows) {
    const cue = byId.get(row.cueId)
    if (cue) {
      if (cue.text.trim()) s.translated++
      if (hasValidVoicedOutput(cue, project)) s.voiced++
      if (row.done) s.done++
    }
    if (row.status === 'excluded') {
      s.excluded++
      continue
    }
    if (row.status === 'ready') {
      s.ready++
      if (row.changed) s.changed++
      else s.unchanged++
      s.bytes += estimateBytes(row.outputLength ?? 0, project.export?.format)
      continue
    }
    s.notReady++
    if (row.status === 'no-audio') s.noAudio++
    else if (row.status === 'longer') s.longer++
    else s.collision++
  }
  return s
}

export type LineFilter = 'all' | 'ready' | 'changed' | 'notready'

export function matchesLineFilter(row: LineRow, filter: LineFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'ready') return row.status === 'ready'
  if (filter === 'changed') return row.status === 'ready' && row.changed
  return row.status === 'longer' || row.status === 'no-audio' || row.status === 'collision'
}
