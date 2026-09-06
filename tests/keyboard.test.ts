import { describe, expect, it } from 'vitest'
import {
  BINDINGS,
  groupOf,
  isEditor,
  keyScope,
  keyText,
  resolveKey,
  SHORTCUT_GROUPS,
  type Binding,
  type KeyInput,
  type KeyboardScopes,
  type Scope,
} from '../src/renderer/keyboard'

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
    expect(action({ code: 'KeyF' })).toBe('makeFinal')
    expect(action({ code: 'Space' })).toBe('playPause')
    expect(action({ code: 'Space', shiftKey: true })).toBe('playClip')
  })

  it('rejects Alt and AltGr combinations', () => {
    expect(action({ code: 'KeyF', altKey: true })).toBeNull()
    expect(action({ code: 'KeyG', ctrlKey: true, altKey: true })).toBeNull()
    expect(action({ code: 'Space', ctrlKey: true, altKey: true })).toBeNull()
  })

  it('does not fire unmodified actions while Ctrl or Meta is held', () => {
    expect(action({ code: 'KeyR', ctrlKey: true })).toBeNull()
    expect(action({ code: 'KeyS', metaKey: true })).toBeNull()
    expect(action({ code: 'Space', ctrlKey: true })).toBeNull()
  })

  it('does not fire modified actions without the modifier', () => {
    expect(action({ code: 'KeyG' })).toBeNull()
    expect(action({ code: 'KeyZ', scope: 'timeline' })).toBeNull()
  })

  it('separates Shift variants of the same chord', () => {
    expect(action({ code: 'KeyG', ctrlKey: true })).toBe('generate')
    expect(action({ code: 'Space' })).toBe('playPause')
    expect(action({ code: 'Space', shiftKey: true })).toBe('playClip')
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
    expect(action({ code: 'Equal', scope: 'timeline', repeat: true })).toBe('zoomIn')
  })
})

describe('routes', () => {
  it('switches routes and focuses search from every route scope', () => {
    for (const scope of ['workspace', 'timeline', 'text', 'grid', 'gridText'] as Scope[]) {
      expect(action({ code: 'Digit1', ctrlKey: true, scope })).toBe('routeImport')
      expect(action({ code: 'Numpad2', ctrlKey: true, scope })).toBe('routeWork')
      expect(action({ code: 'KeyF', ctrlKey: true, scope })).toBe('focusSearch')
    }
  })

  it('keeps route keys out of a popover and away from unmodified keys', () => {
    expect(action({ code: 'Digit1', ctrlKey: true, scope: 'popover' })).toBeNull()
    expect(action({ code: 'KeyF', ctrlKey: true, scope: 'popover' })).toBeNull()
    expect(action({ code: 'Digit1' })).toBe('selectTake')
    expect(action({ code: 'KeyF' })).toBe('makeFinal')
    expect(action({ code: 'Digit3', ctrlKey: true })).toBe('routeExport')
    expect(action({ code: 'Digit4', ctrlKey: true })).toBeNull()
  })

  it('leaves Deliver only its route keys and Escape', () => {
    expect(action({ code: 'Digit3', ctrlKey: true, scope: 'deliver' })).toBe('routeExport')
    expect(action({ code: 'Digit1', ctrlKey: true, scope: 'deliver' })).toBe('routeImport')
    expect(action({ code: 'Escape', scope: 'deliver' })).toBe('escape')
    for (const code of ['KeyA', 'KeyF', 'KeyR', 'KeyD', 'Space', 'Enter', 'Digit1', 'ArrowDown']) {
      expect(action({ code, scope: 'deliver' })).toBeNull()
    }
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'deliver' })).toBeNull()
    expect(action({ code: 'KeyF', ctrlKey: true, scope: 'deliver' })).toBeNull()
  })
})

describe('app surfaces', () => {
  const routes: Scope[] = ['workspace', 'timeline', 'text', 'grid', 'gridText', 'deliver', 'home']

  it('Settings and Shortcuts resolve from every route scope and from Home', () => {
    for (const scope of routes) {
      expect(action({ code: 'Comma', ctrlKey: true, scope })).toBe('settings')
      expect(action({ code: 'F1', scope })).toBe('shortcuts')
    }
  })

  it('they need their exact modifiers and stay out of blocking surfaces', () => {
    expect(action({ code: 'Comma', scope: 'grid' })).toBeNull()
    expect(action({ code: 'Comma', ctrlKey: true, shiftKey: true })).toBeNull()
    expect(action({ code: 'F1', ctrlKey: true })).toBeNull()
    for (const scope of ['popover'] as Scope[]) {
      expect(action({ code: 'Comma', ctrlKey: true, scope })).toBeNull()
      expect(action({ code: 'F1', scope })).toBeNull()
    }
  })

  it('bare comma and period place the selected source, only in the Work room', () => {
    expect(action({ code: 'Comma' })).toBe('insertSource')
    expect(action({ code: 'Period' })).toBe('replaceSource')
    expect(action({ code: 'Comma', scope: 'timeline' })).toBe('insertSource')
    expect(action({ code: 'Period', scope: 'timeline' })).toBe('replaceSource')
    expect(action({ code: 'Comma', scope: 'text' })).toBeNull()
    expect(action({ code: 'Period', scope: 'grid' })).toBeNull()
  })

  it('Home has no Work, grid or route commands, only Escape', () => {
    expect(action({ code: 'Escape', scope: 'home' })).toBe('escape')
    for (const code of ['KeyA', 'KeyF', 'KeyR', 'Space', 'Enter', 'Digit1', 'ArrowDown', 'Delete']) {
      expect(action({ code, scope: 'home' })).toBeNull()
    }
    expect(action({ code: 'Digit1', ctrlKey: true, scope: 'home' })).toBeNull()
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'home' })).toBeNull()
    expect(action({ code: 'KeyF', ctrlKey: true, scope: 'home' })).toBeNull()
  })
})

describe('shortcuts table', () => {
  it('labels one binding per action, and every labelled binding is reachable', () => {
    const labelled = BINDINGS.filter((b) => b.label)
    const actions = labelled.map((b) => b.action)
    expect(new Set(actions).size).toBe(actions.length)
    for (const b of labelled) {
      expect(b.label?.trim()).toBeTruthy()
      expect(b.codes.length).toBeGreaterThan(0)
      expect(b.scopes.length).toBeGreaterThan(0)
    }
  })

  it('every action in the table has exactly one label to render', () => {
    for (const b of BINDINGS) {
      const same = BINDINGS.filter((o) => o.action === b.action && o.label)
      expect(same.length).toBe(1)
    }
  })

  it('renders physical codes as badges, numpad duplicates excluded', () => {
    const of = (action: string): Binding => BINDINGS.find((b) => b.action === action)!
    expect(keyText(of('makeFinal'))).toBe('F')
    expect(keyText(of('playClip'))).toBe('Shift+Space')
    expect(keyText(of('generate'))).toBe('Ctrl+G')
    expect(keyText(of('settings'))).toBe('Ctrl+,')
    expect(keyText(of('shortcuts'))).toBe('F1')
    expect(keyText(of('routeImport'))).toBe('Ctrl+1')
    expect(keyText(of('routeWork'))).toBe('Ctrl+2')
    expect(keyText(of('gridNext'))).toBe('↓')
    expect(keyText(of('deleteClip'))).toBe('Del')
    expect(keyText(of('selectTake'))).toBe('1…9')
  })

  it('groups every labelled binding into exactly one visible section', () => {
    const titles = SHORTCUT_GROUPS.map((g) => g.title)
    for (const b of BINDINGS.filter((x) => x.label)) {
      expect(titles).toContain(groupOf(b))
    }
    expect(groupOf(of('settings'))).toBe('App')
    expect(groupOf(of('makeFinal'))).toBe('Work')
    expect(groupOf(of('gridToggle'))).toBe('Import')
    expect(groupOf(of('healClip'))).toBe('Timeline')
  })
})

function of(action: string): Binding {
  return BINDINGS.find((b) => b.action === action)!
}

describe('project grid', () => {
  it('owns arrows, Enter, Space and select all', () => {
    expect(action({ code: 'ArrowDown', scope: 'grid' })).toBe('gridNext')
    expect(action({ code: 'ArrowUp', scope: 'grid', repeat: true })).toBe('gridPrev')
    expect(action({ code: 'Enter', scope: 'grid' })).toBe('gridOpen')
    expect(action({ code: 'NumpadEnter', scope: 'grid' })).toBe('gridOpen')
    expect(action({ code: 'Space', scope: 'grid' })).toBe('gridToggle')
    expect(action({ code: 'KeyA', ctrlKey: true, scope: 'grid' })).toBe('gridSelectAll')
  })

  it('does not reach Work commands', () => {
    for (const code of ['KeyA', 'KeyJ', 'KeyK', 'KeyF', 'KeyR', 'Digit1']) {
      expect(action({ code, scope: 'grid' })).toBeNull()
    }
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'grid' })).toBeNull()
    expect(action({ code: 'KeyA', shiftKey: true, scope: 'grid' })).toBeNull()
  })

  it('is not reachable from Work scopes', () => {
    for (const code of ['ArrowDown', 'ArrowUp', 'Enter', 'Space']) {
      expect(action({ code, scope: 'workspace' })).not.toBe(
        action({ code, scope: 'grid' })
      )
    }
    expect(action({ code: 'KeyA', ctrlKey: true, scope: 'workspace' })).toBeNull()
    expect(action({ code: 'KeyA', ctrlKey: true, scope: 'timeline' })).toBeNull()
  })

  it('leaves text fields to the platform', () => {
    expect(action({ code: 'KeyA', ctrlKey: true, scope: 'gridText' })).toBeNull()
    expect(action({ code: 'KeyA', ctrlKey: true, scope: 'text' })).toBeNull()
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'gridText' })).toBeNull()
    for (const code of ['ArrowDown', 'Space', 'Enter']) {
      expect(action({ code, scope: 'gridText' })).toBeNull()
    }
    expect(action({ code: 'Escape', scope: 'gridText' })).toBe('escape')
  })
})

describe('scope precedence', () => {
  const scopes: Scope[] = ['popover', 'text', 'gridText', 'grid', 'timeline', 'workspace']

  it('a popover consumes every key', () => {
    for (const code of ['KeyA', 'Space', 'Escape', 'Delete', 'Digit1']) {
      expect(action({ code, scope: 'popover' })).toBeNull()
    }
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'popover' })).toBeNull()
  })

  it('a text editor keeps its own keys and allows only Escape and generate', () => {
    expect(action({ code: 'Escape', scope: 'text' })).toBe('escape')
    expect(action({ code: 'KeyG', ctrlKey: true, scope: 'text' })).toBe('generate')
    for (const code of ['KeyA', 'KeyE', 'Space', 'Enter', 'Digit3', 'ArrowDown', 'Delete']) {
      expect(action({ code, scope: 'text' })).toBeNull()
    }
  })

  it('hovered-track mute belongs to the timeline scope', () => {
    expect(action({ code: 'KeyM', scope: 'timeline' })).toBe('muteTrack')
    expect(action({ code: 'KeyM', scope: 'workspace' })).toBeNull()
    expect(keyText(of('muteTrack'))).toBe('M')
    expect(groupOf(of('muteTrack'))).toBe('Timeline')
  })

  it('S cuts at the playhead everywhere in work and copying has no hotkey', () => {
    expect(action({ code: 'KeyS', scope: 'timeline' })).toBe('splitAtPlayhead')
    expect(action({ code: 'KeyS', scope: 'workspace' })).toBe('splitAtPlayhead')
    expect(keyText(of('splitAtPlayhead'))).toBe('S')
    expect(groupOf(of('splitAtPlayhead'))).toBe('Work')
    for (const code of ['KeyT', 'KeyP']) {
      expect(action({ code, scope: 'timeline' })).toBeNull()
      expect(action({ code, scope: 'workspace' })).toBeNull()
    }
  })

  it('timeline edits exist only in the timeline scope', () => {
    for (const code of ['KeyC', 'KeyH', 'KeyX', 'Delete', 'KeyV', 'Equal', 'Minus']) {
      expect(action({ code, scope: 'timeline' })).not.toBeNull()
      expect(action({ code, scope: 'workspace' })).toBeNull()
    }
    expect(action({ code: 'KeyR', scope: 'timeline' })).toBe('toggleRecord')
    expect(action({ code: 'KeyR', shiftKey: true, scope: 'workspace' })).toBeNull()
  })

  it('workspace actions stay available in the timeline scope', () => {
    for (const code of ['Space', 'KeyJ', 'KeyF', 'Home', 'End', 'KeyI', 'KeyO']) {
      expect(action({ code, scope: 'timeline' })).toBe(action({ code, scope: 'workspace' }))
    }
    expect(action({ code: 'KeyI', scope: 'workspace' })).toBe('setIn')
    expect(action({ code: 'KeyO', scope: 'workspace' })).toBe('setOut')
  })

  it('every binding declares at least one scope and no scope is unreachable', () => {
    for (const b of BINDINGS) expect(b.scopes.length).toBeGreaterThan(0)
    const used = new Set(BINDINGS.flatMap((b) => b.scopes))
    for (const s of scopes) expect(used.has(s) || s === 'popover').toBe(true)
  })
})

describe('physical layout independence', () => {
  it('resolves by code when the layout produces another character', () => {
    const cyrillic = { ...key({ code: 'KeyF' }), key: 'а' }
    expect(resolveKey(cyrillic)?.action).toBe('makeFinal')
    const withShift = { ...key({ code: 'Space', shiftKey: true }), key: ' ' }
    expect(resolveKey(withShift)?.action).toBe('playClip')
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

describe('focused controls', () => {
  const ctx = (over: Partial<KeyboardScopes> = {}): KeyboardScopes => ({
    home: false,
    timeline: false,
    grid: false,
    deliver: false,
    ...over,
  })

  it('Space reaches play/pause from a focused button', () => {
    const scope = keyScope({ code: 'Space', editor: false, native: true }, ctx())
    expect(scope).toBe('workspace')
    expect(action({ code: 'Space', scope: scope! })).toBe('playPause')
  })

  it('Enter and arrows stay with the focused button', () => {
    for (const code of ['Enter', 'NumpadEnter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(keyScope({ code, editor: false, native: true }, ctx())).toBeNull()
    }
  })

  it('a focused text field still owns every key', () => {
    expect(keyScope({ code: 'Space', editor: true, native: false }, ctx())).toBe('text')
    expect(keyScope({ code: 'Space', editor: true, native: false }, ctx({ grid: true }))).toBe(
      'gridText'
    )
  })

  it('treats only text-like fields as editors', () => {
    for (const type of ['text', 'search', 'number', 'url', 'email', 'password', 'tel']) {
      expect(isEditor({ tagName: 'INPUT', type })).toBe(true)
    }
    expect(isEditor({ tagName: 'INPUT' })).toBe(true)
    expect(isEditor({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditor({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('leaves sliders, toggles, pickers, selects and buttons out of the editor scope', () => {
    for (const type of ['range', 'checkbox', 'radio', 'color', 'file', 'button', 'submit']) {
      expect(isEditor({ tagName: 'INPUT', type })).toBe(false)
    }
    expect(isEditor({ tagName: 'SELECT' })).toBe(false)
    expect(isEditor({ tagName: 'BUTTON' })).toBe(false)
    expect(isEditor({ tagName: 'DIV' })).toBe(false)
    expect(isEditor(null)).toBe(false)
  })

  it('Space plays after touching a slider, a select or a button', () => {
    for (const el of [
      { tagName: 'INPUT', type: 'range' },
      { tagName: 'SELECT' },
      { tagName: 'BUTTON' },
    ]) {
      const scope = keyScope({ code: 'Space', editor: isEditor(el), native: true }, ctx())
      expect(scope).toBe('workspace')
      expect(action({ code: 'Space', scope: scope! })).toBe('playPause')
    }
  })

  it('keeps arrow keys with a focused slider', () => {
    const el = { tagName: 'INPUT', type: 'range' }
    for (const code of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(keyScope({ code, editor: isEditor(el), native: true }, ctx())).toBeNull()
    }
  })

  it('select keeps every key except Space', () => {
    expect(keyScope({ code: 'Space', editor: false, native: true, select: true }, ctx())).toBe('workspace')
    for (const code of ['KeyF', 'Home', 'End', 'ArrowDown']) {
      expect(keyScope({ code, editor: false, native: true, select: true }, ctx())).toBeNull()
    }
  })

  it('slider keeps Home, End and paging, gives up Space', () => {
    expect(keyScope({ code: 'Space', editor: false, native: true, range: true }, ctx())).toBe('workspace')
    for (const code of ['Home', 'End', 'PageUp', 'PageDown']) {
      expect(keyScope({ code, editor: false, native: true, range: true }, ctx())).toBeNull()
    }
  })
})
