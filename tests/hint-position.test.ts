import { describe, expect, it } from 'vitest'
import { hintPosition } from '../src/shared/hint-position'

const anchor = (left: number, top: number, w = 40, h = 24): {
  left: number
  right: number
  top: number
  bottom: number
} => ({ left, right: left + w, top, bottom: top + h })

describe('hintPosition', () => {
  it('sits below the control and centered when there is room', () => {
    expect(hintPosition(anchor(500, 300), 80, 20, 1400, 900)).toEqual({ left: 480, top: 328 })
  })

  it('flips above when the hint would overflow the bottom edge', () => {
    expect(hintPosition(anchor(500, 860), 80, 20, 1400, 900)).toEqual({ left: 480, top: 836 })
  })

  it('clamps at the right edge instead of overflowing', () => {
    expect(hintPosition(anchor(1340, 300), 120, 20, 1400, 900).left).toBe(1274)
  })

  it('clamps at the left edge', () => {
    expect(hintPosition(anchor(0, 300), 120, 20, 1400, 900).left).toBe(6)
  })

  it('keeps a flipped hint inside the top edge', () => {
    expect(hintPosition(anchor(500, 0, 40, 890), 80, 20, 1400, 900).top).toBe(6)
  })
})
