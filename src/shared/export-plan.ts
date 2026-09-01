import { isEmptyComp } from './comp'
import type { ClipEdits, Cue, CueComp, Project, Take } from './domain'
import { hasEffects } from './effects'
import { approvalState, hasValidVoicedOutput } from './approval'

export type ExportFormat = 'mp3' | 'wav' | 'ogg'

export interface PlannedTake {
  cue: Cue
  take: Take
  name: string
}

export interface NameCollision {
  name: string
  cueKeys: string[]
}

export type CollisionStrategy = 'suffix-wemid' | 'skip' | 'reuse'

export function hasEdits(e: ClipEdits): boolean {
  return (
    e.trimStart !== 0 ||
    e.trimEnd !== 0 ||
    e.gainDb !== 0 ||
    e.fadeIn.duration !== 0 ||
    e.fadeOut.duration !== 0 ||
    (e.timeStretch !== undefined && e.timeStretch !== 1) ||
    (e.gainEnvelope?.length ?? 0) > 0 ||
    hasEffects(e.effects)
  )
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0) return ''
  return name.slice(i).toLowerCase()
}

const CONTAINERS: Record<string, ExportFormat> = {
  '.mp3': 'mp3',
  '.wav': 'wav',
  '.ogg': 'ogg',
}

export function containerOf(name: string): ExportFormat | null {
  return CONTAINERS[extOf(name)] ?? null
}

export function exportName(project: Project, cue: Cue, take: Take): string {
  const ext = take.file.format
  return project.exportTemplate
    .replace(/\{EventName\}/g, cue.fields['EventName'] ?? cue.key)
    .replace(/\{WemId\}/g, cue.key)
    .replace(/\{Key\}/g, cue.key)
    .replace(/\{ext\}/g, ext)
}

export function withWemIdSuffix(name: string, key: string): string {
  const ext = extOf(name)
  return ext ? `${name.slice(0, -ext.length)}__${key}${ext}` : `${name}__${key}`
}

export function isFastPath(take: Take, outName: string, comp?: CueComp): boolean {
  if (!isEmptyComp(comp)) return false
  if (hasEdits(take.edits)) return false
  return extOf(outName) === '.' + take.file.format
}

export function outputTakeOf(cue: Cue): Take | undefined {
  const output = cue.output
  if (output === null) return undefined
  if (output?.kind === 'take') return cue.takes.find((t) => t.id === output.takeId)
  if (output?.kind === 'comp') {
    return cue.takes.find((t) => t.id === cue.finalTakeId) ??
      cue.takes.find((t) => t.id === cue.comp?.clips[0]?.sourceTakeId)
  }
  return cue.takes.find((t) => t.id === cue.finalTakeId)
}

export function planBatch(project: Project, scope: 'approved' | 'all-final'): PlannedTake[] {
  const out: PlannedTake[] = []
  for (const cue of project.cues) {
    if (!hasValidVoicedOutput(cue)) continue
    if (scope === 'approved' && approvalState(cue) !== 'approved') continue
    const take = outputTakeOf(cue)
    if (!take) continue
    out.push({ cue, take, name: exportName(project, cue, take) })
  }
  return out
}

export function findCollisions(planned: PlannedTake[]): NameCollision[] {
  const byName = new Map<string, PlannedTake[]>()
  for (const p of planned) {
    const list = byName.get(p.name)
    if (list) list.push(p)
    else byName.set(p.name, [p])
  }
  const collisions: NameCollision[] = []
  for (const [name, list] of byName) {
    if (list.length > 1) collisions.push({ name, cueKeys: list.map((p) => p.cue.key) })
  }
  return collisions
}

export interface ResolvedPlan {
  jobs: PlannedTake[]
  skipped: number
  uncovered: NameCollision[]
}

export function resolvePlan(
  planned: PlannedTake[],
  strategy: Record<string, CollisionStrategy | undefined> = {}
): ResolvedPlan {
  const collisions = findCollisions(planned)
  const uncovered = collisions.filter((c) => !strategy[c.name])
  if (uncovered.length > 0) return { jobs: [], skipped: 0, uncovered }

  const collided = new Set(collisions.map((c) => c.name))
  const groups = new Map<string, PlannedTake[]>()
  for (const p of planned) {
    const list = groups.get(p.name)
    if (list) list.push(p)
    else groups.set(p.name, [p])
  }

  const jobs: PlannedTake[] = []
  let skipped = 0
  for (const [name, list] of groups) {
    if (!collided.has(name)) {
      jobs.push(...list)
      continue
    }
    const s = strategy[name]
    if (s === 'skip') {
      skipped += list.length
    } else if (s === 'reuse') {
      jobs.push(list[list.length - 1])
      skipped += list.length - 1
    } else {
      for (const p of list) jobs.push({ ...p, name: withWemIdSuffix(p.name, p.cue.key) })
    }
  }
  return { jobs, skipped, uncovered: [] }
}
