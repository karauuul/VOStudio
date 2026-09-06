import {
  clipEnd,
  clipTrackId,
  COMP_EPS,
  DEFAULT_TRACK_ID,
  newCompClipId,
  normalizeComp,
  splitClipAt,
} from './comp'
import {
  clipSpeed,
  liveTakes,
  sanitizeWords,
  type ClipEdits,
  type CompClip,
  type CompTrack,
  type Cue,
  type CueComp,
  type Project,
  type Take,
  type WordTiming,
} from './domain'

export { clipTrackId, DEFAULT_TRACK_ID }

export type TakeLookup = Pick<Project, 'cues'>

export function compTracks(comp: CueComp): CompTrack[] {
  return comp.tracks ?? [{ id: DEFAULT_TRACK_ID, name: 'Track 1', gainDb: 0, muted: false, solo: false }]
}

export function resolveTake(
  project: TakeLookup | undefined,
  cue: Cue,
  takeId: string
): { take: Take; cue: Cue } | undefined {
  const own = cue.takes.find((t) => t.id === takeId)
  if (own) return { take: own, cue }
  if (!project) return undefined
  for (const other of project.cues) {
    if (other.id === cue.id) continue
    const take = other.takes.find((t) => t.id === takeId && t.pinned === true && !t.deletedAt)
    if (take) return { take, cue: other }
  }
  return undefined
}

export function referencedByOtherComp(
  project: TakeLookup,
  cueId: string,
  takeId: string
): boolean {
  return project.cues.some(
    (c) => c.id !== cueId && (c.comp?.clips ?? []).some((clip) => clip.sourceTakeId === takeId)
  )
}

export interface LibraryRow {
  take: Take
  cueId: string
  label: string
  used: boolean
}

export interface LibraryGroup {
  text: string
  rows: LibraryRow[]
  pinned?: true
  useCount?: number
  lineId?: string
}

const groupText = (take: Take, fallback: string): string => take.meta.text?.trim() || fallback.trim()

export const lineLabel = (cue: Cue): string => cue.fields['EventName'] || cue.key

function labelled(takes: Take[], cueId: (take: Take) => string): LibraryRow[] {
  let versions = 0
  let recordings = 0
  return takes.map((take) => {
    const label = take.kind === 'recording' ? `take ${++recordings}` : `v${++versions}`
    return { take, cueId: cueId(take), label, used: false }
  })
}

function byCreation(takes: Take[]): Take[] {
  return takes
    .map((take, i) => ({ take, i }))
    .sort((a, b) => a.take.createdAt.localeCompare(b.take.createdAt) || a.i - b.i)
    .map((x) => x.take)
}

function collect(takes: Take[], fallback: (take: Take) => string): Map<string, Take[]> {
  const groups = new Map<string, Take[]>()
  for (const take of byCreation(takes)) {
    const key = groupText(take, fallback(take))
    const list = groups.get(key)
    if (list) list.push(take)
    else groups.set(key, [take])
  }
  return groups
}

const usedMarker = (cue: Cue): ((rows: LibraryRow[]) => LibraryRow[]) => {
  const used = new Set((cue.comp?.clips ?? []).map((c) => c.sourceTakeId))
  return (rows) => rows.map((r) => (used.has(r.take.id) ? { ...r, used: true } : r))
}

export function libraryGroups(cue: Cue, project: TakeLookup): LibraryGroup[] {
  const mark = usedMarker(cue)

  const out: LibraryGroup[] = []
  for (const [text, takes] of collect(liveTakes(cue), () => cue.text)) {
    out.push({ text, rows: mark(labelled(takes, () => cue.id)) })
  }

  const pinned: Take[] = []
  const owner = new Map<string, Cue>()
  for (const other of project.cues) {
    if (other.id === cue.id) continue
    for (const take of liveTakes(other)) {
      if (take.pinned !== true) continue
      pinned.push(take)
      owner.set(take.id, other)
    }
  }
  for (const [text, takes] of collect(pinned, (t) => owner.get(t.id)?.text ?? '')) {
    const ids = new Set(takes.map((t) => t.id))
    const useCount = project.cues.filter((c) =>
      (c.comp?.clips ?? []).some((clip) => ids.has(clip.sourceTakeId))
    ).length
    out.push({
      text,
      rows: mark(labelled(takes, (t) => owner.get(t.id)?.id ?? cue.id)),
      pinned: true,
      useCount,
    })
  }
  return out
}

export function projectLibrary(cue: Cue, project: TakeLookup): LibraryGroup[] {
  const mark = usedMarker(cue)
  const out: LibraryGroup[] = []
  for (const other of project.cues) {
    for (const [text, takes] of collect(liveTakes(other), () => other.text)) {
      out.push({ text, lineId: lineLabel(other), rows: mark(labelled(takes, () => other.id)) })
    }
  }
  return out
}

export function libraryRow(
  cue: Cue,
  project: TakeLookup,
  takeId: string
): LibraryRow | undefined {
  const find = (groups: LibraryGroup[]): LibraryRow | undefined =>
    groups.flatMap((g) => g.rows).find((r) => r.take.id === takeId)
  return find(libraryGroups(cue, project)) ?? find(projectLibrary(cue, project))
}

export function clipWords(take: Take, srcIn: number, srcOut: number): WordTiming[] {
  if (!take.words || take.words.length === 0) {
    const text = take.meta.text?.trim() ?? ''
    return text ? [{ text, start: 0, end: Math.max(0, srcOut - srcIn) }] : []
  }
  return take.words
    .filter((w) => w.end > srcIn && w.start < srcOut)
    .map((w) => ({ text: w.text, start: w.start - srcIn, end: w.end - srcIn }))
}

export function clipText(take: Take, srcIn: number, srcOut: number): string {
  return clipWords(take, srcIn, srcOut)
    .map((w) => w.text)
    .join(' ')
    .trim()
}

export function clipVersions(
  cue: Cue,
  project: TakeLookup,
  takeId: string
): { takeId: string; label: string; duration: number; current: boolean }[] {
  for (const group of libraryGroups(cue, project)) {
    if (!group.rows.some((r) => r.take.id === takeId)) continue
    return group.rows.map((r) => ({
      takeId: r.take.id,
      label: r.label,
      duration: r.take.duration,
      current: r.take.id === takeId,
    }))
  }
  return []
}

export function versionLabel(cue: Cue, project: TakeLookup, takeId: string): string {
  return clipVersions(cue, project, takeId).find((v) => v.current)?.label ?? ''
}

export function wordSnapPoints(comp: CueComp, cue: Cue, project: TakeLookup): number[] {
  const out: number[] = [0]
  for (const clip of comp.clips) {
    const end = clipEnd(clip)
    out.push(clip.start, end)
    const found = resolveTake(project, cue, clip.sourceTakeId)
    if (!found?.take.words) continue
    const speed = clipSpeed(clip.edits)
    for (const w of clipWords(found.take, clip.srcIn, clip.srcOut)) {
      for (const t of [clip.start + w.start / speed, clip.start + w.end / speed]) {
        if (t > clip.start + COMP_EPS && t < end - COMP_EPS) out.push(t)
      }
    }
  }
  return [...new Set(out.map((t) => Math.round(t * 1e6) / 1e6))].sort((a, b) => a - b)
}

export function nearestPoint(points: readonly number[], t: number, tolerance = Infinity): number {
  let best = t
  let bestD = tolerance
  for (const p of points) {
    const d = Math.abs(p - t)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

export function splitClipByWord(
  comp: CueComp,
  cue: Cue,
  project: TakeLookup,
  clipId: string,
  at: number
): CueComp {
  const clip = comp.clips.find((c) => c.id === clipId)
  if (!clip) return comp
  const inside = wordSnapPoints(comp, cue, project).filter(
    (p) => p > clip.start + COMP_EPS && p < clipEnd(clip) - COMP_EPS
  )
  return splitClipAt(comp, clipId, inside.length > 0 ? nearestPoint(inside, at) : at)
}

export function addTrack(comp: CueComp): CueComp {
  const tracks = compTracks(comp)
  return normalizeComp({ ...comp, tracks: [...tracks, freshTrack(tracks)] })
}

export function updateTrack(
  comp: CueComp,
  trackId: string,
  patch: Partial<Omit<CompTrack, 'id'>>
): CueComp {
  const tracks = compTracks(comp)
  if (!tracks.some((t) => t.id === trackId)) return comp
  return normalizeComp({
    ...comp,
    tracks: tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
    clips: comp.clips.map((c) => ({ ...c, trackId: clipTrackId(c) })),
  })
}

export interface PlaceClipRequest {
  duration: number
  targetTrackId: string
  playhead: number
  replaceClipId?: string
  sourceTakeId: string
  edits: ClipEdits
}

export interface PlacedClip {
  comp: CueComp
  clipId: string
  trackId: string
}

function freshTrack(tracks: CompTrack[]): CompTrack {
  const taken = new Set(tracks.map((t) => t.id))
  let n = tracks.length + 1
  while (taken.has(`track-${n}`)) n++
  return { id: `track-${n}`, name: `Track ${n}`, gainDb: 0, muted: false, solo: false }
}

export function placeClip(comp: CueComp, req: PlaceClipRequest): PlacedClip {
  const tracks = compTracks(comp)
  const i = req.replaceClipId ? comp.clips.findIndex((c) => c.id === req.replaceClipId) : -1
  if (i >= 0) {
    const previous = comp.clips[i]
    const clips = [...comp.clips]
    clips[i] = {
      ...previous,
      sourceTakeId: req.sourceTakeId,
      srcIn: 0,
      srcOut: req.duration,
      edits: req.edits,
    }
    return {
      comp: normalizeComp({ ...comp, clips }),
      clipId: previous.id,
      trackId: clipTrackId(previous),
    }
  }

  const start = Math.max(0, req.playhead)
  const end = start + req.duration
  const busy = (trackId: string): boolean =>
    comp.clips.some(
      (c) => clipTrackId(c) === trackId && c.start < end - COMP_EPS && clipEnd(c) > start + COMP_EPS
    )

  const from = Math.max(
    0,
    tracks.findIndex((t) => t.id === req.targetTrackId)
  )
  let trackId = ''
  for (let k = from; k < tracks.length; k++) {
    if (!busy(tracks[k].id)) {
      trackId = tracks[k].id
      break
    }
  }
  const added = trackId ? null : freshTrack(tracks)
  if (added) trackId = added.id

  const clip: CompClip = {
    id: newCompClipId(),
    sourceTakeId: req.sourceTakeId,
    srcIn: 0,
    srcOut: req.duration,
    start,
    edits: req.edits,
    ...(!added && !comp.tracks ? {} : { trackId }),
  }
  const next = added ? { ...comp, tracks: [...tracks, added] } : comp
  return { comp: normalizeComp({ ...next, clips: [...comp.clips, clip] }), clipId: clip.id, trackId }
}

export function wordsFromAlignment(value: unknown): WordTiming[] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const a = value as {
    characters?: unknown
    character_start_times_seconds?: unknown
    character_end_times_seconds?: unknown
  }
  const chars = a.characters
  const starts = a.character_start_times_seconds
  const ends = a.character_end_times_seconds
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return undefined
  const n = Math.min(chars.length, starts.length, ends.length)
  const out: WordTiming[] = []
  let text = ''
  let start = 0
  let end = 0
  for (let i = 0; i < n; i++) {
    const ch = chars[i]
    if (typeof ch !== 'string') continue
    if (ch.trim() === '') {
      if (text) out.push({ text, start, end })
      text = ''
      continue
    }
    const s = starts[i]
    const e = ends[i]
    if (typeof s !== 'number' || !Number.isFinite(s)) continue
    if (typeof e !== 'number' || !Number.isFinite(e)) continue
    if (!text) start = Math.max(0, s)
    text += ch
    end = Math.max(start, e)
  }
  if (text) out.push({ text, start, end })
  return sanitizeWords(out)
}
