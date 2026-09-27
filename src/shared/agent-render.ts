import { diffWords } from './text-diff'

export const TRANSCRIPT_WORDS_MAX = 600
export const TRANSCRIPT_TOO_LONG = `Line too long to verify word by word (over ${TRANSCRIPT_WORDS_MAX} words); similarity counts shared words only`

export interface TranscriptMatch {
  similarity: number
  missing: string[]
  extra: string[]
  note?: string
}

const normalized = (text: string): string =>
  text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const wordsOf = (text: string): string[] => text.split(' ').filter(Boolean)

const changedWords = (from: string, to: string): string[] =>
  diffWords(from, to)
    .filter((part) => part.changed)
    .flatMap((part) => wordsOf(part.text.trim()))

function sharedWords(a: string[], b: string[]): number {
  const counts = new Map<string, number>()
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1)
  let shared = 0
  for (const w of b) {
    const left = counts.get(w) ?? 0
    if (left === 0) continue
    counts.set(w, left - 1)
    shared++
  }
  return shared
}

export function transcriptMatch(expected: string, heard: string): TranscriptMatch {
  const want = normalized(expected)
  const got = normalized(heard)
  const wanted = wordsOf(want)
  const gotten = wordsOf(got)
  const total = wanted.length + gotten.length
  const similarity = (common: number): number => (total === 0 ? 1 : Math.round((2 * common * 1000) / total) / 1000)
  if (wanted.length > TRANSCRIPT_WORDS_MAX || gotten.length > TRANSCRIPT_WORDS_MAX) {
    return { similarity: similarity(sharedWords(wanted, gotten)), missing: [], extra: [], note: TRANSCRIPT_TOO_LONG }
  }
  const missing = changedWords(got, want)
  const extra = changedWords(want, got)
  return { similarity: similarity(wanted.length - missing.length), missing, extra }
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
