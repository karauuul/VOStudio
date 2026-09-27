import { describe, expect, it } from 'vitest'
import { dropLineEdits, type LineHistory } from '../src/shared/line-history'
import { emptyEdits, type Cue, type CueComp } from '../src/shared/domain'
import { externalChanges, pickHistory, recordExternalEffects, redoStale, takeKey, type TakeEffectsEdit } from '../src/shared/undo-route'

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

  it('records agent composition edits as undo steps instead of dropping them', () => {
    const before = { cues: [line('a', { comp: comp(0) }), line('b')] }
    const changes = { cues: [line('a', { comp: comp(2) }), line('b', { comp: comp(1) })] }
    const agent = externalChanges(before, changes, 'agent')
    expect([...agent.comps]).toEqual([])
    expect(agent.compEdits).toEqual([{ cueId: 'a', prev: comp(0) }, { cueId: 'b', prev: null }])
    const other = externalChanges(before, changes)
    expect([...other.comps]).toEqual(['a', 'b'])
    expect(other.compEdits).toEqual([])
  })

  it('records agent take effect edits, but drops agent take deletions', () => {
    const before = { cues: [line('a')] }
    const changed = line('a')
    const effects = { delay: { time: 0.2, feedback: 0.3, mix: 0.4 } }
    changed.takes[0].edits = { ...emptyEdits(), effects }
    const agent = externalChanges(before, { cues: [changed] }, 'agent')
    expect(agent.effectEdits).toEqual([{ cueId: 'a', takeId: 't', prev: undefined, next: effects }])
    expect(agent.effects.size).toBe(0)
    expect(externalChanges(before, { cues: [changed] }).effectEdits).toEqual([])
    const deleted = line('a')
    deleted.takes[0].deletedAt = '2026-01-01T00:00:00.000Z'
    const removal = externalChanges(before, { cues: [deleted] }, 'agent')
    expect([...removal.effects]).toEqual([takeKey('a', 't')])
    expect(removal.effectEdits).toEqual([])
  })

  it('records agent edits of a take owned by another line next to Properties edits of it', () => {
    const effects = { delay: { time: 0.2, feedback: 0.3, mix: 0.4 } }
    const properties: TakeEffectsEdit = { cueId: 'owner', takeId: 'pinned', prev: undefined, next: effects, at: 1 }
    const redo: TakeEffectsEdit = { cueId: 'owner', takeId: 'pinned', prev: effects, next: undefined, at: 0 }
    const before = { cues: [line('owner')] }
    before.cues[0].takes[0].id = 'pinned'
    const changed = structuredClone(before.cues[0])
    changed.takes[0].edits = { ...emptyEdits(), effects }
    const external = externalChanges(before, { cues: [changed] }, 'agent')
    const history = recordExternalEffects({ undo: [properties], redo: [redo] }, external, 5, 100)
    expect(history.undo).toEqual([properties, { cueId: 'owner', takeId: 'pinned', prev: undefined, next: effects, at: 5 }])
    expect(history.redo).toEqual([])
  })

  it('drops history of takes changed by others and keeps the newest entries within the limit', () => {
    const entry = (cueId: string, at: number): TakeEffectsEdit => ({ cueId, takeId: 't', prev: undefined, next: undefined, at })
    const external = externalChanges(null, { cues: [] })
    external.effects.add(takeKey('a', 't'))
    const kept = recordExternalEffects({ undo: [entry('a', 1), entry('b', 2)], redo: [entry('a', 3), entry('b', 4)] }, external, 9, 100)
    expect(kept).toEqual({ undo: [entry('b', 2)], redo: [entry('b', 4)] })
    external.effects.clear()
    external.effectEdits.push({ cueId: 'c', takeId: 't', prev: undefined, next: undefined })
    expect(recordExternalEffects({ undo: [entry('a', 1), entry('b', 2)], redo: [] }, external, 9, 2).undo).toEqual([entry('b', 2), entry('c', 9)])
  })

  it('ignores change sets without cues', () => {
    const none = externalChanges(null, { name: 'x' })
    expect(none.comps.size + none.effects.size).toBe(0)
  })
})

describe('dropLineEdits', () => {
  it('drops line history entries that touch externally changed lines', () => {
    const history: LineHistory = {
      undo: [
        { kind: 'done', cueId: 'a', textRevision: 1, before: { status: 'generated' }, after: { status: 'approved' }, at: 1 },
        { kind: 'done', cueId: 'b', textRevision: 1, before: { status: 'generated' }, after: { status: 'approved' }, at: 2 },
      ],
      redo: [{ kind: 'original', cueId: 'a', takeId: 't', before: { status: 'empty', referenceAudio: null, referenceDuration: null }, after: { status: 'empty' }, at: 3 }],
    }
    dropLineEdits(history, new Set(['a']))
    expect(history.undo.map((e) => (e.kind === 'done' ? e.cueId : ''))).toEqual(['b'])
    expect(history.redo).toEqual([])
  })
})

describe('externalChanges lines', () => {
  it('flags lines whose restorable fields changed or were removed, not take-only changes', () => {
    const cue = { id: 'a', key: 'a', characterId: 'c', fields: {}, sourceText: 'x', text: 'y', status: 'translated', notes: '', takes: [] } as unknown as Cue
    const withTake = { ...cue, takes: [{ id: 't', edits: emptyEdits() }] } as unknown as Cue
    expect([...externalChanges({ cues: [cue] }, { cues: [withTake] }).lines]).toEqual([])
    expect([...externalChanges({ cues: [cue] }, { cues: [{ ...cue, text: 'z' }] }).lines]).toEqual(['a'])
    expect([...externalChanges({ cues: [cue] }, { removedCueIds: ['a'] }).lines]).toEqual(['a'])
  })
})

describe('externalChanges effects', () => {
  it('flags a take whose deletion changed even when its effects did not', () => {
    const take = { id: 't', edits: emptyEdits() }
    const cue = { id: 'a', key: 'a', characterId: 'c', fields: {}, sourceText: '', text: '', status: 'generated', notes: '', takes: [take] } as unknown as Cue
    const deleted = { ...cue, takes: [{ ...take, deletedAt: '2026-01-01T00:00:00.000Z' }] } as unknown as Cue
    expect([...externalChanges({ cues: [cue] }, { cues: [deleted] }).effects]).toEqual([takeKey('a', 't')])
  })
})
