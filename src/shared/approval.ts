import { compProblem, isEmptyComp } from './comp'
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

function usableComp(cue: Cue, candidate: CueComp | undefined = cue.comp): boolean {
  return !!candidate && !isEmptyComp(candidate) && compProblem(candidate) === null &&
    candidate.clips.every((clip) => cue.takes.some((take) => take.id === clip.sourceTakeId))
}

export function hasValidVoicedOutput(cue: Cue): boolean {
  if (cue.output === null) return false
  if (cue.output?.kind === 'take') return !!usableTake(cue, cue.output.takeId)
  if (cue.output?.kind === 'comp') return usableComp(cue)
  return usableComp(cue) || !!usableTake(cue, cue.finalTakeId)
}

export function usesCompOutput(cue: Cue): boolean {
  return cue.output?.kind === 'comp' || (cue.output === undefined && usableComp(cue))
}

function nextOutputRevision(cue: Cue): number {
  return Math.min(MAX_REVISION, sanitizeRevision(cue.output?.revision) + 1)
}

function nonApprovedStatus(cue: Cue): Cue['status'] {
  if (cue.status === 'excluded') return 'excluded'
  if (hasValidVoicedOutput(cue)) return 'generated'
  return cue.text.trim() ? 'translated' : 'empty'
}

export function changeCueText(cue: Cue, text: string): Cue {
  if (cue.text === text) return cue
  const next = { ...cue, text, textRevision: Math.min(MAX_REVISION, sanitizeRevision(cue.textRevision) + 1) }
  return { ...next, status: nonApprovedStatus(next) }
}

export function changeTakeOutput(cue: Cue, takeId: string): Cue {
  if (!usableTake(cue, takeId)) throw new Error('Take is not a valid voiced output')
  if (cue.output === undefined && cue.finalTakeId === takeId && !usableComp(cue)) return cue
  if (cue.output?.kind === 'take' && cue.output.takeId === takeId && cue.finalTakeId === takeId) return cue
  const next: Cue = {
    ...cue,
    finalTakeId: takeId,
    output: { kind: 'take', takeId, revision: nextOutputRevision(cue) },
  }
  return { ...next, status: nonApprovedStatus(next) }
}

export function changeCompOutput(cue: Cue, comp: CueComp | null): Cue {
  const revision = nextOutputRevision(cue)
  let next: Cue
  if (comp) next = { ...cue, comp, output: { kind: 'comp', revision } }
  else {
    const { comp: _comp, ...withoutComp } = cue
    const take = usableTake(cue, cue.finalTakeId)
    next = { ...withoutComp, output: take ? { kind: 'take', takeId: take.id, revision } : null }
  }
  return { ...next, status: nonApprovedStatus(next) }
}

function materializeOutput(cue: Cue): Cue {
  if (cue.output !== undefined) return cue
  if (usableComp(cue)) return { ...cue, output: { kind: 'comp', revision: 1 } }
  const take = usableTake(cue, cue.finalTakeId)
  return take ? { ...cue, output: { kind: 'take', takeId: take.id, revision: 1 } } : cue
}

export function approveCue(cue: Cue, approvedAt = new Date().toISOString()): Cue {
  const next = materializeOutput(cue)
  if (!next.output || !hasValidVoicedOutput(next)) throw new Error('Approval requires a valid voiced output')
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

export function invalidateVoicedOutput(cue: Cue): Cue {
  if (!hasValidVoicedOutput(cue)) return cue
  const next = materializeOutput(cue)
  if (!next.output) return next
  const bumped: Cue = { ...next, output: { ...next.output, revision: nextOutputRevision(next) } }
  return { ...bumped, status: nonApprovedStatus(bumped) }
}

export function removeApproval(cue: Cue): Cue {
  const { approval: _approval, ...next } = cue
  return { ...next, status: nonApprovedStatus(next) }
}

export function approvalState(cue: Cue): CueApprovalState {
  if (!hasValidVoicedOutput(cue)) return cue.approval ? 'stale' : 'unvoiced'
  if (!cue.approval) return cue.status === 'approved' ? 'approved' : 'needs-review'
  if (!cue.output) return 'stale'
  return cue.approval.textRevision === sanitizeRevision(cue.textRevision) &&
    cue.approval.outputRevision === sanitizeRevision(cue.output.revision)
    ? 'approved'
    : 'stale'
}
