import {
  clipSpeed,
  emptyEdits,
  envelopeDbAt,
  sanitizeCompTracks,
  type CompTrack,
  type ClipEdits,
  type CompClip,
  type CompRegion,
  type CueComp,
  type Take,
} from './domain'
import { effectsTail, pitchActive, sanitizeEffects } from './effects'

export const COMP_EPS = 1e-6

export const MIN_CLIP_SRC = 0.001

export const MIN_CROSSFADE = 0.001

export const DEFAULT_CROSSFADE = 0.08

export const DEFAULT_TRACK_ID = 'track-1'

export function clipTrackId(clip: CompClip): string {
  return clip.trackId ?? DEFAULT_TRACK_ID
}

export function trackClips(comp: CueComp, trackId: string): CompClip[] {
  return comp.clips
    .filter((c) => clipTrackId(c) === trackId)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
}

interface Siblings {
  clip: CompClip
  prev?: CompClip
  next?: CompClip
}

function siblings(comp: CueComp, clipId: string): Siblings | null {
  const clip = comp.clips.find((c) => c.id === clipId)
  if (!clip) return null
  const row = trackClips(comp, clipTrackId(clip))
  const k = row.findIndex((c) => c.id === clipId)
  return { clip, prev: row[k - 1], next: row[k + 1] }
}

function groupByTrack(clips: readonly CompClip[]): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  for (let i = 0; i < clips.length; i++) {
    const key = clipTrackId(clips[i])
    const list = groups.get(key)
    if (list) list.push(i)
    else groups.set(key, [i])
  }
  return groups
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function clipTimelineDuration(clip: CompClip): number {
  const src = clip.srcOut - clip.srcIn
  if (!Number.isFinite(src) || src <= 0) return 0
  return src / clipSpeed(clip.edits)
}

export function clipEnd(clip: CompClip): number {
  return clip.start + clipTimelineDuration(clip)
}

export function compDuration(comp: CueComp): number {
  let end = 0
  for (const c of comp.clips) {
    const e = clipEnd(c)
    if (e > end) end = e
  }
  return end
}

export function isEmptyComp(comp: CueComp | undefined): boolean {
  return !comp || comp.clips.length === 0
}

const trackOf = (tracks: readonly CompTrack[] | undefined, clip: CompClip): CompTrack | undefined =>
  tracks?.find((t) => t.id === clipTrackId(clip))

export function compEffectsTail(clips: readonly CompClip[], tracks?: readonly CompTrack[]): number {
  const total = compDuration({ clips: [...clips] })
  let end = total
  for (const c of clips) {
    const tail = effectsTail(c.edits.effects) + effectsTail(trackOf(tracks, c)?.effects)
    if (tail <= 0) continue
    const e = clipEnd(c) + tail
    if (e > end) end = e
  }
  return Math.max(0, end - total)
}

export function compHasReverb(clips: readonly CompClip[], tracks?: readonly CompTrack[]): boolean {
  return clips.some((c) => !!c.edits.effects?.reverb || !!trackOf(tracks, c)?.effects?.reverb)
}

export function compHasPitch(clips: readonly CompClip[]): boolean {
  return clips.some((c) => pitchActive(c.edits.effects?.pitch))
}

export function compClipEdits(clip: CompClip, bufferDuration: number): ClipEdits {
  const dur = Number.isFinite(bufferDuration) && bufferDuration > 0 ? bufferDuration : 0
  const srcIn = clamp(clip.srcIn, 0, dur)
  const srcOut = clamp(clip.srcOut, srcIn, dur)
  return { ...clip.edits, trimStart: srcIn, trimEnd: Math.max(0, dur - srcOut) }
}

let idSeq = 0

export function newCompClipId(): string {
  idSeq += 1
  return `cc_${Date.now().toString(36)}_${idSeq.toString(36)}`
}

export function defaultCompFromTake(
  take: Pick<Take, 'id' | 'duration' | 'edits'>,
  opts: { duration?: number; id?: string } = {}
): CueComp {
  const total = opts.duration ?? take.duration
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`Cannot build a composition from a take with no duration (${total})`)
  }
  const srcIn = clamp(Math.max(0, take.edits.trimStart), 0, total)
  const srcOut = clamp(total - Math.max(0, take.edits.trimEnd), srcIn, total)
  if (srcOut - srcIn < MIN_CLIP_SRC) {
    throw new Error(`Take trims leave nothing to compose (${srcIn.toFixed(3)}s…${srcOut.toFixed(3)}s)`)
  }
  return {
    clips: [
      {
        id: opts.id ?? newCompClipId(),
        sourceTakeId: take.id,
        srcIn,
        srcOut,
        start: 0,
        edits: { ...take.edits, trimStart: 0, trimEnd: 0 },
      },
    ],
  }
}

function normalizeRegion(region: CompRegion | undefined, total: number): CompRegion | undefined {
  if (!region) return undefined
  if (!Number.isFinite(region.in) || !Number.isFinite(region.out)) return undefined
  const max = Number.isFinite(total) && total > 0 ? total : 0
  const from = clamp(Math.max(0, region.in), 0, max)
  const to = clamp(region.out, from, max)
  return to - from > COMP_EPS ? { in: from, out: to } : undefined
}

function withClips(comp: CueComp, clips: CompClip[]): CueComp {
  return normalizeComp({ ...comp, clips })
}

export function normalizeComp(comp: CueComp): CueComp {
  const clips = comp.clips
    .filter((c) => clipTimelineDuration(c) > 0 && Number.isFinite(c.start))
    .map((c) => ({ ...c, start: Math.max(0, c.start) }))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
  const region = normalizeRegion(comp.region, compDuration({ clips }))
  const tracks = sanitizeCompTracks(comp.tracks)
  return {
    clips,
    ...(region ? { region } : {}),
    ...(tracks ? { tracks } : {}),
  }
}

export function compProblem(comp: CueComp): string | null {
  const seen = new Set<string>()
  for (const c of comp.clips) {
    if (!Number.isFinite(c.srcIn) || !Number.isFinite(c.srcOut) || !Number.isFinite(c.start)) {
      return `clip "${c.id}" has non-finite positions`
    }
    if (c.srcIn < 0) return `clip "${c.id}" has srcIn < 0`
    if (c.start < 0) return `clip "${c.id}" starts before zero`
    if (c.srcOut <= c.srcIn) return `clip "${c.id}" has srcOut <= srcIn`
    if (c.crossfade !== undefined && (!Number.isFinite(c.crossfade) || c.crossfade < 0)) {
      return `clip "${c.id}" has an invalid crossfade`
    }
    if (seen.has(c.id)) return `duplicate clip id "${c.id}"`
    seen.add(c.id)
  }
  if (comp.tracks) {
    const trackIds = new Set<string>()
    for (const t of comp.tracks) {
      if (!t.id) return 'a track has no id'
      if (trackIds.has(t.id)) return `duplicate track id "${t.id}"`
      trackIds.add(t.id)
    }
    for (const c of comp.clips) {
      if (!trackIds.has(clipTrackId(c))) {
        return `clip "${c.id}" points at unknown track "${clipTrackId(c)}"`
      }
    }
  }
  for (const indices of groupByTrack(comp.clips).values()) {
    const sorted = indices.map((i) => comp.clips[i]).sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < clipEnd(sorted[i - 1]) - COMP_EPS) {
        return `clips "${sorted[i - 1].id}" and "${sorted[i].id}" overlap`
      }
    }
  }
  const r = comp.region
  if (r) {
    if (!Number.isFinite(r.in) || !Number.isFinite(r.out)) return 'region has non-finite bounds'
    if (r.in < 0) return 'region starts before zero'
    if (r.out <= r.in) return 'region has out <= in'
  }
  return null
}

export function setRegion(comp: CueComp, region: CompRegion | null): CueComp {
  if (!region) {
    if (!comp.region) return comp
    const { region: _drop, ...rest } = comp
    return normalizeComp(rest)
  }
  const lo = Math.min(region.in, region.out)
  const hi = Math.max(region.in, region.out)
  return normalizeComp({ ...comp, region: { in: lo, out: hi } })
}

export function setRegionEdge(comp: CueComp, edge: 'in' | 'out', t: number): CueComp {
  if (!Number.isFinite(t)) return comp
  const total = compDuration(comp)
  if (!(total > 0)) return comp
  const cur = comp.region
  const at = clamp(Math.max(0, t), 0, total)
  if (edge === 'in') {
    const out = cur && cur.out > at ? cur.out : total
    return setRegion(comp, { in: at, out })
  }
  const from = cur && cur.in < at ? cur.in : 0
  return setRegion(comp, { in: from, out: at })
}

export function crossfadeRoom(a: CompClip, b: CompClip): number {
  if (Math.abs(b.start - clipEnd(a)) > COMP_EPS) return 0
  const handle = Math.max(0, b.srcIn) / clipSpeed(b.edits)
  const room = Math.min(clipTimelineDuration(a), clipTimelineDuration(b), handle)
  return room > MIN_CROSSFADE ? room : 0
}

export function maxCrossfade(comp: CueComp, clipId: string): number {
  const pair = siblings(normalizeComp(comp), clipId)
  if (!pair?.next) return 0
  return crossfadeRoom(pair.clip, pair.next)
}

export function effectiveCrossfade(a: CompClip, b: CompClip | undefined): number {
  const want = a.crossfade
  if (b === undefined || want === undefined || !Number.isFinite(want) || want <= MIN_CROSSFADE) {
    return 0
  }
  const room = crossfadeRoom(a, b)
  return room > 0 ? Math.min(want, room) : 0
}

function stripCrossfade(c: CompClip): CompClip {
  if (c.crossfade === undefined) return c
  const { crossfade: _drop, ...rest } = c
  return rest
}

export function setCrossfade(comp: CueComp, clipId: string, seconds: number): CueComp {
  const norm = normalizeComp(comp)
  const pair = siblings(norm, clipId)
  if (!pair?.next || !Number.isFinite(seconds)) return comp
  const i = indexOf(norm, clipId)
  const c = pair.clip
  const room = crossfadeRoom(c, pair.next)
  const v = clamp(seconds, 0, room)
  const next = v > MIN_CROSSFADE ? { ...c, crossfade: v } : stripCrossfade(c)
  if (next.crossfade === c.crossfade) return norm
  const clips = [...norm.clips]
  clips[i] = next
  return withClips(norm, clips)
}

export interface CompRenderClip {
  clip: CompClip
  crossfadeIn: number
  crossfadeOut: number
}

export function compRenderPlan(clips: readonly CompClip[]): CompRenderClip[] {
  const n = clips.length
  const outXf = new Array<number>(n).fill(0)
  const inXf = new Array<number>(n).fill(0)
  for (const indices of groupByTrack(clips).values()) {
    const order = indices.sort(
      (a, b) => clips[a].start - clips[b].start || clips[a].id.localeCompare(clips[b].id)
    )
    for (let k = 0; k + 1 < order.length; k++) {
      outXf[order[k]] = effectiveCrossfade(clips[order[k]], clips[order[k + 1]])
    }
    for (let k = 1; k < order.length; k++) inXf[order[k]] = outXf[order[k - 1]]
  }
  const plan = new Array<CompRenderClip>(n)
  for (let i = 0; i < n; i++) {
    const c = clips[i]
    const xin = inXf[i]
    plan[i] = {
      clip:
        xin > 0 ? { ...c, start: c.start - xin, srcIn: c.srcIn - xin * clipSpeed(c.edits) } : c,
      crossfadeIn: xin,
      crossfadeOut: outXf[i],
    }
  }
  return plan
}

function indexOf(comp: CueComp, clipId: string): number {
  return comp.clips.findIndex((c) => c.id === clipId)
}

export function removeClip(comp: CueComp, clipId: string): CueComp {
  const clips = comp.clips.filter((c) => c.id !== clipId)
  return clips.length === comp.clips.length ? comp : withClips(comp, clips)
}

export function findInsertSlot(
  comp: CueComp,
  duration: number,
  at: number,
  maxShift = Infinity
): number | null {
  if (!Number.isFinite(duration) || duration < MIN_CLIP_SRC || !Number.isFinite(at)) return null
  const clips = normalizeComp(comp).clips
  const want = Math.max(0, at)
  let best: number | null = null
  let bestD = Infinity
  let lo = 0
  for (let i = 0; i <= clips.length; i++) {
    const hi = i < clips.length ? clips[i].start : Infinity
    if (hi - lo >= duration - COMP_EPS) {
      const top = hi === Infinity ? Infinity : hi - duration
      const start = clamp(want, lo, Math.max(lo, top))
      const d = Math.abs(start - want)
      if (d < bestD) {
        bestD = d
        best = start
      }
    }
    if (i < clips.length) lo = Math.max(lo, clipEnd(clips[i]))
  }
  if (best === null || bestD > maxShift + COMP_EPS) return null
  return best
}

export function insertClipFromTake(
  comp: CueComp,
  takeId: string,
  duration: number,
  at: number,
  opts: { id?: string; maxShift?: number } = {}
): CueComp {
  const start = findInsertSlot(comp, duration, at, opts.maxShift ?? Infinity)
  if (start === null) return comp
  const clip: CompClip = {
    id: opts.id ?? newCompClipId(),
    sourceTakeId: takeId,
    srcIn: 0,
    srcOut: duration,
    start,
    edits: emptyEdits(),
  }
  return withClips(comp, [...comp.clips, clip])
}

export function splitClipAt(
  comp: CueComp,
  clipId: string,
  t: number,
  ids: { left?: string; right?: string } = {}
): CueComp {
  const i = indexOf(comp, clipId)
  if (i < 0) return comp
  const c = comp.clips[i]
  const local = t - c.start
  const tl = clipTimelineDuration(c)
  const speed = clipSpeed(c.edits)
  if (!(local > COMP_EPS) || !(local < tl - COMP_EPS)) return comp
  const cut = c.srcIn + local * speed
  if (cut - c.srcIn < MIN_CLIP_SRC || c.srcOut - cut < MIN_CLIP_SRC) return comp

  const [leftEnv, rightEnv] = splitEnvelope(c.edits.gainEnvelope, local)
  const left: CompClip = stripCrossfade({
    ...c,
    id: ids.left ?? c.id,
    srcOut: cut,
    edits: {
      ...c.edits,
      fadeOut: { ...c.edits.fadeOut, duration: 0 },
      ...(leftEnv ? { gainEnvelope: leftEnv } : {}),
    },
  })
  const right: CompClip = {
    ...c,
    id: ids.right ?? newCompClipId(),
    srcIn: cut,
    start: c.start + local,
    edits: {
      ...c.edits,
      fadeIn: { ...c.edits.fadeIn, duration: 0 },
      ...(rightEnv ? { gainEnvelope: rightEnv } : {}),
    },
  }
  const clips = [...comp.clips]
  clips.splice(i, 1, left, right)
  return withClips(comp, clips)
}

function splitEnvelope(
  env: Array<{ t: number; db: number }> | undefined,
  local: number
): [Array<{ t: number; db: number }> | null, Array<{ t: number; db: number }> | null] {
  if (!env || env.length === 0) return [null, null]
  const pts = [...env].sort((a, b) => a.t - b.t)
  const at = envelopeDbAt(pts, local)
  const left = pts.filter((p) => p.t < local).concat([{ t: local, db: at }])
  const right = [{ t: 0, db: at }].concat(
    pts.filter((p) => p.t > local).map((p) => ({ t: p.t - local, db: p.db }))
  )
  return [left, right]
}

export function healPair(comp: CueComp, leftClipId: string): [CompClip, CompClip] | null {
  const norm = normalizeComp(comp)
  const pair = siblings(norm, leftClipId)
  if (!pair?.next) return null
  const left = pair.clip
  const right = pair.next
  if (left.sourceTakeId !== right.sourceTakeId) return null
  if (Math.abs(clipSpeed(left.edits) - clipSpeed(right.edits)) > COMP_EPS) return null
  if (Math.abs(right.srcIn - left.srcOut) > COMP_EPS) return null
  if (Math.abs(right.start - clipEnd(left)) > COMP_EPS) return null
  return [left, right]
}

export function canHeal(comp: CueComp, leftClipId: string): boolean {
  return healPair(comp, leftClipId) !== null
}

export function healableAt(comp: CueComp, t: number, tolerance = 0.25): string | null {
  const norm = normalizeComp(comp)
  let best: string | null = null
  let bestD = tolerance > 0 ? tolerance : 0
  for (const c of norm.clips) {
    if (!canHeal(norm, c.id)) continue
    const d = Math.abs(clipEnd(c) - t)
    if (d <= bestD) {
      bestD = d
      best = c.id
    }
  }
  return best
}

export function healCut(comp: CueComp, leftClipId: string): CueComp {
  const pair = healPair(comp, leftClipId)
  if (!pair) return comp
  const [left, right] = pair
  const norm = normalizeComp(comp)

  const envelope = joinEnvelope(
    left.edits.gainEnvelope,
    right.edits.gainEnvelope,
    clipTimelineDuration(left)
  )
  const merged: CompClip = {
    ...stripCrossfade(left),
    srcOut: right.srcOut,
    ...(right.crossfade === undefined ? {} : { crossfade: right.crossfade }),
    edits: {
      ...left.edits,
      fadeOut: { ...right.edits.fadeOut },
      ...(envelope ? { gainEnvelope: envelope } : {}),
    },
  }
  if (!envelope && merged.edits.gainEnvelope) {
    const { gainEnvelope: _drop, ...rest } = merged.edits
    merged.edits = rest
  }

  const clips = norm.clips.filter((c) => c.id !== right.id).map((c) => (c.id === left.id ? merged : c))
  return withClips(norm, clips)
}

function joinEnvelope(
  left: Array<{ t: number; db: number }> | undefined,
  right: Array<{ t: number; db: number }> | undefined,
  leftLength: number
): Array<{ t: number; db: number }> | null {
  const l = left ? [...left].sort((a, b) => a.t - b.t) : []
  const r = right ? [...right].sort((a, b) => a.t - b.t) : []
  if (l.length === 0 && r.length === 0) return null
  const pts = l.concat(r.map((p) => ({ t: p.t + leftLength, db: p.db })))
  const dedup: Array<{ t: number; db: number }> = []
  for (const p of pts) {
    const prev = dedup[dedup.length - 1]
    if (prev && Math.abs(prev.t - p.t) <= COMP_EPS && Math.abs(prev.db - p.db) <= COMP_EPS) continue
    dedup.push(p)
  }
  const out = dedup.filter((p, k) => {
    if (k === 0 || k === dedup.length - 1) return true
    if (Math.abs(p.t - leftLength) > COMP_EPS) return true
    const on = envelopeDbAt([dedup[k - 1], dedup[k + 1]], p.t)
    return Math.abs(on - p.db) > 1e-9
  })
  return out.length > 0 ? out : null
}

export function trackIsFree(
  comp: CueComp,
  trackId: string,
  from: number,
  to: number,
  exceptClipId?: string
): boolean {
  return !comp.clips.some(
    (c) =>
      c.id !== exceptClipId &&
      clipTrackId(c) === trackId &&
      c.start < to - COMP_EPS &&
      clipEnd(c) > from + COMP_EPS
  )
}

export function moveClipTo(
  comp: CueComp,
  clipId: string,
  newStart: number,
  trackId?: string
): CueComp {
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0 || !Number.isFinite(newStart)) return comp
  const c = norm.clips[i]
  const track = trackId ?? clipTrackId(c)
  const start = Math.max(0, newStart)
  if (start === c.start && track === clipTrackId(c)) return norm
  if (!trackIsFree(norm, track, start, start + clipTimelineDuration(c), clipId)) return norm
  const clips = [...norm.clips]
  clips[i] = { ...c, start, ...(norm.tracks || trackId !== undefined ? { trackId: track } : {}) }
  return withClips(norm, clips)
}

export function slipClip(
  comp: CueComp,
  clipId: string,
  delta: number,
  sourceDuration = Infinity
): CueComp {
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0 || !Number.isFinite(delta)) return comp
  const c = norm.clips[i]
  const speed = clipSpeed(c.edits)
  const maxSrc = Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : Infinity
  const d = clamp(delta * speed, -c.srcIn, maxSrc - c.srcOut)
  if (Math.abs(d) <= COMP_EPS) return norm
  const clips = [...norm.clips]
  clips[i] = { ...c, srcIn: c.srcIn + d, srcOut: c.srcOut + d }
  return withClips(norm, clips)
}

export function switchClipVersion(
  comp: CueComp,
  clipId: string,
  takeId: string,
  takeDuration: number
): CueComp {
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0 || !Number.isFinite(takeDuration) || takeDuration < MIN_CLIP_SRC) return comp
  const c = norm.clips[i]
  if (!trackIsFree(norm, clipTrackId(c), c.start, c.start + takeDuration, clipId)) return norm

  let fadeIn = clamp(Math.max(0, c.edits.fadeIn.duration), 0, takeDuration)
  let fadeOut = clamp(Math.max(0, c.edits.fadeOut.duration), 0, takeDuration)
  if (fadeIn + fadeOut > takeDuration) fadeOut = Math.max(0, takeDuration - fadeIn)

  const { gainEnvelope: _drop, ...edits } = c.edits
  const clips = [...norm.clips]
  clips[i] = {
    ...c,
    sourceTakeId: takeId,
    srcIn: 0,
    srcOut: takeDuration,
    edits: {
      ...edits,
      timeStretch: 1,
      fadeIn: { ...c.edits.fadeIn, duration: fadeIn },
      fadeOut: { ...c.edits.fadeOut, duration: fadeOut },
    },
  }
  return withClips(norm, clips)
}

export function compDelta(comp: CueComp | undefined, originalDuration: number): number | null {
  if (!comp || comp.clips.length === 0) return null
  if (!Number.isFinite(originalDuration) || originalDuration <= 0) return null
  return compDuration(comp) - originalDuration
}

export const SPEED_MIN = 0.25
export const SPEED_MAX = 4
export const GAIN_MIN_DB = -60
export const GAIN_MAX_DB = 24

export function setClipEdits(comp: CueComp, clipId: string, patch: Partial<ClipEdits>): CueComp {
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0) return comp
  const c = norm.clips[i]
  const merged: ClipEdits = { ...c.edits, ...patch }

  const srcLen = c.srcOut - c.srcIn
  const nextStart = siblings(norm, clipId)?.next?.start ?? Infinity
  const room = nextStart - c.start
  const lo = Math.max(SPEED_MIN, Number.isFinite(room) && room > 0 ? srcLen / room : 0)
  const hi = Math.max(lo, SPEED_MAX)
  const speed = clamp(clipSpeed(merged), lo, hi)

  const tl = srcLen / speed
  let fadeIn = clamp(Math.max(0, merged.fadeIn.duration), 0, tl)
  let fadeOut = clamp(Math.max(0, merged.fadeOut.duration), 0, tl)
  if (fadeIn + fadeOut > tl) {
    if (patch.fadeIn !== undefined) fadeOut = Math.max(0, tl - fadeIn)
    else fadeIn = Math.max(0, tl - fadeOut)
  }

  const edits: ClipEdits = {
    ...merged,
    gainDb: clamp(Number.isFinite(merged.gainDb) ? merged.gainDb : 0, GAIN_MIN_DB, GAIN_MAX_DB),
    timeStretch: speed,
    fadeIn: { ...merged.fadeIn, duration: fadeIn },
    fadeOut: { ...merged.fadeOut, duration: fadeOut },
  }

  const fx = sanitizeEffects(merged.effects)
  if (fx) edits.effects = fx
  else delete edits.effects
  const clips = [...norm.clips]
  clips[i] = { ...c, edits }
  return withClips(norm, clips)
}

export function replaceClipSource(
  comp: CueComp,
  clipId: string,
  takeId: string,
  takeDuration: number
): CueComp {
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0) return comp
  if (!Number.isFinite(takeDuration) || takeDuration < MIN_CLIP_SRC) return comp

  const c = norm.clips[i]
  const delta = takeDuration - clipTimelineDuration(c)

  let fadeIn = clamp(Math.max(0, c.edits.fadeIn.duration), 0, takeDuration)
  let fadeOut = clamp(Math.max(0, c.edits.fadeOut.duration), 0, takeDuration)
  if (fadeIn + fadeOut > takeDuration) fadeOut = Math.max(0, takeDuration - fadeIn)

  const clips = norm.clips.map((x, j) => {
    if (j < i) return x
    if (j > i) return { ...x, start: Math.max(0, x.start + delta) }
    return {
      ...x,
      sourceTakeId: takeId,
      srcIn: 0,
      srcOut: takeDuration,
      edits: {
        ...x.edits,
        timeStretch: 1,
        fadeIn: { ...x.edits.fadeIn, duration: fadeIn },
        fadeOut: { ...x.edits.fadeOut, duration: fadeOut },
        ...(x.edits.gainEnvelope ? { gainEnvelope: undefined } : {}),
      },
    }
  })
  return withClips(norm, clips)
}

export type ClipEdge = 'start' | 'end'

export function trimClipEdge(
  comp: CueComp,
  clipId: string,
  edge: ClipEdge,
  delta: number,
  sourceDuration = Infinity
): CueComp {
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0 || !Number.isFinite(delta)) return comp
  const c = norm.clips[i]
  const speed = clipSpeed(c.edits)
  const maxSrc = Number.isFinite(sourceDuration) && sourceDuration > 0 ? sourceDuration : Infinity

  const row = siblings(norm, clipId)
  const clips = [...norm.clips]
  if (edge === 'start') {
    const prevEnd = row?.prev ? clipEnd(row.prev) : 0
    const loByStart = Math.max(prevEnd - c.start, -c.srcIn / speed)
    const hi = (c.srcOut - MIN_CLIP_SRC - c.srcIn) / speed
    const d = clamp(delta, Math.min(loByStart, hi), hi)
    clips[i] = { ...c, start: c.start + d, srcIn: c.srcIn + d * speed }
  } else {
    const nextStart = row?.next?.start ?? Infinity
    const lo = (c.srcIn + MIN_CLIP_SRC - c.srcOut) / speed
    const hiBySource = (maxSrc - c.srcOut) / speed
    const hiByNeighbour = nextStart - clipEnd(c)
    const hi = Math.max(lo, Math.min(hiBySource, hiByNeighbour))
    const d = clamp(delta, lo, hi)
    clips[i] = { ...c, srcOut: c.srcOut + d * speed }
  }
  return withClips(norm, clips)
}
