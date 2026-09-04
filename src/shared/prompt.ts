import type { Cue, Project, Term } from './domain'

export function stem(word: string): string {
  const lower = word.toLowerCase()
  return lower.length > 5 ? lower.slice(0, -2) : lower
}

export function matchTerms(terms: Term[], sourceText: string, translation: string): Term[] {
  const src = sourceText.toLowerCase()
  const tr = translation.toLowerCase()
  return terms.filter((t) => {
    const a = stem(t.term)
    const b = stem(t.translation)
    return (!!a && src.includes(a)) || (!!b && tr.includes(b))
  })
}

export function highlightRanges(
  text: string,
  needles: string[]
): { start: number; end: number }[] {
  const hay = text.toLowerCase()
  const found: { start: number; end: number }[] = []
  for (const needle of needles) {
    const s = stem(needle)
    if (!s) continue
    for (let i = hay.indexOf(s); i !== -1; i = hay.indexOf(s, i + s.length)) {
      let end = i + s.length
      while (end < hay.length && /\p{L}/u.test(hay[end])) end++
      found.push({ start: i, end })
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: { start: number; end: number }[] = []
  for (const r of found) {
    if (out.length === 0 || r.start >= out[out.length - 1].end) out.push(r)
  }
  return out
}

export function buildPrompt(project: Pick<Project, 'terms' | 'characters'>, cue: Cue): string {
  const character = project.characters.find((c) => c.id === cue.characterId)
  const lines = [`Character: ${character?.name ?? 'Unassigned'}`, `Source: ${cue.sourceText}`]
  if (cue.text) lines.push(`Translation: ${cue.text}`)
  if (cue.referenceDuration !== undefined) {
    lines.push(`Duration: ${cue.referenceDuration.toFixed(1)}s`)
  }
  const matched = matchTerms(project.terms ?? [], cue.sourceText, cue.text)
  if (matched.length > 0) {
    lines.push('Terms:')
    for (const t of matched) {
      lines.push(`- ${t.term} = ${t.translation}${t.note ? ` (${t.note})` : ''}`)
    }
  }
  if (cue.notes) lines.push(`Notes: ${cue.notes}`)
  return lines.join('\n')
}
