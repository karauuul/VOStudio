import { isEmptyComp } from '@shared/comp'
import type { CompClip, CompRegion, Cue, CueComp } from '@shared/domain'
import { audioUrl } from '../api'

export interface ResolvedCompClip {
  clip: CompClip
  url: string
}

export interface ResolvedComp {
  clips: ResolvedCompClip[]
  region?: CompRegion
}

export function resolveComp(cue: Cue, comp: CueComp | null | undefined): ResolvedComp | null {
  if (isEmptyComp(comp ?? undefined)) return null
  const byId = new Map(cue.takes.map((t) => [t.id, t]))
  const clips = comp!.clips.map((clip) => {
    const take = byId.get(clip.sourceTakeId)
    if (!take) throw new Error(`Composition clip "${clip.id}": take ${clip.sourceTakeId} is gone`)
    return { clip, url: audioUrl(take.file.relPath) }
  })
  const region = comp!.region
  return region ? { clips, region } : { clips }
}

export function tryResolveComp(cue: Cue, comp: CueComp | null | undefined): ResolvedComp | null {
  try {
    return resolveComp(cue, comp)
  } catch {
    return null
  }
}
