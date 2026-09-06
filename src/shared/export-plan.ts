import { compDuration, isEmptyComp, withSourceEffects } from './comp'
import { clipSpeed, type ClipEdits, type CompClip, type CompTrack, type Cue, type CueComp, type Project, type Take } from './domain'
import { hasEffects } from './effects'
import { hasValidVoicedOutput, usesCompOutput } from './approval'
import { compTracks, resolveTake, type TakeLookup } from './library'
import { formatSpec, lengthMode, loudnessMode, type ExportSettings } from './export-settings'

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

function withExt(name: string, ext: string): string {
  const current = extOf(name)
  return current ? `${name.slice(0, -current.length)}.${ext}` : `${name}.${ext}`
}

export function exportName(project: Project, cue: Cue, take: Take): string {
  const ext = take.file.format
  const named = project.exportTemplate
    .replace(/\{EventName\}/g, cue.fields['EventName'] ?? cue.key)
    .replace(/\{exportName\}/g, cue.fields['exportName'] || cue.key)
    .replace(/\{WemId\}/g, cue.key)
    .replace(/\{Key\}/g, cue.key)
    .replace(/\{ext\}/g, ext)
  const target = formatSpec(project.export?.format).ext
  return target ? withExt(named, target) : named
}

export function mixesOriginal(cue: Cue): boolean {
  return cue.original?.exportMode === 'on' && !!cue.referenceAudio
}

export function originalLength(cue: Cue): number | undefined {
  if (cue.region) return cue.region.out - cue.region.in
  const d = cue.referenceDuration
  return d !== undefined && d > 0 ? d : undefined
}

export function isFastPath(
  take: Take,
  outName: string,
  comp?: CueComp,
  settings?: ExportSettings,
  cue?: Cue
): boolean {
  if (!isEmptyComp(comp)) return false
  if (hasEdits(take.edits)) return false
  if (loudnessMode(settings) === 'match') return false
  if (lengthMode(settings) === 'pad') return false
  if (cue && mixesOriginal(cue)) return false
  return extOf(outName) === '.' + take.file.format
}

export function outputTakeOf(cue: Cue, project?: TakeLookup): Take | undefined {
  const output = cue.output
  if (output === null) return undefined
  if (output?.kind === 'take') return cue.takes.find((t) => t.id === output.takeId)
  if (output?.kind === 'comp') {
    const first = cue.comp?.clips[0]?.sourceTakeId
    return cue.takes.find((t) => t.id === cue.finalTakeId) ??
      (first ? resolveTake(project, cue, first)?.take : undefined)
  }
  return cue.takes.find((t) => t.id === cue.finalTakeId)
}

export function planBatch(project: Project): PlannedTake[] {
  const out: PlannedTake[] = []
  for (const cue of project.cues) {
    if (cue.status === 'excluded') continue
    if (!hasValidVoicedOutput(cue, project)) continue
    const take = outputTakeOf(cue, project)
    if (!take) continue
    out.push({ cue, take, name: exportName(project, cue, take) })
  }
  return out
}

const nameKey = (name: string): string => name.toLowerCase()

export function findCollisions(planned: PlannedTake[]): NameCollision[] {
  const byName = new Map<string, PlannedTake[]>()
  for (const p of planned) {
    const list = byName.get(nameKey(p.name))
    if (list) list.push(p)
    else byName.set(nameKey(p.name), [p])
  }
  const collisions: NameCollision[] = []
  for (const list of byName.values()) {
    if (list.length > 1) collisions.push({ name: list[0].name, cueKeys: list.map((p) => p.cue.key) })
  }
  return collisions
}

export interface CompClipPlan {
  srcPath: string
  srcIn: number
  srcOut: number
  start: number
  edits: ClipEdits
  crossfade?: number
  trackId?: string
}

export interface CompPlan {
  clips: CompClipPlan[]
  region?: { in: number; out: number }
  tracks?: CompTrack[]
  original?: { srcPath: string; gainDb: number }
}

export interface ResolvedCompClip {
  clip: CompClip
  relPath: string
}

export function resolveCompClips(
  project: TakeLookup | undefined,
  cue: Cue,
  comp: CueComp
): ResolvedCompClip[] {
  return comp.clips.map((clip) => {
    const found = resolveTake(project, cue, clip.sourceTakeId)
    if (!found) {
      throw new Error(`Composition clip "${clip.id}": take ${clip.sourceTakeId} is gone`)
    }
    return { clip: withSourceEffects(clip, found.take), relPath: found.take.file.relPath }
  })
}

export function toClipPlan({ clip, relPath }: ResolvedCompClip): CompClipPlan {
  return {
    srcPath: relPath,
    srcIn: clip.srcIn,
    srcOut: clip.srcOut,
    start: clip.start,
    edits: clip.edits,
    ...(clip.crossfade === undefined ? {} : { crossfade: clip.crossfade }),
    ...(clip.trackId === undefined ? {} : { trackId: clip.trackId }),
  }
}

function outputComp(cue: Cue, project: TakeLookup): CueComp | undefined {
  return usesCompOutput(cue, project) && !isEmptyComp(cue.comp) ? cue.comp : undefined
}

export function takeLength(take: Take): number {
  const trimmed =
    take.duration - Math.max(0, take.edits.trimStart) - Math.max(0, take.edits.trimEnd)
  return Math.max(0, trimmed) / clipSpeed(take.edits)
}

export function contentLength(cue: Cue, take: Take, project: TakeLookup): number {
  const comp = outputComp(cue, project)
  const base = comp ? compDuration(comp) : takeLength(take)
  return mixesOriginal(cue) ? Math.max(base, originalLength(cue) ?? 0) : base
}

export function renderWindow(
  cue: Cue,
  take: Take,
  project: Project
): { in: number; out: number } | undefined {
  const mode = lengthMode(project.export)
  if (mode === 'trim') {
    const region = outputComp(cue, project)?.region
    return region ? { in: region.in, out: region.out } : undefined
  }
  if (mode === 'asis') return undefined
  const orig = originalLength(cue) ?? 0
  const content = contentLength(cue, take, project)
  return orig > content ? { in: 0, out: orig } : undefined
}

export function renderLength(cue: Cue, take: Take, project: Project): number {
  const w = renderWindow(cue, take, project)
  return w ? Math.max(0, w.out - w.in) : contentLength(cue, take, project)
}

export function compPlanFor(cue: Cue, take: Take, project: Project): CompPlan | undefined {
  const comp = outputComp(cue, project)
  const mixed = mixesOriginal(cue)
  const window = renderWindow(cue, take, project)
  if (!comp && !mixed && !window) return undefined
  const known = take.duration > 0 ? take.duration : (originalLength(cue) ?? 0)
  if (!comp && !(known > 0)) return undefined
  const srcIn = Math.max(0, take.edits.trimStart)
  const clips: CompClipPlan[] = comp
    ? resolveCompClips(project, cue, comp).map(toClipPlan)
    : [
        {
          srcPath: take.file.relPath,
          srcIn,
          srcOut: Math.max(srcIn + 0.001, known - Math.max(0, take.edits.trimEnd)),
          start: 0,
          edits: { ...take.edits, trimStart: 0, trimEnd: 0 },
        },
      ]
  const tracks = comp?.tracks ? compTracks(comp) : undefined
  return {
    clips,
    ...(window ? { region: window } : {}),
    ...(tracks ? { tracks } : {}),
    ...(mixed
      ? { original: { srcPath: cue.referenceAudio!.relPath, gainDb: cue.original?.duckDb ?? 0 } }
      : {}),
  }
}
