import {
  clipSpeed,
  emptyEdits,
  envelopeDbAt,
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

export function compEffectsTail(clips: readonly CompClip[]): number {
  const total = compDuration({ clips: [...clips] })
  let end = total
  for (const c of clips) {
    const tail = effectsTail(c.edits.effects)
    if (tail <= 0) continue
    const e = clipEnd(c) + tail
    if (e > end) end = e
  }
  return Math.max(0, end - total)
}

export function compHasReverb(clips: readonly CompClip[]): boolean {
  return clips.some((c) => !!c.edits.effects?.reverb)
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
  return normalizeComp(comp.region ? { clips, region: comp.region } : { clips })
}

export function normalizeComp(comp: CueComp): CueComp {
  const clips = comp.clips
    .filter((c) => clipTimelineDuration(c) > 0 && Number.isFinite(c.start))
    .map((c) => ({ ...c, start: Math.max(0, c.start) }))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
  const region = normalizeRegion(comp.region, compDuration({ clips }))
  return region ? { clips, region } : { clips }
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
  const sorted = [...comp.clips].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < clipEnd(sorted[i - 1]) - COMP_EPS) {
      return `clips "${sorted[i - 1].id}" and "${sorted[i].id}" overlap`
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
    return normalizeComp({ clips: comp.clips })
  }
  const lo = Math.min(region.in, region.out)
  const hi = Math.max(region.in, region.out)
  return normalizeComp({ clips: comp.clips, region: { in: lo, out: hi } })
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
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0 || i >= norm.clips.length - 1) return 0
  return crossfadeRoom(norm.clips[i], norm.clips[i + 1])
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
  const i = indexOf(norm, clipId)
  if (i < 0 || i >= norm.clips.length - 1 || !Number.isFinite(seconds)) return comp
  const c = norm.clips[i]
  const room = crossfadeRoom(c, norm.clips[i + 1])
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
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => clips[a].start - clips[b].start || clips[a].id.localeCompare(clips[b].id)
  )
  const outXf = new Array<number>(n).fill(0)
  for (let k = 0; k + 1 < n; k++) {
    outXf[order[k]] = effectiveCrossfade(clips[order[k]], clips[order[k + 1]])
  }
  const plan = new Array<CompRenderClip>(n)
  for (let k = 0; k < n; k++) {
    const i = order[k]
    const c = clips[i]
    const inXf = k > 0 ? outXf[order[k - 1]] : 0
    plan[i] = {
      clip:
        inXf > 0
          ? { ...c, start: c.start - inXf, srcIn: c.srcIn - inXf * clipSpeed(c.edits) }
          : c,
      crossfadeIn: inXf,
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
  const i = indexOf(norm, leftClipId)
  if (i < 0 || i >= norm.clips.length - 1) return null
  const left = norm.clips[i]
  const right = norm.clips[i + 1]
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
  const i = indexOf(norm, left.id)

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

  const clips = [...norm.clips]
  clips.splice(i, 2, merged)
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

export function moveClip(comp: CueComp, clipId: string, newStart: number): CueComp {
  const norm = normalizeComp(comp)
  const i = indexOf(norm, clipId)
  if (i < 0 || !Number.isFinite(newStart)) return comp
  const c = norm.clips[i]
  const tl = clipTimelineDuration(c)
  const lo = i > 0 ? clipEnd(norm.clips[i - 1]) : 0
  const hiRaw = i < norm.clips.length - 1 ? norm.clips[i + 1].start - tl : Infinity
  const hi = Math.max(lo, hiRaw)
  const start = clamp(newStart, lo, hi)
  if (start === c.start) return norm
  const clips = [...norm.clips]
  clips[i] = { ...c, start }
  return withClips(norm, clips)
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
  const nextStart = i < norm.clips.length - 1 ? norm.clips[i + 1].start : Infinity
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

  const clips = [...norm.clips]
  if (edge === 'start') {
    const prevEnd = i > 0 ? clipEnd(norm.clips[i - 1]) : 0
    const loByStart = Math.max(prevEnd - c.start, -c.srcIn / speed)
    const hi = (c.srcOut - MIN_CLIP_SRC - c.srcIn) / speed
    const d = clamp(delta, Math.min(loByStart, hi), hi)
    clips[i] = { ...c, start: c.start + d, srcIn: c.srcIn + d * speed }
  } else {
    const nextStart = i < norm.clips.length - 1 ? norm.clips[i + 1].start : Infinity
    const lo = (c.srcIn + MIN_CLIP_SRC - c.srcOut) / speed
    const hiBySource = (maxSrc - c.srcOut) / speed
    const hiByNeighbour = nextStart - clipEnd(c)
    const hi = Math.max(lo, Math.min(hiBySource, hiByNeighbour))
    const d = clamp(delta, lo, hi)
    clips[i] = { ...c, srcOut: c.srcOut + d * speed }
  }
  return withClips(norm, clips)
}
