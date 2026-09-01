import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseCsv, serializeCsv, setCell } from '../src/shared/csv'

const CSV_PATH = join(__dirname, 'fixtures', 'sample_vo_table.csv')

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

function context(s: string, at: number): string {
  return JSON.stringify(s.slice(Math.max(0, at - 60), at + 60))
}

describe('master_vo_table.csv golden round-trip', () => {
  const raw = readFileSync(CSV_PATH, 'utf-8')

  it('parse → serialize === original (byte-for-byte)', () => {
    const parsed = parseCsv(raw)
    const out = serializeCsv(parsed)
    const at = firstDiff(raw, out)
    if (at !== -1) {
      throw new Error(
        `Round-trip diverged at index ${at} (len ${raw.length} vs ${out.length})\n` +
          `expected: ${context(raw, at)}\n` +
          `actual:   ${context(out, at)}`
      )
    }
    expect(out).toBe(raw)
  })

  it('the file is genuinely non-trivial', () => {
    const parsed = parseCsv(raw)
    expect(parsed.headers).toContain('WemId')
    expect(parsed.headers).toContain('UkrText')
    expect(parsed.rows.length).toBeGreaterThan(700)
  })

  it('setCell changes EXACTLY one line', () => {
    const parsed = parseCsv(raw)
    const rowIdx = 0
    const colIdx = parsed.headers.indexOf('UkrText')
    expect(colIdx).toBeGreaterThanOrEqual(0)

    const changed = setCell(parsed, rowIdx, colIdx, 'ТЕСТ, з комою і "лапками"')
    expect(changed).toBe(true)

    const out = serializeCsv(parsed)
    const before = raw.split(parsed.newline)
    const after = out.split(parsed.newline)
    expect(after.length).toBe(before.length)

    const diffLines = before
      .map((l, i) => (l === after[i] ? -1 : i))
      .filter((i) => i !== -1)
    expect(diffLines).toEqual([rowIdx + 1])
    expect(after[rowIdx + 1]).toContain('"ТЕСТ, з комою і ""лапками"""')
  })

  it('a repeat setCell with the same value does not count as a change', () => {
    const parsed = parseCsv(raw)
    const colIdx = parsed.headers.indexOf('UkrText')
    const cur = parsed.rows[0][colIdx]
    expect(setCell(parsed, 0, colIdx, cur)).toBe(false)
    expect(serializeCsv(parsed)).toBe(raw)
  })
})

describe('malformed CSV', () => {
  it('throws when the file ends inside a quoted field', () => {
    expect(() => parseCsv('a,b\r\n1,"never closed\r\n')).toThrow('unterminated quoted field')
    expect(() => parseCsv('a,b\r\n1,"x""y\r\n')).toThrow('unterminated quoted field')
  })

  it('accepts a quoted field that closes at EOF without a newline', () => {
    expect(parseCsv('a,b\r\n1,"closed"').rows[0]).toEqual(['1', 'closed'])
  })
})
