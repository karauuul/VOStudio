import { compProblem, isEmptyComp } from './comp'
import { resolveTake, type TakeLookup } from './library'
import type { Cue, CueApproval, CueComp, CueOutput, Take } from './domain'

export type CueApprovalState = 'unvoiced' | 'needs-review' | 'stale' | 'approved'

const MAX_REVISION = 2_147_483_647

export function sanitizeRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(MAX_REVISION, Math.max(0, Math.trunc(value)))
}

export function sanitizeCueOutput(value: CueOutput | null | undefined): CueOutput | null | undefined {
  if (value === undefined || value === null) return value
  const revision = sanitizeRevision(value.revision)
  if (value.kind === 'take' && typeof value.takeId === 'string' && value.takeId) {
    return { kind: 'take', takeId: value.takeId, revision }
  }
  if (value.kind === 'comp') return { kind: 'comp', revision }
  return undefined
}

export function sanitizeApproval(value: CueApproval | null | undefined): CueApproval | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value.approvedAt !== 'string' || !value.approvedAt) return undefined
  return {
    textRevision: sanitizeRevision(value.textRevision),
    outputRevision: sanitizeRevision(value.outputRevision),
    approvedAt: value.approvedAt,
  }
}

function usableTake(cue: Cue, takeId: string | undefined): Take | undefined {
  return cue.takes.find((take) => take.id === takeId && !take.deletedAt && take.kind !== 'recording')
}

function usableComp(cue: Cue, project?: TakeLookup): boolean {
  const candidate = cue.comp
  return !!candidate && !isEmptyComp(candidate) && compProblem(candidate) === null &&
    candidate.clips.every((clip) => !!resolveTake(project, cue, clip.sourceTakeId))
}

export function hasValidVoicedOutput(cue: Cue, project?: TakeLookup): boolean {
  if (cue.output === null) return false
  if (cue.output?.kind === 'take') return !!usableTake(cue, cue.output.takeId)
  if (cue.output?.kind === 'comp') return usableComp(cue, project)
  return usableComp(cue, project) || !!usableTake(cue, cue.finalTakeId)
}

export function usesCompOutput(cue: Cue, project?: TakeLookup): boolean {
  return cue.output?.kind === 'comp' || (cue.output === undefined && usableComp(cue, project))
}

function nextOutputRevision(cue: Cue): number {
  return Math.min(MAX_REVISION, sanitizeRevision(cue.output?.revision) + 1)
}

function nonApprovedStatus(cue: Cue, project?: TakeLookup): Cue['status'] {
  if (cue.status === 'excluded') return 'excluded'
  if (hasValidVoicedOutput(cue, project)) return 'generated'
  return cue.text.trim() ? 'translated' : 'empty'
}

function bumpTextRevision(cue: Cue, patch: Partial<Cue>, project?: TakeLookup): Cue {
  const next = {
    ...cue,
    ...patch,
    textRevision: Math.min(MAX_REVISION, sanitizeRevision(cue.textRevision) + 1),
  }
  return { ...next, status: nonApprovedStatus(next, project) }
}

export function changeCueText(cue: Cue, text: string, project?: TakeLookup): Cue {
  return cue.text === text ? cue : bumpTextRevision(cue, { text }, project)
}

export function changeCueSourceText(cue: Cue, sourceText: string, project?: TakeLookup): Cue {
  return cue.sourceText === sourceText ? cue : bumpTextRevision(cue, { sourceText }, project)
}

export function changeTakeOutput(cue: Cue, takeId: string, project?: TakeLookup): Cue {
  if (!usableTake(cue, takeId)) throw new Error('Take is not a valid voiced output')
  if (cue.output === undefined && cue.finalTakeId === takeId && !usableComp(cue, project)) return cue
  if (cue.output?.kind === 'take' && cue.output.takeId === takeId && cue.finalTakeId === takeId) return cue
  const next: Cue = {
    ...cue,
    finalTakeId: takeId,
    output: { kind: 'take', takeId, revision: nextOutputRevision(cue) },
  }
  return { ...next, status: nonApprovedStatus(next, project) }
}

export function changeCompOutput(cue: Cue, comp: CueComp | null, project?: TakeLookup): Cue {
  const revision = nextOutputRevision(cue)
  let next: Cue
  if (comp) next = { ...cue, comp, output: { kind: 'comp', revision } }
  else {
    const { comp: _comp, ...withoutComp } = cue
    const take = usableTake(cue, cue.finalTakeId)
    next = { ...withoutComp, output: take ? { kind: 'take', takeId: take.id, revision } : null }
  }
  return { ...next, status: nonApprovedStatus(next, project) }
}

function materializeOutput(cue: Cue, project?: TakeLookup): Cue {
  if (cue.output !== undefined) return cue
  if (usableComp(cue, project)) return { ...cue, output: { kind: 'comp', revision: 1 } }
  const take = usableTake(cue, cue.finalTakeId)
  return take ? { ...cue, output: { kind: 'take', takeId: take.id, revision: 1 } } : cue
}

export function approveCue(
  cue: Cue,
  approvedAt = new Date().toISOString(),
  project?: TakeLookup
): Cue {
  const next = materializeOutput(cue, project)
  if (!next.output || !hasValidVoicedOutput(next, project)) throw new Error('Approval requires a valid voiced output')
  return {
    ...next,
    status: 'approved',
    approval: {
      textRevision: sanitizeRevision(next.textRevision),
      outputRevision: sanitizeRevision(next.output.revision),
      approvedAt,
    },
  }
}

export function invalidateVoicedOutput(cue: Cue, project?: TakeLookup): Cue {
  if (!hasValidVoicedOutput(cue, project)) return cue
  const next = materializeOutput(cue, project)
  if (!next.output) return next
  const bumped: Cue = { ...next, output: { ...next.output, revision: nextOutputRevision(next) } }
  return { ...bumped, status: nonApprovedStatus(bumped, project) }
}

export function removeApproval(cue: Cue, project?: TakeLookup): Cue {
  const { approval: _approval, ...next } = cue
  return { ...next, status: nonApprovedStatus(next, project) }
}

export function approvalState(cue: Cue, project?: TakeLookup): CueApprovalState {
  if (!hasValidVoicedOutput(cue, project)) return cue.approval ? 'stale' : 'unvoiced'
  if (!cue.approval) return cue.status === 'approved' ? 'approved' : 'needs-review'
  if (!cue.output) return 'stale'
  return cue.approval.textRevision === sanitizeRevision(cue.textRevision) &&
    cue.approval.outputRevision === sanitizeRevision(cue.output.revision)
    ? 'approved'
    : 'stale'
}
