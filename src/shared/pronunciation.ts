export function applyRules(text: string, rulesText: string): string {
  let out = text
  for (const raw of rulesText.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes(' → ')) continue
    const idx = line.indexOf(' → ')
    const find = line.slice(0, idx).trim()
    const repl = line.slice(idx + 3).trim()
    if (!find) continue
    const isRe = find.startsWith('/') && find.endsWith('/') && find.length > 2
    try {
      if (isRe) {
        out = out.replace(new RegExp(find.slice(1, -1), 'g'), repl)
      } else {
        out = out.split(find).join(repl)
      }
    } catch {
    }
  }
  return out
}
