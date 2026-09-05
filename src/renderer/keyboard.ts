import { useEffect, useRef } from 'react'

export type Scope =
  | 'popover'
  | 'decision'
  | 'text'
  | 'gridText'
  | 'grid'
  | 'timeline'
  | 'workspace'
  | 'deliver'
  | 'home'

export type KeyAction =
  | 'settings'
  | 'shortcuts'
  | 'routeWork'
  | 'routeProject'
  | 'routeDeliver'
  | 'focusSearch'
  | 'gridNext'
  | 'gridPrev'
  | 'gridOpen'
  | 'gridToggle'
  | 'gridSelectAll'
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
  label?: string
  keys?: string
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
const GRID: Scope[] = ['grid']
const ROUTES: Scope[] = ['workspace', 'timeline', 'text', 'grid', 'gridText', 'deliver']
const SEARCHABLE: Scope[] = ['workspace', 'timeline', 'text', 'grid', 'gridText']
const APP: Scope[] = [...ROUTES, 'home']

export const BINDINGS: Binding[] = [
  {
    action: 'escape',
    codes: ['Escape'],
    scopes: [...ROUTES, 'home', 'decision'],
    label: 'Close surface',
  },
  { action: 'settings', codes: ['Comma'], mod: true, scopes: APP, label: 'Settings' },
  { action: 'shortcuts', codes: ['F1'], scopes: APP, label: 'Shortcuts' },
  { action: 'routeWork', codes: ['Digit1', 'Numpad1'], mod: true, scopes: ROUTES, label: 'Work' },
  {
    action: 'routeProject',
    codes: ['Digit2', 'Numpad2'],
    mod: true,
    scopes: ROUTES,
    label: 'Project',
  },
  {
    action: 'routeDeliver',
    codes: ['Digit3', 'Numpad3'],
    mod: true,
    scopes: ROUTES,
    label: 'Deliver',
  },
  { action: 'focusSearch', codes: ['KeyF'], mod: true, scopes: SEARCHABLE, label: 'Focus search' },
  { action: 'gridNext', codes: ['ArrowDown'], scopes: GRID, repeat: true, label: 'Next row' },
  { action: 'gridPrev', codes: ['ArrowUp'], scopes: GRID, repeat: true, label: 'Previous row' },
  { action: 'gridOpen', codes: ['Enter', 'NumpadEnter'], scopes: GRID, label: 'Open cue' },
  { action: 'gridToggle', codes: ['Space'], scopes: GRID, label: 'Select row' },
  { action: 'gridSelectAll', codes: ['KeyA'], mod: true, scopes: GRID, label: 'Select all results' },
  { action: 'generate', codes: ['KeyG'], mod: true, scopes: TEXT, label: 'Generate' },
  {
    action: 'promptFragment',
    codes: ['KeyG'],
    mod: true,
    shift: true,
    scopes: TIMELINE,
    label: 'Generate fragment',
  },
  { action: 'undo', codes: ['KeyZ'], mod: true, scopes: TIMELINE, label: 'Undo' },
  { action: 'redo', codes: ['KeyZ'], mod: true, shift: true, scopes: TIMELINE, label: 'Redo' },
  { action: 'next', codes: ['KeyJ', 'ArrowDown'], scopes: WORK, repeat: true, label: 'Next cue' },
  {
    action: 'prev',
    codes: ['KeyK', 'ArrowUp'],
    scopes: WORK,
    repeat: true,
    label: 'Previous cue',
  },
  { action: 'playOriginal', codes: ['KeyO'], scopes: WORK, label: 'Play original' },
  { action: 'playPause', codes: ['Space'], scopes: WORK, label: 'Play / pause' },
  { action: 'restartActive', codes: ['Enter', 'NumpadEnter'], scopes: WORK, label: 'Play active' },
  { action: 'compare', codes: ['KeyB'], scopes: WORK, label: 'Compare' },
  { action: 'makeFinal', codes: ['KeyF'], scopes: WORK, label: 'Set final' },
  { action: 'approve', codes: ['KeyA'], scopes: WORK, label: 'Approve' },
  { action: 'approveNext', codes: ['KeyA'], shift: true, scopes: WORK, label: 'Approve & next' },
  { action: 'focusText', codes: ['KeyE'], scopes: WORK, label: 'Focus translation' },
  { action: 'toggleRecord', codes: ['KeyR'], scopes: WORK, label: 'Record' },
  {
    action: 'toggleFragmentRecord',
    codes: ['KeyR'],
    shift: true,
    scopes: TIMELINE,
    label: 'Record fragment',
  },
  { action: 'toggleTimeline', codes: ['KeyD'], scopes: WORK, label: 'Timeline / review' },
  { action: 'acceptSuggestion', codes: ['KeyY'], scopes: WORK, label: 'Accept suggestion' },
  { action: 'rejectSuggestion', codes: ['KeyN'], scopes: WORK, label: 'Reject suggestion' },
  { action: 'copySource', codes: ['KeyS'], scopes: WORK, label: 'Copy source' },
  { action: 'copyTranslation', codes: ['KeyT'], scopes: WORK, label: 'Copy translation' },
  { action: 'copyPrompt', codes: ['KeyP'], scopes: WORK, label: 'Copy prompt' },
  { action: 'splitClip', codes: ['KeyC'], scopes: TIMELINE, label: 'Cut' },
  { action: 'healClip', codes: ['KeyH'], scopes: TIMELINE, label: 'Heal' },
  { action: 'crossfadeClip', codes: ['KeyX'], scopes: TIMELINE, label: 'Crossfade' },
  { action: 'deleteClip', codes: ['Delete'], scopes: TIMELINE, label: 'Delete clip' },
  ...Array.from({ length: 9 }, (_, i) => ({
    action: 'selectTake' as const,
    codes: [`Digit${i + 1}`, `Numpad${i + 1}`],
    scopes: WORK,
    index: i,
    ...(i === 0 ? { label: 'Select take', keys: '1…9' } : {}),
  })),
]

const MOD_LABEL =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'

const CODE_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Comma: ',',
  Escape: 'Esc',
  Delete: 'Del',
}

function codeName(code: string): string {
  if (CODE_NAMES[code]) return CODE_NAMES[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  return code
}

export function keyText(b: Binding): string {
  if (b.keys) return b.keys
  const code = b.codes.find((c) => !c.startsWith('Numpad')) ?? b.codes[0]
  return [b.mod ? MOD_LABEL : '', b.shift ? 'Shift' : '', codeName(code)].filter(Boolean).join('+')
}

export const SHORTCUT_GROUPS: { scope: Scope; title: string }[] = [
  { scope: 'home', title: 'App' },
  { scope: 'workspace', title: 'Work' },
  { scope: 'grid', title: 'Project' },
  { scope: 'timeline', title: 'Timeline' },
  { scope: 'deliver', title: 'Deliver' },
]

export function groupOf(b: Binding): string {
  return SHORTCUT_GROUPS.find((g) => b.scopes.includes(g.scope))?.title ?? 'Work'
}

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
  settings: () => void
  shortcuts: () => void
  routeWork: () => void
  routeProject: () => void
  routeDeliver: () => void
  focusSearch: () => void
  gridNext: () => void
  gridPrev: () => void
  gridOpen: () => void
  gridToggle: () => void
  gridSelectAll: () => void
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
  home: boolean
  timeline: boolean
  grid: boolean
  deliver: boolean
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
      if (ctx.home) scope = 'home'
      else if (ctx.decision()) scope = 'decision'
      else if (ctx.deliver) scope = 'deliver'
      else if (isEditor(el)) scope = ctx.grid ? 'gridText' : 'text'
      else if (el?.closest(NATIVE) && NATIVE_CODES.includes(e.code)) return
      else if (ctx.grid) scope = 'grid'
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
        if (scope === 'text' || scope === 'gridText') el?.blur()
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
