import { describe, expect, it } from 'vitest'
import { emptyEdits, type Cue, type CueComp } from '../src/shared/domain'
import { externalChanges, pickHistory, redoStale, takeKey } from '../src/shared/undo-route'

describe('undo routing between comp and take-effect histories', () => {
  it('undoes the newer entry first', () => {
    expect(pickHistory({ comp: 10, fx: 20 }, 'undo')).toBe('fx')
    expect(pickHistory({ comp: 30, fx: 20 }, 'undo')).toBe('comp')
  })

  it('redoes the older entry first', () => {
    expect(pickHistory({ comp: 10, fx: 20 }, 'redo')).toBe('comp')
    expect(pickHistory({ comp: 30, fx: 20 }, 'redo')).toBe('fx')
  })

  it('falls back to the non-empty history', () => {
    expect(pickHistory({ comp: null, fx: 5 }, 'undo')).toBe('fx')
    expect(pickHistory({ comp: 5, fx: null }, 'undo')).toBe('comp')
    expect(pickHistory({ comp: null, fx: 5 }, 'redo')).toBe('fx')
    expect(pickHistory({ comp: 5, fx: null }, 'redo')).toBe('comp')
  })

  it('returns null when both are empty', () => {
    expect(pickHistory({ comp: null, fx: null }, 'undo')).toBe(null)
    expect(pickHistory({ comp: null, fx: null }, 'redo')).toBe(null)
  })

  it('resolves ties to comp in both directions', () => {
    expect(pickHistory({ comp: 7, fx: 7 }, 'undo')).toBe('comp')
    expect(pickHistory({ comp: 7, fx: 7 }, 'redo')).toBe('comp')
  })

  it('marks a redo entry stale once the other history committed after it', () => {
    expect(redoStale(20, 30)).toBe(true)
    expect(redoStale(30, 20)).toBe(false)
    expect(redoStale(20, 20)).toBe(false)
    expect(redoStale(null, 30)).toBe(false)
    expect(redoStale(20, null)).toBe(false)
  })

  it('replays an interleaved session in order', () => {
    const comp = [1, 3]
    const fx = [2]
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      const side = pickHistory(
        { comp: comp[comp.length - 1] ?? null, fx: fx[fx.length - 1] ?? null },
        'undo'
      )
      if (side === 'comp') order.push(`comp${comp.pop()}`)
      else if (side === 'fx') order.push(`fx${fx.pop()}`)
    }
    expect(order).toEqual(['comp3', 'fx2', 'comp1'])
  })
})

describe('external changes that invalidate local undo', () => {
  const comp = (start: number): CueComp => ({ clips: [{ id: 'k', sourceTakeId: 't', srcIn: 0, srcOut: 1, start, edits: emptyEdits() }] })
  const line = (id: string, extra: Partial<Cue> = {}): Cue => ({
    id, characterId: '', key: id, fields: {}, sourceText: '', text: '', status: 'empty', notes: '',
    takes: [{ id: 't', kind: 'tts', createdAt: 'now', file: { fileId: 't', relPath: 't.mp3', format: 'mp3' }, duration: 1, meta: {}, edits: emptyEdits() }],
    ...extra,
  })

  it('flags cues whose composition differs from what the renderer holds', () => {
    const before = { cues: [line('a', { comp: comp(0) }), line('b', { comp: comp(0) }), line('c')] }
    const changes = { cues: [line('a', { comp: comp(2) }), line('b', { comp: comp(0), text: 'typed' }), line('c', { comp: { clips: [] } })] }
    expect([...externalChanges(before, changes).comps]).toEqual(['a'])
  })

  it('flags takes whose effects changed', () => {
    const before = { cues: [line('a')] }
    const changed = line('a')
    changed.takes[0].edits = { ...emptyEdits(), effects: { reverb: { mix: 0.3, size: 0.5, decay: 1 } } }
    expect([...externalChanges(before, { cues: [changed] }).effects]).toEqual([takeKey('a', 't')])
    expect(externalChanges(before, { cues: [line('a')] }).effects.size).toBe(0)
  })

  it('ignores change sets without cues', () => {
    const none = externalChanges(null, { name: 'x' })
    expect(none.comps.size + none.effects.size).toBe(0)
  })
})
