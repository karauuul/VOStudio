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
export const RENDER_ID_CHARS = 8
export const PLAN_TIMEOUT_MS = 60_000
export const PLAN_JOB_TIMEOUT_MS = 60_000
export const MAX_TIMER_MS = 2_147_483_647

export function renderFileName(key: string, id: string, suffix = ''): string {
  const safe = key
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, RENDER_NAME_MAX)
    .replace(/[. ]+$/, '')
    .trim()
  const tag = id.slice(0, RENDER_ID_CHARS).replace(/[^A-Za-z0-9_-]/g, '_')
  return `${safe || 'line'}-${tag}${suffix}.wav`
}

export const planTimeoutMs = (jobs: number): number =>
  Math.min(PLAN_TIMEOUT_MS + PLAN_JOB_TIMEOUT_MS * jobs, MAX_TIMER_MS)
