import { emptyEdits, type CompClip, type CompTrack, type Cue } from './domain'

export interface Span {
  start: number
  end: number
}

export const SILENCE_MIN = 0.6
export const REGION_MIN = 0.8
export const GAP_MERGE = 0.3
export const SCENE_GAP = 3

const SILENCE_START = /silence_start:\s*(-?\d+(?:\.\d+)?)/
const SILENCE_END = /silence_end:\s*(-?\d+(?:\.\d+)?)/

export function parseSilence(stderr: string): Span[] {
  const out: Span[] = []
  let open: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const s = SILENCE_START.exec(line)
    if (s) {
      open = Math.max(0, Number(s[1]))
      continue
    }
    const e = SILENCE_END.exec(line)
    if (e && open !== null) {
      const end = Number(e[1])
      if (Number.isFinite(end) && end > open) out.push({ start: open, end })
      open = null
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

export function regionsBetween(silences: Span[], duration: number): Span[] {
  if (!(duration > 0)) return []
  const loud: Span[] = []
  let at = 0
  for (const s of silences) {
    if (s.end - s.start < SILENCE_MIN) continue
    const start = Math.max(0, Math.min(s.start, duration))
    if (start > at) loud.push({ start: at, end: start })
    at = Math.max(at, Math.min(s.end, duration))
  }
  if (at < duration) loud.push({ start: at, end: duration })
  return dropShort(mergeClose(loud))
}

export function mergeClose(spans: Span[], gap = GAP_MERGE): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s.start - last.end < gap) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

export function dropShort(spans: Span[], min = REGION_MIN): Span[] {
  return spans.filter((s) => s.end - s.start >= min)
}

export interface DetectedRegion {
  in: number
  out: number
  text?: string
  speaker?: string
}

export interface SttWord {
  text: string
  start: number
  end: number
  type?: string
  speaker?: string
}

const SENTENCE_END = /[.!?…]$/

export function transcriptRegions(words: SttWord[]): DetectedRegion[] {
  const spoken = words
    .filter((w) => w.type !== 'spacing' && w.text.trim() !== '')
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start)
  const out: DetectedRegion[] = []
  let bucket: SttWord[] = []
  const flush = (): void => {
    if (bucket.length === 0) return
    const text = bucket.map((w) => w.text.trim()).join(' ')
    const speaker = bucket[0].speaker
    out.push({
      in: Math.max(0, bucket[0].start),
      out: Math.max(bucket[0].start, bucket[bucket.length - 1].end),
      text,
      ...(speaker ? { speaker } : {}),
    })
    bucket = []
  }
  for (const w of spoken) {
    const previous = bucket[bucket.length - 1]
    if (previous && previous.speaker !== w.speaker) flush()
    bucket.push(w)
    if (SENTENCE_END.test(w.text.trim())) flush()
  }
  flush()
  return out
}

export interface RegionCueSeed {
  key: string
  in: number
  out: number
  sourceText: string
  characterId: string
}

export function regionCues(
  sourceName: string,
  regions: DetectedRegion[],
  characterFor: (speaker: string | undefined) => string
): RegionCueSeed[] {
  return regions.map((r, i) => ({
    key: `${sourceName}_${String(i + 1).padStart(3, '0')}`,
    in: r.in,
    out: r.out,
    sourceText: r.text ?? '',
    characterId: characterFor(r.speaker),
  }))
}

export function hasComposition(cue: Cue): boolean {
  return (cue.comp?.clips.length ?? 0) > 0 || cue.takes.some((t) => !t.deletedAt)
}

export interface RegionMerge {
  keep: Cue[]
  removedIds: string[]
  startIndex: number
}

export function mergeRegionCues(cues: Cue[], sourceId: string): RegionMerge {
  const mine = cues.filter((c) => c.region?.sourceId === sourceId)
  const keep = mine.filter(hasComposition)
  return {
    keep,
    removedIds: mine.filter((c) => !keep.includes(c)).map((c) => c.id),
    startIndex: keep.length,
  }
}

export interface SceneGroup {
  name: string
  count: number
}

export interface GroupedRegionCues {
  cues: Cue[]
  groups: SceneGroup[]
}

function sceneTitle(index: number, cue: Cue): string {
  const words = (cue.sourceText || cue.text || '').trim().split(/\s+/).filter(Boolean).slice(0, 4)
  return words.length > 0 ? `Scene ${index} · ${words.join(' ')}` : `Scene ${index}`
}

export function groupByScene(cues: Cue[], gap = SCENE_GAP): GroupedRegionCues {
  const ordered = [...cues].sort((a, b) => (a.region?.in ?? 0) - (b.region?.in ?? 0))
  const groups: SceneGroup[] = []
  let previousOut: number | null = null
  for (const cue of ordered) {
    const region = cue.region
    const start = region?.in ?? 0
    const broken = previousOut === null || start - previousOut > gap
    if (broken) groups.push({ name: sceneTitle(groups.length + 1, cue), count: 0 })
    groups[groups.length - 1].count++
    previousOut = region?.out ?? start
  }
  return { cues: ordered, groups }
}

export function regionTimecode(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`
}

export interface VideoLineComp {
  cueId: string
  in: number
  out: number
  clips: Array<{ srcPath: string; srcIn: number; srcOut: number; start: number; edits: CompClip['edits']; crossfade?: number; trackId?: string }>
  tracks?: CompTrack[]
  originalMode: 'off' | 'on'
  duckDb: number
}

export interface VideoTimelinePlan {
  clips: Array<{
    srcPath: string
    srcIn: number
    srcOut: number
    start: number
    edits: CompClip['edits']
    crossfade?: number
    trackId?: string
  }>
  tracks: CompTrack[]
  duration: number
}

const SOURCE_TRACK = 'source'

function sourceTrack(): CompTrack {
  return { id: SOURCE_TRACK, name: 'Source', gainDb: 0, muted: false, solo: false }
}

function withGain(gainDb: number): CompClip['edits'] {
  return { ...emptyEdits(), gainDb }
}

export function sourceSegments(
  srcPath: string,
  duration: number,
  lines: Array<{ in: number; out: number; originalMode: 'off' | 'on'; duckDb: number }>
): VideoTimelinePlan['clips'] {
  const ordered = [...lines].sort((a, b) => a.in - b.in)
  const out: VideoTimelinePlan['clips'] = []
  const push = (from: number, to: number, gainDb: number): void => {
    const a = Math.max(0, Math.min(from, duration))
    const b = Math.max(a, Math.min(to, duration))
    if (b - a <= 0.001) return
    out.push({ srcPath, srcIn: a, srcOut: b, start: a, edits: withGain(gainDb), trackId: SOURCE_TRACK })
  }
  let at = 0
  for (const line of ordered) {
    const from = Math.max(at, line.in)
    push(at, line.in, 0)
    if (line.originalMode === 'on') push(from, line.out, line.duckDb)
    at = Math.max(at, line.out)
  }
  push(at, duration, 0)
  return out
}

export function videoTimelinePlan(
  srcPath: string,
  duration: number,
  lines: VideoLineComp[]
): VideoTimelinePlan {
  const clips: VideoTimelinePlan['clips'] = []
  const tracks: CompTrack[] = [sourceTrack()]
  for (const line of lines) {
    const soloed = (line.tracks ?? []).some((t) => t.solo)
    const namespaced = (line.tracks ?? []).map((t) => ({
      ...t,
      id: `${line.cueId}:${t.id}`,
      muted: t.muted || (soloed && !t.solo),
      solo: false,
    }))
    tracks.push(...namespaced)
    const fallback = `${line.cueId}:track`
    if (namespaced.length === 0) {
      tracks.push({ id: fallback, name: line.cueId, gainDb: 0, muted: false, solo: false })
    }
    for (const c of line.clips) {
      clips.push({
        ...c,
        start: line.in + c.start,
        trackId: c.trackId ? `${line.cueId}:${c.trackId}` : fallback,
      })
    }
  }
  clips.push(
    ...sourceSegments(
      srcPath,
      duration,
      lines.map((l) => ({ in: l.in, out: l.out, originalMode: l.originalMode, duckDb: l.duckDb }))
    )
  )
  return { clips, tracks, duration }
}

export function renderChunks(duration: number, chunk: number, lines: Span[]): Span[] {
  if (!(duration > 0)) return []
  const size = Math.max(1, chunk)
  const busy = mergeClose(
    [...lines].sort((a, b) => a.start - b.start).map((l) => ({ ...l })),
    0
  )
  const out: Span[] = []
  let at = 0
  while (at < duration) {
    let end = Math.min(duration, at + size)
    if (end < duration) {
      const hit = busy.find((b) => end > b.start && end < b.end)
      if (hit) end = Math.min(duration, hit.end)
    }
    out.push({ start: at, end })
    at = end
  }
  return out
}
