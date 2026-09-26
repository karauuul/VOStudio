import type { AudioRef, Project } from './domain'
import { PROJECT_SUFFIX } from './project-summary'

const isProjectFolder = (part: string): boolean =>
  part.length > PROJECT_SUFFIX.length && part.toLowerCase().endsWith(PROJECT_SUFFIX)

const unifySeparators = (p: string): string => p.replace(/[\\/]+/g, '/')

export function relocatedPath(projectDir: string, stored: string): string | null {
  const parts = stored.replace(/[\\/]+$/, '').split(/[\\/]+/)
  let at = -1
  for (let i = parts.length - 2; i >= 0 && at < 0; i--) if (isProjectFolder(parts[i])) at = i
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
