import { liveTakes, type Cue, type Project, type Term } from './domain'
import { originalLength } from './export-plan'
import { matchTerms, stem } from './prompt'

export const TEXT_MATCH_MIN = 0.5
export const TEXT_MATCH_MARGIN = 0.05
export const FALLBACK_CHARS_PER_SECOND = 14
export const MEMORY_MIN = 0.3
export const MEMORY_SIZE = 3
export const NEIGHBOURS = 2

export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function trigrams(text: string): Set<string> {
  const normalized = normalizeText(text)
  const grams = new Set<string>()
  if (!normalized) return grams
  const padded = ` ${normalized} `
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3))
  return grams
}

export function similarity(a: string, b: string): number {
  const x = trigrams(a)
  const y = trigrams(b)
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const gram of x) if (y.has(gram)) shared++
  return (2 * shared) / (x.size + y.size)
}

export interface Ranked {
  index: number
  score: number
}

export type SimilarityQuery = (text: string) => Ranked[]

export function similarityIndex(texts: string[]): SimilarityQuery {
  const sizes: number[] = []
  const postings = new Map<string, number[]>()
  texts.forEach((text, index) => {
    const grams = trigrams(text)
    sizes.push(grams.size)
    for (const gram of grams) {
      const list = postings.get(gram)
      if (list) list.push(index)
      else postings.set(gram, [index])
    }
  })
  return (text) => {
    const grams = trigrams(text)
    const shared = new Map<number, number>()
    for (const gram of grams) {
      for (const index of postings.get(gram) ?? []) shared.set(index, (shared.get(index) ?? 0) + 1)
    }
    return [...shared]
      .map(([index, count]) => ({ index, score: (2 * count) / (grams.size + sizes[index]) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
  }
}

export interface TextMatchReport {
  matched: { index: number; cueId: string; key: string; score: number }[]
  ambiguous: { index: number; candidates: string[] }[]
  unmatched: number[]
}

const rounded = (score: number): number => Math.round(score * 1000) / 1000

export function matchRowsByText(cues: Pick<Cue, 'id' | 'key' | 'sourceText'>[], rows: string[][], column: number): TextMatchReport {
  const candidates = cues.filter((cue) => normalizeText(cue.sourceText))
  const query = similarityIndex(candidates.map((cue) => cue.sourceText))
  const report: TextMatchReport = { matched: [], ambiguous: [], unmatched: [] }
  const tentative: { index: number; cue: number; score: number }[] = []
  rows.forEach((cells, index) => {
    const ranked = query((cells[column] ?? '').trim())
    const best = ranked[0]
    if (!best || best.score < TEXT_MATCH_MIN) {
      report.unmatched.push(index)
      return
    }
    const close = ranked.filter((r) => best.score - r.score < TEXT_MATCH_MARGIN)
    if (close.length > 1) report.ambiguous.push({ index, candidates: close.map((r) => candidates[r.index].key) })
    else tentative.push({ index, cue: best.index, score: best.score })
  })
  const claimed = new Set<number>()
  for (const t of [...tentative].sort((a, b) => b.score - a.score || a.index - b.index)) {
    const cue = candidates[t.cue]
    if (claimed.has(t.cue)) {
      report.ambiguous.push({ index: t.index, candidates: [cue.key] })
      continue
    }
    claimed.add(t.cue)
    report.matched.push({ index: t.index, cueId: cue.id, key: cue.key, score: rounded(t.score) })
  }
  report.matched.sort((a, b) => a.index - b.index)
  report.ambiguous.sort((a, b) => a.index - b.index)
  return report
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function speakingRate(cues: Cue[], characterId: string): number {
  const rates = cues
    .filter((cue) => cue.characterId === characterId)
    .flatMap(liveTakes)
    .filter((take) => take.kind === 'tts' && take.duration > 0 && (take.meta.text ?? '').trim())
    .map((take) => (take.meta.text ?? '').trim().length / take.duration)
  return rates.length > 0 ? median(rates) : FALLBACK_CHARS_PER_SECOND
}

const termKey = (term: string): string => term.trim().toLowerCase()

export function upsertTerms(current: Term[], rows: Term[]): Term[] {
  const out = [...current]
  for (const row of rows) {
    const at = out.findIndex((t) => termKey(t.term) === termKey(row.term))
    if (at >= 0) out[at] = row
    else out.push(row)
  }
  return out
}

export function removeTerms(current: Term[], names: string[]): Term[] {
  const gone = new Set(names.map(termKey))
  return current.filter((t) => !gone.has(termKey(t.term)))
}

export interface GlossaryIssue {
  cue: Cue
  missing: Term[]
}

const contains = (text: string, word: string): boolean => {
  const needle = stem(word.trim())
  return !!needle && text.toLowerCase().includes(needle)
}

export function glossaryIssues(terms: Term[], cues: Cue[]): GlossaryIssue[] {
  const issues: GlossaryIssue[] = []
  for (const cue of cues) {
    if (!cue.text.trim()) continue
    const missing = terms.filter((t) => contains(cue.sourceText, t.term) && !contains(cue.text, t.translation))
    if (missing.length > 0) issues.push({ cue, missing })
  }
  return issues
}

const brief = (cue: Cue): Record<string, string> => ({ key: cue.key, sourceText: cue.sourceText, text: cue.text })

export function translationContext(project: Pick<Project, 'cues' | 'characters' | 'terms'>, page: Cue[]): Record<string, unknown>[] {
  const position = new Map(project.cues.map((cue, i) => [cue.id, i]))
  const memory = project.cues.filter((cue) => cue.text.trim() && normalizeText(cue.sourceText))
  const query = similarityIndex(memory.map((cue) => cue.sourceText))
  const rates = new Map<string, number>()
  const rateOf = (characterId: string): number => {
    const known = rates.get(characterId)
    if (known !== undefined) return known
    const rate = speakingRate(project.cues, characterId)
    rates.set(characterId, rate)
    return rate
  }
  return page.map((cue) => {
    const at = position.get(cue.id) ?? 0
    const duration = originalLength(cue)
    const rate = rateOf(cue.characterId)
    return {
      key: cue.key,
      id: cue.id,
      character: project.characters.find((c) => c.id === cue.characterId)?.name ?? null,
      sourceText: cue.sourceText,
      text: cue.text,
      ...(cue.suggestedText === undefined ? {} : { suggestedText: cue.suggestedText }),
      neighbours: project.cues
        .slice(Math.max(0, at - NEIGHBOURS), at + NEIGHBOURS + 1)
        .filter((other) => other.id !== cue.id)
        .map(brief),
      duration: duration ?? null,
      charsPerSecond: Math.round(rate * 10) / 10,
      budget: duration === undefined ? null : Math.round(duration * rate),
      terms: matchTerms(project.terms ?? [], cue.sourceText, cue.text),
      memory: query(cue.sourceText)
        .filter((r) => memory[r.index].id !== cue.id && r.score >= MEMORY_MIN)
        .slice(0, MEMORY_SIZE)
        .map((r) => ({ ...brief(memory[r.index]), score: rounded(r.score) })),
    }
  })
}
