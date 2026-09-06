import { isEmptyComp } from '@shared/comp'
import type { CompClip, CompRegion, CompTrack, Cue, CueComp } from '@shared/domain'
import { resolveCompClips } from '@shared/export-plan'
import type { TakeLookup } from '@shared/library'
import { audioUrl } from '../api'

export interface ResolvedCompClip {
  clip: CompClip
  url: string
}

export interface ResolvedOriginal {
  url: string
  gainDb: number
  offset?: number
  duration?: number
}

export interface ResolvedComp {
  clips: ResolvedCompClip[]
  region?: CompRegion
  tracks?: CompTrack[]
  original?: ResolvedOriginal
}

export function resolveComp(
  project: TakeLookup | undefined,
  cue: Cue,
  comp: CueComp | null | undefined,
  original?: ResolvedOriginal
): ResolvedComp | null {
  if (isEmptyComp(comp ?? undefined)) return original ? { clips: [], original } : null
  const clips = resolveCompClips(project, cue, comp!).map((c) => ({
    clip: c.clip,
    url: audioUrl(c.relPath),
  }))
  return {
    clips,
    ...(comp!.region ? { region: comp!.region } : {}),
    ...(comp!.tracks ? { tracks: comp!.tracks } : {}),
    ...(original ? { original } : {}),
  }
}

export function tryResolveComp(
  project: TakeLookup | undefined,
  cue: Cue,
  comp: CueComp | null | undefined,
  original?: ResolvedOriginal
): ResolvedComp | null {
  try {
    return resolveComp(project, cue, comp, original)
  } catch {
    return null
  }
}
