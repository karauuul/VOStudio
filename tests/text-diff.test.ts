import { describe, expect, it } from 'vitest'
import { diffWords } from '../src/shared/text-diff'

const join = (from: string, to: string): string =>
  diffWords(from, to)
    .map((p) => p.text)
    .join('')

const changed = (from: string, to: string): string[] =>
  diffWords(from, to)
    .filter((p) => p.changed)
    .map((p) => p.text)

describe('diffWords', () => {
  it('identical text has no changed part', () => {
    const parts = diffWords('Вітаємо, першопрохідцю.', 'Вітаємо, першопрохідцю.')
    expect(parts).toEqual([{ text: 'Вітаємо, першопрохідцю.', changed: false }])
  })

  it('marks only the substituted word', () => {
    expect(changed('FICSIT дбає про вас', 'Фіксіт дбає про вас')).toEqual(['Фіксіт'])
  })

  it('marks an inserted word without shifting the rest', () => {
    expect(changed('до 2 модулів', 'до 2 x модулів')).toEqual(['x'])
  })

  it('a word with attached punctuation is one changed token', () => {
    expect(changed('hello world.', 'hello worlds.')).toEqual(['worlds.'])
  })

  it('every differing word is marked, the space between them is not', () => {
    expect(changed('a b', 'c d')).toEqual(['c', 'd'])
  })

  it('whitespace alone is never emphasised', () => {
    expect(changed('one two', 'one  two')).toEqual([])
  })

  it('empty target produces no parts', () => {
    expect(diffWords('a b', '')).toEqual([])
  })

  it('parts always reconstruct the target exactly', () => {
    const cases: [string, string][] = [
      ['one two three', 'one  two three'],
      ['', 'brand new text'],
      ['keep this', 'keep that too'],
      ['  padded ', ' padded'],
    ]
    for (const [from, to] of cases) expect(join(from, to)).toBe(to)
  })
})
