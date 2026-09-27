import { diffWords } from './text-diff'

export interface TranscriptMatch {
  similarity: number
  missing: string[]
  extra: string[]
}

const normalized = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const wordsOf = (text: string): string[] => text.split(' ').filter(Boolean)

const changedWords = (from: string, to: string): string[] =>
  diffWords(from, to)
    .filter((part) => part.changed)
    .flatMap((part) => wordsOf(part.text.trim()))

export function transcriptMatch(expected: string, heard: string): TranscriptMatch {
  const want = normalized(expected)
  const got = normalized(heard)
  const missing = changedWords(got, want)
  const extra = changedWords(want, got)
  const total = wordsOf(want).length + wordsOf(got).length
  const common = wordsOf(want).length - missing.length
  return { similarity: total === 0 ? 1 : Math.round((2 * common * 1000) / total) / 1000, missing, extra }
}

export const RENDER_NAME_MAX = 120
export const RENDER_ID_MAX = 64
export const RENDER_HASH_HEX = 16
export const PLAN_TIMEOUT_MS = 60_000
export const PLAN_JOB_TIMEOUT_MS = 60_000
export const MAX_TIMER_MS = 2_147_483_647

export function renderFileName(key: string, id: string, sha256Hex: (text: string) => string, suffix = ''): string {
  const safe = key
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, RENDER_NAME_MAX)
    .replace(/[. ]+$/, '')
    .trim()
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '_')
  const faithful = clean === id.toLowerCase() && clean.length <= RENDER_ID_MAX
  const tag = faithful ? clean : `${clean.slice(0, RENDER_ID_MAX)}~${sha256Hex(id).slice(0, RENDER_HASH_HEX)}`
  return `${safe || 'line'}-${tag}${suffix}.wav`
}

export const EXPORT_STALE = 'The project changed during the export; run export again'

export const LINE_CHANGED = 'The line changed while rendering; retry.'

export const revisionStale = (planned: number | undefined, current: number | undefined, own = 0): boolean =>
  planned !== undefined && planned + own !== current

export function requireRevision(planned: number, current: number): void {
  if (revisionStale(planned, current)) throw new Error(LINE_CHANGED)
}

export const planTimeoutMs = (jobs: number): number =>
  Math.min(PLAN_TIMEOUT_MS + PLAN_JOB_TIMEOUT_MS * jobs, MAX_TIMER_MS)
