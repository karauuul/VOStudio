import { isEmptyComp } from '@shared/comp'
import { usesCompOutput } from '@shared/approval'
import type { CompClip, CompRegion, Cue } from '@shared/domain'
import { audioUrl } from '../api'

export interface ResolvedCompClip {
  clip: CompClip
  url: string
}

export interface ResolvedComp {
  clips: ResolvedCompClip[]
  region?: CompRegion
}

export function resolveCueComp(cue: Cue): ResolvedComp | null {
  if (!usesCompOutput(cue)) return null
  if (isEmptyComp(cue.comp)) return null
  const byId = new Map(cue.takes.map((t) => [t.id, t]))
  const clips = cue.comp!.clips.map((clip) => {
    const take = byId.get(clip.sourceTakeId)
    if (!take) throw new Error(`Composition clip "${clip.id}": take ${clip.sourceTakeId} is gone`)
    return { clip, url: audioUrl(take.file.relPath) }
  })
  const region = cue.comp!.region
  return region ? { clips, region } : { clips }
}

export function tryResolveCueComp(cue: Cue): ResolvedComp | null {
  try {
    return resolveCueComp(cue)
  } catch {
    return null
  }
}
