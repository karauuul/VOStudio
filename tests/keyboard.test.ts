import { describe, expect, it } from 'vitest'
import { BINDINGS, resolveKey, type KeyInput, type Scope } from '../src/renderer/keyboard'

const key = (over: Partial<KeyInput> & { code: string }): KeyInput => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  isComposing: false,
  scope: 'workspace',
  ...over,
})

const action = (over: Partial<KeyInput> & { code: string }): string | null =>
  resolveKey(key(over))?.action ?? null

describe('exact modifier matching', () => {
  it('plain codes resolve without modifiers', () => {
    expect(action({ code: 'KeyA' })).toBe('approve')
    expect(action({ code: 'KeyA', shiftKey: true })).toBe('approveNext')
    expect(action({ code: 'Space' })).toBe('playPause')
    expect(action({ code: 'KeyB' })).toBe('compare')
  })

  it('rejects Alt and AltGr combinations', () => {
    expect(action({ code: 'KeyA', altKey: true })).toBeNull()
    expect(action({ code: 'KeyG', ctrlKey: true, altKey: true })).toBeNull()
    expect(action({ code: 'KeyB', ctrlKey: true, altKey: true })).toBeNull()
  })

  it('does not fire unmodified actions while Ctrl or Meta is held', () => {
    expect(action({ code: 'KeyA', ctrlKey: true })).toBeNull()
    expect(action({ code: 'KeyS', metaKey: true })).toBeNull()
    expect(action({ code: 'Space', ctrlKey: true })).toBeNull()
  })

  it('does not fire modified actions without the modifier', () => {
    expect(action({ code: 'KeyG' })).toBeNull()
    expect(action({ code: 'KeyZ', scope: 'timeline' })).toBeNull()
  })

  it('separates Shift variants of the same chord', () => {
    expect(action({ code: 'KeyG', ctrlKey: true })).toBe('generate')
    expect(action({ code: 'KeyG', ctrlKey: true, shiftKey: true, scope: 'timeline' })).toBe(
      'promptFragment'
    )
    expect(action({ code: 'KeyZ', ctrlKey: true, scope: 'timeline' })).toBe('undo')
    expect(action({ code: 'KeyZ', ctrlKey: true, shiftKey: true, scope: 'timeline' })).toBe('redo')
  })

  it('treats Meta like Ctrl', () => {
    expect(action({ code: 'KeyG', metaKey: true })).toBe('generate')
  })

  it('ignores IME composition', () => {
    expect(action({ code: 'KeyA', isComposing: true })).toBeNull()
    expect(action({ code: 'Escape', isComposing: true })).toBeNull()
  })
})

describe('repeat blocking', () => {
  const held = ['KeyG', 'KeyR', 'KeyA', 'KeyF', 'KeyY', 'KeyN', 'Digit1']
  it('blocks repeats for costly and destructive actions', () => {
    expect(action({ code: 'KeyG', ctrlKey: true, repeat: true })).toBeNull()
    expect(action({ code: 'Delete', scope: 'timeline', repeat: true })).toBeNull()
    expect(action({ code: 'KeyC', scope: 'timeline', repeat: true })).toBeNull()
    expect(action({ code: 'KeyZ', ctrlKey: true, scope: 'timeline', repeat: true })).toBeNull()
    for (const code of held) expect(action({ code, repeat: true })).toBeNull()
  })

  it('allows repeats for cue navigation only', () => {
    expect(action({ code: 'KeyJ', repeat: true })).toBe('next')
    expect(action({ code: 'ArrowUp', repeat: true })).toBe('prev')
    expect(action({ code: 'Space', repeat: true })).toBeNull()
    expect(action({ code: 'KeyB', repeat: true })).toBeNull()
  })
})

describe('scope precedence', () => {
  const scopes: Scope[] = ['popover', 'decision', 'text', 'timeline', 'workspace']

  it('a popover consumes every key', () => {
    for (const code of ['KeyA', 'Space', 'Escape', 'Delete', 'Digit1']) {
      expect(action({ code, scope: 'popover' })).toBeNull()
    }
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'popover' })).toBeNull()
  })

  it('an unsaved-recording decision leaves only Escape', () => {
    expect(action({ code: 'Escape', scope: 'decision' })).toBe('escape')
    for (const code of ['KeyA', 'Space', 'KeyR', 'Enter']) {
      expect(action({ code, scope: 'decision' })).toBeNull()
    }
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'decision' })).toBeNull()
  })

  it('a text editor keeps its own keys and allows only Escape and generate', () => {
    expect(action({ code: 'Escape', scope: 'text' })).toBe('escape')
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'text' })).toBe('generate')
    for (const code of ['KeyA', 'KeyE', 'Space', 'Enter', 'Digit3', 'ArrowDown', 'Delete']) {
      expect(action({ code, scope: 'text' })).toBeNull()
    }
  })

  it('timeline edits exist only in the timeline scope', () => {
    for (const code of ['KeyC', 'KeyH', 'KeyX', 'Delete']) {
      expect(action({ code, scope: 'timeline' })).not.toBeNull()
      expect(action({ code, scope: 'workspace' })).toBeNull()
    }
    expect(action({ code: 'KeyR', shiftKey: true, scope: 'timeline' })).toBe('toggleFragmentRecord')
    expect(action({ code: 'KeyR', shiftKey: true, scope: 'workspace' })).toBeNull()
  })

  it('workspace actions stay available in the timeline scope', () => {
    for (const code of ['Space', 'KeyB', 'KeyJ', 'KeyO', 'KeyF']) {
      expect(action({ code, scope: 'timeline' })).toBe(action({ code, scope: 'workspace' }))
    }
  })

  it('every binding declares at least one scope and no scope is unreachable', () => {
    for (const b of BINDINGS) expect(b.scopes.length).toBeGreaterThan(0)
    const used = new Set(BINDINGS.flatMap((b) => b.scopes))
    for (const s of scopes) expect(used.has(s) || s === 'popover').toBe(true)
  })
})

describe('physical layout independence', () => {
  it('resolves by code when the layout produces another character', () => {
    const cyrillic = { ...key({ code: 'KeyA' }), key: 'ф' }
    expect(resolveKey(cyrillic)?.action).toBe('approve')
    const withShift = { ...key({ code: 'KeyA', shiftKey: true }), key: 'Ф' }
    expect(resolveKey(withShift)?.action).toBe('approveNext')
    const record = { ...key({ code: 'KeyR' }), key: 'к' }
    expect(resolveKey(record)?.action).toBe('toggleRecord')
  })
})

describe('take selection', () => {
  it('maps digits and numpad digits to zero-based take indexes', () => {
    for (let n = 1; n <= 9; n++) {
      expect(resolveKey(key({ code: `Digit${n}` }))).toMatchObject({
        action: 'selectTake',
        index: n - 1,
      })
      expect(resolveKey(key({ code: `Numpad${n}` }))).toMatchObject({
        action: 'selectTake',
        index: n - 1,
      })
    }
    expect(action({ code: 'Digit0' })).toBeNull()
  })
})
