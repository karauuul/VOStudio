import type { AudioRef, Project } from './domain'
import { PROJECT_SUFFIX } from './project-summary'

const isProjectFolder = (part: string): boolean =>
  part.length > PROJECT_SUFFIX.length && part.toLowerCase().endsWith(PROJECT_SUFFIX)

const unifySeparators = (p: string): string => p.replace(/[\\/]+/g, '/')

function projectFolderAt(parts: string[]): number {
  for (let i = parts.length - 2; i >= 0; i--) if (isProjectFolder(parts[i])) return i
  return -1
}

const splitPath = (stored: string): string[] => stored.replace(/[\\/]+$/, '').split(/[\\/]+/)

const windowsPath = (p: string): boolean => /^[a-z]:/i.test(p) || p.includes('\\')

export function projectRootOf(stored: string): string | null {
  const parts = splitPath(stored)
  const at = projectFolderAt(parts)
  if (at < 0) return null
  const root = parts.slice(0, at + 1).join('/')
  return windowsPath(stored) ? root.toLowerCase() : root
}

function commonestRoot(paths: string[]): string | null {
  const counts = new Map<string, number>()
  for (const stored of paths) {
    const root = projectRootOf(stored)
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1)
  }
  let best: string | null = null
  for (const [root, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = root
  return best
}

export function previousProjectRoot(project: Project): string | null {
  const takes = project.cues.flatMap((cue) => cue.takes.map((take) => take.file.relPath))
  return commonestRoot(takes) ?? commonestRoot(projectPaths(project))
}

export function relocatedPath(projectDir: string, stored: string): string | null {
  const parts = splitPath(stored)
  const at = projectFolderAt(parts)
  if (at < 0) return null
  const tail = parts.slice(at + 1)
  if (tail.some((part) => part === '' || part === '.' || part === '..')) return null
  const windows = projectDir.includes('\\') || /^[a-z]:/i.test(projectDir)
  const moved = [projectDir.replace(/[\\/]+$/, ''), ...tail].join(windows ? '\\' : '/')
  const fold = (p: string): string => (windows ? unifySeparators(p).toLowerCase() : unifySeparators(p))
  return fold(moved) === fold(stored) ? null : moved
}

function mapPaths(project: Project, map: (stored: string) => string): void {
  const ref = (file: AudioRef): void => {
    file.relPath = map(file.relPath)
  }
  for (const cue of project.cues) {
    for (const take of cue.takes) ref(take.file)
    if (cue.referenceAudio) ref(cue.referenceAudio)
    for (const stem of cue.stems ?? []) ref(stem.file)
  }
  for (const source of project.sources ?? []) {
    ref(source.file)
    if (source.media !== undefined) source.media = map(source.media)
  }
  for (const session of project.sessions) {
    for (const track of session.tracks ?? []) {
      for (const clip of track.clips ?? []) if (clip.source && 'fileRef' in clip.source) ref(clip.source.fileRef)
    }
  }
  if (project.media.referenceDir) project.media.referenceDir = map(project.media.referenceDir)
  if (project.csvBinding) project.csvBinding.csvPath = map(project.csvBinding.csvPath)
  if (project.export?.outDir) project.export.outDir = map(project.export.outDir)
}

export function projectPaths(project: Project): string[] {
  const out: string[] = []
  mapPaths(project, (stored) => {
    out.push(stored)
    return stored
  })
  return out
}

export function rebasePaths(project: Project, moved: ReadonlyMap<string, string>): boolean {
  let changed = false
  mapPaths(project, (stored) => {
    const next = moved.get(stored)
    if (next === undefined) return stored
    changed = true
    return next
  })
  return changed
}
