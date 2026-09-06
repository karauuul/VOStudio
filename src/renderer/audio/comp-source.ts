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
  duckDb?: number
}

export interface ResolvedComp {
  clips: ResolvedCompClip[]
  region?: CompRegion
  tracks?: CompTrack[]
  originals?: ResolvedOriginal[]
}

export function resolveComp(
  project: TakeLookup | undefined,
  cue: Cue,
  comp: CueComp | null | undefined,
  originals: ResolvedOriginal[] = []
): ResolvedComp | null {
  if (isEmptyComp(comp ?? undefined)) {
    return originals.length > 0 ? { clips: [], originals } : null
  }
  const clips = resolveCompClips(project, cue, comp!).map((c) => ({
    clip: c.clip,
    url: audioUrl(c.relPath),
  }))
  return {
    clips,
    ...(comp!.region ? { region: comp!.region } : {}),
    ...(comp!.tracks ? { tracks: comp!.tracks } : {}),
    ...(originals.length > 0 ? { originals } : {}),
  }
}

export function tryResolveComp(
  project: TakeLookup | undefined,
  cue: Cue,
  comp: CueComp | null | undefined,
  originals: ResolvedOriginal[] = []
): ResolvedComp | null {
  try {
    return resolveComp(project, cue, comp, originals)
  } catch {
    return null
  }
}
