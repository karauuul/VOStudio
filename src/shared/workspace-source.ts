import { hasValidVoicedOutput, usesCompOutput } from './approval'
import { defaultCompFromTake, isEmptyComp } from './comp'
import { liveTakes, type Cue, type CueComp, type Take } from './domain'

export type PreviewSource = { kind: 'none' } | { kind: 'take'; takeId: string } | { kind: 'comp' }

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

function outputSource(cue: Cue): PreviewSource | null {
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
