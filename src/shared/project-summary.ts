import { approvalState, hasValidVoicedOutput } from './approval'
import type { Cue } from './domain'

export interface ProjectStats {
  cues: number
  translated: number
  voiced: number
  approved: number
}

export interface ProjectSummary {
  dir: string
  name: string
  modifiedAt: number
  stats: ProjectStats | null
}

function asCue(value: unknown): Cue | null {
  if (!value || typeof value !== 'object') return null
  const cue = value as Partial<Cue>
  if (typeof cue.text !== 'string' || !Array.isArray(cue.takes)) return null
  return cue as Cue
}

export function summarizeProject(raw: unknown): ProjectStats | null {
  try {
    const cues = (raw as { cues?: unknown } | null | undefined)?.cues
    if (!Array.isArray(cues)) return null
    const stats: ProjectStats = { cues: 0, translated: 0, voiced: 0, approved: 0 }
    for (const entry of cues) {
      const cue = asCue(entry)
      if (!cue) continue
      stats.cues++
      if (cue.status === 'excluded') continue
      if (cue.text.trim()) stats.translated++
      if (hasValidVoicedOutput(cue)) stats.voiced++
      if (approvalState(cue) === 'approved') stats.approved++
    }
    return stats
  } catch {
    return null
  }
}

const FORBIDDEN = new Set(Array.from('<>:"|?*/'))

export function isValidProjectName(name: string): boolean {
  if (name.length === 0 || name.length > 80) return false
  for (const ch of name) {
    if (FORBIDDEN.has(ch) || ch === '\\' || ch.charCodeAt(0) < 32) return false
  }
  if (/[. ]$/.test(name)) return false
  return !/^\.+$/.test(name)
}

export const PROJECT_SUFFIX = '.vostudio'

export const normalizePath = (p: string): string =>
  p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

export function isProjectDirIn(root: string, dir: string): boolean {
  const d = normalizePath(dir)
  if (!d.endsWith(PROJECT_SUFFIX)) return false
  const cut = d.lastIndexOf('/')
  if (cut <= 0) return false
  return d.slice(0, cut) === normalizePath(root) && d.length - cut - 1 > PROJECT_SUFFIX.length
}
