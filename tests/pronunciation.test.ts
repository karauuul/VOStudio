import { describe, expect, it } from 'vitest'
import { applyRules } from '../src/shared/pronunciation'
import { parseCsv, serializeCsv } from '../src/shared/csv'

describe('applyRules', () => {
  it('literal replace', () => {
    expect(applyRules('FICSIT дбає', 'FICSIT → Фіксіт')).toBe('Фіксіт дбає')
  })
  it('regex replace', () => {
    expect(applyRules('до 2 модулів', '/до (\\d+)/ → до $1x')).toBe('до 2x модулів')
  })
  it('skips comments and bad lines', () => {
    expect(applyRules('текст', '# comment\nбез стрілки\n')).toBe('текст')
  })
  it('invalid regex is ignored', () => {
    expect(applyRules('текст', '/[/ → x')).toBe('текст')
  })
})

describe('csv round-trip', () => {
  it('BOM + quotes + embedded newline survive', () => {
    const src = '﻿A,B\r\n"x,1","line1\nline2"\r\nplain,"q""q"\r\n'
    const parsed = parseCsv(src)
    expect(parsed.hadBom).toBe(true)
    expect(parsed.rows[0][1]).toBe('line1\nline2')
    expect(serializeCsv(parsed)).toBe(src)
  })
})
