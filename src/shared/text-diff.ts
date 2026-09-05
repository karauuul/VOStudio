export interface DiffPart {
  text: string
  changed: boolean
}

const tokenize = (s: string): string[] => s.split(/(\s+)/).filter((t) => t !== '')

export function diffWords(from: string, to: string): DiffPart[] {
  const a = tokenize(from)
  const b = tokenize(to)
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const parts: DiffPart[] = []
  const push = (text: string, changed: boolean): void => {
    const last = parts[parts.length - 1]
    if (last && last.changed === changed) last.text += text
    else parts.push({ text, changed })
  }

  let i = 0
  let j = 0
  while (j < m) {
    if (i < n && a[i] === b[j]) {
      push(b[j], false)
      i++
      j++
    } else if (i < n && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++
    } else {
      push(b[j], !/^\s+$/.test(b[j]))
      j++
    }
  }
  return parts
}
