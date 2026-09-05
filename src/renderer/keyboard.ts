import { useEffect, useRef } from 'react'

export type Scope = 'popover' | 'decision' | 'text' | 'timeline' | 'workspace'

export type KeyAction =
  | 'next'
  | 'prev'
  | 'generate'
  | 'promptFragment'
  | 'approve'
  | 'approveNext'
  | 'playOriginal'
  | 'playPause'
  | 'restartActive'
  | 'compare'
  | 'selectTake'
  | 'makeFinal'
  | 'deleteClip'
  | 'splitClip'
  | 'healClip'
  | 'crossfadeClip'
  | 'undo'
  | 'redo'
  | 'acceptSuggestion'
  | 'rejectSuggestion'
  | 'toggleRecord'
  | 'toggleFragmentRecord'
  | 'toggleTimeline'
  | 'focusText'
  | 'copySource'
  | 'copyTranslation'
  | 'copyPrompt'
  | 'escape'

export interface Binding {
  action: KeyAction
  codes: string[]
  scopes: Scope[]
  mod?: true
  shift?: true
  repeat?: true
  index?: number
}

export interface KeyInput {
  code: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
  repeat: boolean
  isComposing: boolean
  scope: Scope
}

const WORK: Scope[] = ['workspace', 'timeline']
const TIMELINE: Scope[] = ['timeline']
const TEXT: Scope[] = ['workspace', 'timeline', 'text']

export const BINDINGS: Binding[] = [
  { action: 'escape', codes: ['Escape'], scopes: ['workspace', 'timeline', 'text', 'decision'] },
  { action: 'generate', codes: ['KeyG'], mod: true, scopes: TEXT },
  { action: 'promptFragment', codes: ['KeyG'], mod: true, shift: true, scopes: TIMELINE },
  { action: 'undo', codes: ['KeyZ'], mod: true, scopes: TIMELINE },
  { action: 'redo', codes: ['KeyZ'], mod: true, shift: true, scopes: TIMELINE },
  { action: 'next', codes: ['KeyJ', 'ArrowDown'], scopes: WORK, repeat: true },
  { action: 'prev', codes: ['KeyK', 'ArrowUp'], scopes: WORK, repeat: true },
  { action: 'playOriginal', codes: ['KeyO'], scopes: WORK },
  { action: 'playPause', codes: ['Space'], scopes: WORK },
  { action: 'restartActive', codes: ['Enter', 'NumpadEnter'], scopes: WORK },
  { action: 'compare', codes: ['KeyB'], scopes: WORK },
  { action: 'makeFinal', codes: ['KeyF'], scopes: WORK },
  { action: 'approve', codes: ['KeyA'], scopes: WORK },
  { action: 'approveNext', codes: ['KeyA'], shift: true, scopes: WORK },
  { action: 'focusText', codes: ['KeyE'], scopes: WORK },
  { action: 'toggleRecord', codes: ['KeyR'], scopes: WORK },
  { action: 'toggleFragmentRecord', codes: ['KeyR'], shift: true, scopes: TIMELINE },
  { action: 'toggleTimeline', codes: ['KeyD'], scopes: WORK },
  { action: 'acceptSuggestion', codes: ['KeyY'], scopes: WORK },
  { action: 'rejectSuggestion', codes: ['KeyN'], scopes: WORK },
  { action: 'copySource', codes: ['KeyS'], scopes: WORK },
  { action: 'copyTranslation', codes: ['KeyT'], scopes: WORK },
  { action: 'copyPrompt', codes: ['KeyP'], scopes: WORK },
  { action: 'splitClip', codes: ['KeyC'], scopes: TIMELINE },
  { action: 'healClip', codes: ['KeyH'], scopes: TIMELINE },
  { action: 'crossfadeClip', codes: ['KeyX'], scopes: TIMELINE },
  { action: 'deleteClip', codes: ['Delete'], scopes: TIMELINE },
  ...Array.from({ length: 9 }, (_, i) => ({
    action: 'selectTake' as const,
    codes: [`Digit${i + 1}`, `Numpad${i + 1}`],
    scopes: WORK,
    index: i,
  })),
]

export function resolveKey(e: KeyInput): Binding | null {
  if (e.isComposing || e.altKey || e.scope === 'popover') return null
  const mod = e.ctrlKey || e.metaKey
  for (const b of BINDINGS) {
    if (!b.codes.includes(e.code)) continue
    if (mod !== !!b.mod) continue
    if (e.shiftKey !== !!b.shift) continue
    if (!b.scopes.includes(e.scope)) continue
    if (e.repeat && !b.repeat) continue
    return b
  }
  return null
}

export interface KeyboardHandlers {
  next: () => void
  prev: () => void
  generate: () => void
  promptFragment: () => void
  approve: () => void
  approveNext: () => void
  playOriginal: () => void
  playPause: () => void
  restartActive: () => void
  compare: () => void
  selectTake: (index: number) => void
  makeFinal: () => void
  deleteClip: () => void
  splitClip: () => void
  healClip: () => void
  crossfadeClip: () => void
  undo: () => void
  redo: () => void
  acceptSuggestion: () => void
  rejectSuggestion: () => void
  toggleRecord: () => void
  toggleFragmentRecord: () => void
  toggleTimeline: () => void
  focusText: () => void
  copySource: () => void
  copyTranslation: () => void
  copyPrompt: () => void
  escape: () => boolean
  stopPlayback: () => void
}

export interface KeyboardScopes {
  timeline: boolean
  decision: () => boolean
}

const LOCAL = '[role="menu"], [role="dialog"], .modal, .frag-pop'
const NATIVE = 'button, a[href], select, [role="separator"], [role="button"], summary'
const NATIVE_CODES = [
  'Enter',
  'NumpadEnter',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]

function isEditor(el: HTMLElement | null): boolean {
  if (!el) return false
  const tag = el.tagName
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable
}

export function useKeyboard(
  handlers: KeyboardHandlers,
  enabled: boolean,
  scopes: KeyboardScopes
): void {
  const ref = useRef(handlers)
  ref.current = handlers
  const scopeRef = useRef(scopes)
  scopeRef.current = scopes

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target instanceof HTMLElement ? e.target : null
      if (el?.closest(LOCAL)) return
      const ctx = scopeRef.current
      let scope: Scope
      if (ctx.decision()) scope = 'decision'
      else if (isEditor(el)) scope = 'text'
      else if (el?.closest(NATIVE) && NATIVE_CODES.includes(e.code)) return
      else scope = ctx.timeline ? 'timeline' : 'workspace'

      const b = resolveKey({
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        repeat: e.repeat,
        isComposing: e.isComposing,
        scope,
      })
      if (!b) return
      const handlers = ref.current

      if (b.action === 'escape') {
        if (handlers.escape()) return
        if (scope === 'text') el?.blur()
        else handlers.stopPlayback()
        return
      }
      e.preventDefault()
      if (b.action === 'selectTake') {
        handlers.selectTake(b.index ?? 0)
        return
      }
      handlers[b.action]()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
