import type { Project } from './domain'
import { summarizeProject, type ProjectStats } from './project-summary'

export interface ProjectFile {
  json: string
  name: string
  stats: ProjectStats | null
}

export interface ProjectListing {
  name: string
  stats: ProjectStats | null
}

export interface FileStamp {
  size: number
  mtimeMs: number
}

export const AUTOSAVE_KEEP = 10

export function projectFile(project: Project): ProjectFile {
  const { ui: _ui, ...rest } = project
  return { json: JSON.stringify(rest, null, 2), name: project.name, stats: summarizeProject(project) }
}

export function autosaveName(at: Date): string {
  return `project-${at.toISOString().replace(/[:.]/g, '-')}.json`
}

export function expiredAutosaves(names: string[]): string[] {
  const sorted = [...names].sort()
  return sorted.slice(0, Math.max(0, sorted.length - AUTOSAVE_KEEP))
}

export function summaryRecord({ name, stats }: ProjectFile, stamp: FileStamp): string {
  return JSON.stringify({ name, stats, size: stamp.size, mtimeMs: stamp.mtimeMs })
}

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0

function asStats(value: unknown): ProjectStats | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const { cues, translated, voiced, approved } = value as Record<string, unknown>
  if (!isCount(cues) || !isCount(translated) || !isCount(voiced) || !isCount(approved)) return undefined
  return { cues, translated, voiced, approved }
}

export function freshSummary(raw: unknown, stamp: FileStamp): ProjectListing | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (record['size'] !== stamp.size || record['mtimeMs'] !== stamp.mtimeMs) return null
  const stats = asStats(record['stats'])
  if (typeof record['name'] !== 'string' || stats === undefined) return null
  return { name: record['name'], stats }
}
