import { approvalState, hasValidVoicedOutput, usesCompOutput } from './approval'
import { isEmptyComp } from './comp'
import type { Cue, Project, Take } from './domain'
import {
  containerOf,
  findCollisions,
  planBatch,
  resolvePlan,
  type CollisionStrategy,
  type NameCollision,
  type PlannedTake,
} from './export-plan'

export type ExportScope = 'approved' | 'all-final'

export interface PreflightName {
  cueId: string
  cueKey: string
  name: string
}

export interface PreflightSource extends PreflightName {
  path: string
  inScope: boolean
}

export interface PreflightPlan {
  scope: ExportScope
  approved: number
  unapproved: number
  eligible: number
  skipped: number
  stale: number
  missingOutput: number
  excluded: number
  missingReference: number
  collisions: NameCollision[]
  invalid: PreflightName[]
  names: PreflightName[]
  sources: PreflightSource[]
}

function named(p: PlannedTake): PreflightName {
  return { cueId: p.cue.id, cueKey: p.cue.key, name: p.name }
}

function sourcePaths(cue: Cue, take: Take): string[] {
  if (usesCompOutput(cue) && !isEmptyComp(cue.comp)) {
    return (cue.comp?.clips ?? []).flatMap((clip) => {
      const source = cue.takes.find((t) => t.id === clip.sourceTakeId)
      return source ? [source.file.relPath] : []
    })
  }
  return [take.file.relPath]
}

export function preflightPlan(
  project: Project,
  scope: ExportScope,
  strategy: Record<string, CollisionStrategy | undefined> = {}
): PreflightPlan {
  const all = planBatch(project, 'all-final')
  const approved = all.filter((p) => approvalState(p.cue) === 'approved')
  const planned = scope === 'approved' ? approved : all
  const resolved = resolvePlan(planned, strategy)
  const scoped = new Set((resolved.uncovered.length > 0 ? planned : resolved.jobs).map((p) => p.cue.id))
  const names = (resolved.uncovered.length > 0 ? planned : resolved.jobs).map(named)

  let stale = 0
  let missingOutput = 0
  let excluded = 0
  for (const cue of project.cues) {
    if (cue.status === 'excluded') excluded++
    else if (!hasValidVoicedOutput(cue)) missingOutput++
    else if (approvalState(cue) === 'stale') stale++
  }

  return {
    scope,
    approved: approved.length,
    unapproved: all.length - approved.length,
    eligible: names.length,
    skipped: resolved.skipped,
    stale,
    missingOutput,
    excluded,
    missingReference: planned.filter((p) => p.cue.referenceAudio === undefined).length,
    collisions: findCollisions(planned),
    invalid: names.filter((n) => containerOf(n.name) === null),
    names,
    sources: all.flatMap((p) =>
      sourcePaths(p.cue, p.take).map((path) => ({
        ...named(p),
        path,
        inScope: scoped.has(p.cue.id),
      }))
    ),
  }
}
