import { describe, expect, it } from 'vitest'
import { METER_FLOOR_DB, meterFill, parseMonitorGain } from '../src/shared/meter'

const fromDb = (db: number): number => 10 ** (db / 20)

describe('meterFill', () => {
  it('maps peak level to a dBFS scale from the floor to full scale', () => {
    expect(meterFill(1)).toBe(1)
    expect(meterFill(fromDb(METER_FLOOR_DB))).toBeCloseTo(0)
    expect(meterFill(fromDb(-10))).toBeCloseTo(50 / 60)
    expect(meterFill(fromDb(-30))).toBeCloseTo(0.5)
  })

  it('stays empty below the floor and for silence or garbage', () => {
    for (const v of [0, -0.5, Number.NaN, fromDb(-90)]) expect(meterFill(v)).toBe(0)
  })

  it('stays full above full scale', () => {
    expect(meterFill(1.5)).toBe(1)
    expect(meterFill(Infinity)).toBe(1)
  })
})

describe('parseMonitorGain', () => {
  it('starts at full gain when nothing is stored', () => {
    expect(parseMonitorGain(null)).toBe(1)
    expect(parseMonitorGain('')).toBe(1)
  })

  it('keeps a stored gain including a deliberate zero', () => {
    expect(parseMonitorGain('0')).toBe(0)
    expect(parseMonitorGain('0.5')).toBe(0.5)
    expect(parseMonitorGain('1')).toBe(1)
  })

  it('falls back to full gain for garbage or out-of-range values', () => {
    for (const v of ['abc', '2', '-1', 'NaN', 'Infinity']) expect(parseMonitorGain(v)).toBe(1)
  })
})
