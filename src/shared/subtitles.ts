const BOUNDARY = /([.!?…]+)(\s+)/g

export function splitSentences(text: string): string[] {
  const out: string[] = []
  let at = 0
  BOUNDARY.lastIndex = 0
  for (let m = BOUNDARY.exec(text); m; m = BOUNDARY.exec(text)) {
    const end = m.index + m[1].length
    const piece = text.slice(at, end).trim()
    if (piece) out.push(piece)
    at = end + m[2].length
  }
  const tail = text.slice(at).trim()
  if (tail) out.push(tail)
  return out
}

export function sentenceIndexAt(sentences: string[], t: number, duration: number): number {
  if (sentences.length === 0) return -1
  if (!(duration > 0) || !Number.isFinite(t)) return 0
  const total = sentences.reduce((n, s) => n + s.length, 0)
  if (total === 0) return 0
  const wanted = (Math.min(Math.max(t, 0), duration) / duration) * total
  let seen = 0
  for (let i = 0; i < sentences.length; i++) {
    seen += sentences[i].length
    if (wanted < seen) return i
  }
  return sentences.length - 1
}

export interface Subtitle {
  original: string
  translation: string
}

export function subtitleAt(
  sourceText: string,
  text: string,
  t: number,
  duration: number
): Subtitle | null {
  const originals = splitSentences(sourceText)
  const i = sentenceIndexAt(originals, t, duration)
  if (i < 0) return null
  const translations = splitSentences(text)
  return {
    original: originals[i],
    translation: translations.length > 0 ? translations[Math.min(i, translations.length - 1)] : '',
  }
}

export function mapToOriginal(pos: number, playedDuration: number, referenceDuration: number): number {
  if (!(playedDuration > 0) || !(referenceDuration > 0)) return pos
  return (Math.max(0, pos) / playedDuration) * referenceDuration
}
