import { approvalState, hasValidVoicedOutput, usesCompOutput } from './approval'
import { defaultCompFromTake, isEmptyComp } from './comp'
import { liveTakes, type Cue, type CueComp, type Take } from './domain'

export type PreviewSource = { kind: 'none' } | { kind: 'take'; takeId: string } | { kind: 'comp' }

export type CueDecision = 'approved' | 'approve' | 'set-final' | 'none'

export interface ResolvedPreview {
  source: PreviewSource
  take?: Take
  comp?: CueComp
}

export const previewClipIdOf = (takeId: string): string => `cc_v_${takeId}`

function newestTake(takes: Take[]): Take | undefined {
  let best: Take | undefined
  for (const take of takes) {
    if (!best || take.createdAt >= best.createdAt) best = take
  }
  return best
}

export function sameSource(a: PreviewSource, b: PreviewSource): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'take' || b.kind !== 'take' || a.takeId === b.takeId
}

export function outputSource(cue: Cue): PreviewSource | null {
  if (!hasValidVoicedOutput(cue)) return null
  if (usesCompOutput(cue)) return { kind: 'comp' }
  const takeId = cue.output?.kind === 'take' ? cue.output.takeId : cue.finalTakeId
  return takeId ? { kind: 'take', takeId } : null
}

export function initialPreviewSource(cue: Cue): PreviewSource {
  const output = outputSource(cue)
  if (output) return output
  const live = liveTakes(cue)
  const take = newestTake(live.filter((t) => t.kind !== 'recording')) ?? newestTake(live)
  return take ? { kind: 'take', takeId: take.id } : { kind: 'none' }
}

export function resolvePreview(cue: Cue, source: PreviewSource, takeDuration?: number): ResolvedPreview {
  if (source.kind === 'take') {
    const take = liveTakes(cue).find((t) => t.id === source.takeId)
    if (!take) return { source }
    const duration = takeDuration !== undefined && takeDuration > 0 ? takeDuration : take.duration
    try {
      return { source, take, comp: defaultCompFromTake(take, { duration, id: previewClipIdOf(take.id) }) }
    } catch {
      return { source, take }
    }
  }
  if (source.kind === 'comp' && !isEmptyComp(cue.comp)) return { source, comp: cue.comp }
  return { source }
}

export function setFinalEligible(cue: Cue, source: PreviewSource): boolean {
  const output = outputSource(cue)
  if (output && sameSource(output, source)) return false
  if (source.kind === 'take') {
    const take = liveTakes(cue).find((t) => t.id === source.takeId)
    return !!take && take.kind !== 'recording'
  }
  return source.kind === 'comp' && !isEmptyComp(cue.comp)
}

export function cueDecision(cue: Cue, source: PreviewSource): CueDecision {
  if (cue.status === 'excluded') return 'none'
  const output = outputSource(cue)
  if (output && sameSource(output, source)) {
    return approvalState(cue) === 'approved' ? 'approved' : 'approve'
  }
  return source.kind === 'none' ? 'none' : 'set-final'
}

export function shouldSelectCandidate(o: {
  active: boolean
  take: Take
  submitted: PreviewSource | null
  current: PreviewSource
  playing: boolean
  recording: boolean
}): boolean {
  if (!o.active || o.playing || o.recording) return false
  if (o.take.kind === 'recording' || o.take.fragment) return false
  return !!o.submitted && sameSource(o.submitted, o.current)
}
