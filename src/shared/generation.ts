import { emptyEdits, type Cue, type CueComp } from './domain'
import { clipText, placeClip, resolveTake, resolveTargetTrack, type TakeLookup } from './library'

export type GenTarget =
  | { kind: 'all' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'clip'; clipId: string; text: string }

export interface TextRange {
  start: number
  end: number
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD_CHAR.test(ch)

export function deriveGenTarget(
  clip: { clipId: string; text: string } | null,
  selection: TextRange | null
): GenTarget {
  if (clip) return { kind: 'clip', clipId: clip.clipId, text: clip.text }
  if (selection && selection.end > selection.start) {
    return { kind: 'range', start: selection.start, end: selection.end }
  }
  return { kind: 'all' }
}

export function findWholeWord(haystack: string, needle: string): TextRange | null {
  const wanted = needle.trim()
  if (!wanted || !haystack) return null
  const hay = haystack.toLowerCase()
  const q = wanted.toLowerCase()
  if (hay.length !== haystack.length || q.length !== wanted.length) return null
  for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + 1)) {
    const openBoundary = !isWordChar(q[0]) || !isWordChar(hay[at - 1])
    const closeBoundary = !isWordChar(q[q.length - 1]) || !isWordChar(hay[at + q.length])
    if (openBoundary && closeBoundary) return { start: at, end: at + q.length }
  }
  return null
}

export function targetRange(text: string, target: GenTarget): TextRange | null {
  if (target.kind === 'clip') return findWholeWord(text, target.text)
  if (target.kind === 'range') {
    const start = Math.max(0, Math.min(text.length, Math.trunc(target.start)))
    const end = Math.max(start, Math.min(text.length, Math.trunc(target.end)))
    return end > start ? { start, end } : null
  }
  return text.length > 0 ? { start: 0, end: text.length } : null
}

export function targetText(text: string, target: GenTarget): string {
  if (target.kind === 'clip') return target.text.trim()
  const range = targetRange(text, target)
  return range ? text.slice(range.start, range.end).trim() : ''
}

export function clipTargetText(
  project: TakeLookup | undefined,
  cue: Cue,
  clipId: string
): string {
  const clip = cue.comp?.clips.find((c) => c.id === clipId)
  if (!clip) return ''
  const found = resolveTake(project, cue, clip.sourceTakeId)
  return found ? clipText(found.take, clip.srcIn, clip.srcOut) : ''
}

export interface PlaceTakeRequest {
  comp?: CueComp
  takeId: string
  duration: number
  targetTrackId?: string
  playhead: number
  replaceClipId?: string
}

export function placeTake(req: PlaceTakeRequest): {
  comp: CueComp
  clipId: string
  trackId: string
} {
  const comp = req.comp ?? { clips: [] }
  return placeClip(comp, {
    duration: req.duration,
    targetTrackId: resolveTargetTrack(comp, req.targetTrackId),
    playhead: req.playhead,
    sourceTakeId: req.takeId,
    edits: emptyEdits(),
    ...(req.replaceClipId ? { replaceClipId: req.replaceClipId } : {}),
  })
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export const SPEED_MIN = 0.7
export const SPEED_MAX = 1.2

export const toPercent = (v: number): number => Math.round(clamp(v, 0, 1) * 100)

export const fromPercent = (n: number): number =>
  Number.isFinite(n) ? clamp(Math.round(n), 0, 100) / 100 : 0

export const clampSpeed = (v: number): number =>
  Number.isFinite(v) ? Math.round(clamp(v, SPEED_MIN, SPEED_MAX) * 100) / 100 : 1
