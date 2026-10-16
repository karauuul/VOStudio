import { describe, expect, it } from 'vitest'
import { LOOP_AHEAD, nextPassAt, resumeAt } from '../src/shared/resume'

const clip = (dur: number) => ({ dur, end: dur, from: 0 })

describe('resume position', () => {
  it('plays from where a pause left the playhead', () => {
    expect(resumeAt(3.2, clip(10), true)).toBe(3.2)
    expect(resumeAt(0, clip(10), true)).toBe(0)
    expect(resumeAt(9.9, clip(10), true)).toBe(9.9)
  })

  it('rewinds only when the playhead already sits at the end', () => {
    expect(resumeAt(10, clip(10), true)).toBe(0)
    expect(resumeAt(9.99, clip(10), true)).toBe(0)
    expect(resumeAt(9.97, clip(10), true)).toBe(9.97)
  })

  it('keeps the position when the caller is seeking, not resuming', () => {
    expect(resumeAt(10, clip(10), false)).toBe(10)
    expect(resumeAt(9.995, clip(10), false)).toBe(9.995)
  })

  it('clamps outside the clip', () => {
    expect(resumeAt(-4, clip(10), false)).toBe(0)
    expect(resumeAt(42, clip(10), false)).toBe(10)
  })

  it('resumes inside a region and rewinds to its in point', () => {
    const region = { dur: 10, end: 6, from: 2 }
    expect(resumeAt(4, region, true)).toBe(4)
    expect(resumeAt(6, region, true)).toBe(2)
    expect(resumeAt(8, region, true)).toBe(2)
    expect(resumeAt(8, region, false)).toBe(8)
  })
})

describe('loop pass schedule', () => {
  const first = { at: 0.06, startPos: 0, stopAt: 1 }
  const end = first.at + (first.stopAt - first.startPos)

  it('waits until the pass end is within the lookahead', () => {
    expect(nextPassAt(0.5, end)).toBeNull()
    expect(nextPassAt(end - LOOP_AHEAD - 0.001, end)).toBeNull()
  })

  it('starts the next pass exactly where the previous one ends', () => {
    expect(nextPassAt(end - LOOP_AHEAD, end)).toBe(1.06)
    expect(nextPassAt(1.04, end)).toBe(1.06)
  })

  it('chains passes on the audio clock without drift', () => {
    let at = first.at
    for (let k = 0; k < 100; k++) {
      const next = nextPassAt(at + 1 - 0.05, at + 1)
      expect(next).not.toBeNull()
      at = next as number
    }
    expect(at).toBeCloseTo(100.06, 9)
  })

  it('never schedules into the past when the clock overran the boundary', () => {
    expect(nextPassAt(1.1, end)).toBe(1.1)
  })
})
