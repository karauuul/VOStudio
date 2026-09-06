import { describe, expect, it } from 'vitest'
import {
  mapToOriginal,
  sentenceIndexAt,
  splitSentences,
  subtitleAt,
} from '../src/shared/subtitles'

describe('splitSentences', () => {
  it('splits on a terminator followed by whitespace and keeps the terminator', () => {
    expect(splitSentences('HUB upgrade two is complete. Power and shell modules are ready.')).toEqual([
      'HUB upgrade two is complete.',
      'Power and shell modules are ready.',
    ])
  })

  it('handles ! ? and the ellipsis', () => {
    expect(splitSentences('Stop! Who goes there? Nobody… I hope.')).toEqual([
      'Stop!',
      'Who goes there?',
      'Nobody…',
      'I hope.',
    ])
  })

  it('keeps a run of terminators together', () => {
    expect(splitSentences('What?! Really.')).toEqual(['What?!', 'Really.'])
  })

  it('is naive about abbreviations: Dr. Smith splits', () => {
    expect(splitSentences('Dr. Smith left.')).toEqual(['Dr.', 'Smith left.'])
  })

  it('a terminator with no whitespace after it does not split', () => {
    expect(splitSentences('version 2.5 is out')).toEqual(['version 2.5 is out'])
  })

  it('drops empty pieces and trims', () => {
    expect(splitSentences('   ')).toEqual([])
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('  One.   Two.  ')).toEqual(['One.', 'Two.'])
  })

  it('text without a terminator is one sentence', () => {
    expect(splitSentences('no terminator here')).toEqual(['no terminator here'])
  })
})

describe('sentenceIndexAt', () => {
  const two = ['aaaa.', 'bbbb.']

  it('maps proportionally along the duration by character weight', () => {
    expect(sentenceIndexAt(two, 0, 10)).toBe(0)
    expect(sentenceIndexAt(two, 4.9, 10)).toBe(0)
    expect(sentenceIndexAt(two, 5.1, 10)).toBe(1)
    expect(sentenceIndexAt(two, 10, 10)).toBe(1)
  })

  it('weights a long sentence over a short one', () => {
    const uneven = ['a.', 'bbbbbbbbbbbbbbbbbb.']
    expect(sentenceIndexAt(uneven, 2, 10)).toBe(1)
  })

  it('clamps outside the duration and survives a zero duration', () => {
    expect(sentenceIndexAt(two, -5, 10)).toBe(0)
    expect(sentenceIndexAt(two, 99, 10)).toBe(1)
    expect(sentenceIndexAt(two, 3, 0)).toBe(0)
    expect(sentenceIndexAt(two, NaN, 10)).toBe(0)
  })

  it('no sentences means no index', () => {
    expect(sentenceIndexAt([], 1, 10)).toBe(-1)
  })
})

describe('subtitleAt', () => {
  const original = 'One. Two. Three.'

  it('pairs sentence k of the original with sentence k of the translation', () => {
    expect(subtitleAt(original, 'Раз. Два. Три.', 0.5, 3)).toEqual({
      original: 'One.',
      translation: 'Раз.',
    })
    expect(subtitleAt(original, 'Раз. Два. Три.', 2.9, 3)).toEqual({
      original: 'Three.',
      translation: 'Три.',
    })
  })

  it('falls back to the last translation sentence when there are fewer', () => {
    expect(subtitleAt(original, 'Раз. Два.', 2.9, 3)?.translation).toBe('Два.')
  })

  it('an empty translation leaves the second line empty', () => {
    expect(subtitleAt(original, '', 1, 3)?.translation).toBe('')
  })

  it('no original text means no subtitle', () => {
    expect(subtitleAt('', 'Раз.', 1, 3)).toBeNull()
  })
})

describe('mapToOriginal', () => {
  it('maps a composition playhead onto the original duration', () => {
    expect(mapToOriginal(2, 4, 8)).toBe(4)
    expect(mapToOriginal(0, 4, 8)).toBe(0)
  })

  it('passes the position through when either duration is missing', () => {
    expect(mapToOriginal(2, 0, 8)).toBe(2)
    expect(mapToOriginal(2, 4, 0)).toBe(2)
  })
})
