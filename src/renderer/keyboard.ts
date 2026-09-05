import { useEffect, useRef } from 'react'

export interface KeyboardHandlers {
  next: () => void
  prev: () => void
  generate: () => void
  approve: () => void
  approveNext: () => void
  playOriginal: () => void
  playFinal: () => void
  abCompare: () => void
  selectTakeByIndex: (n: number) => void
  makeFinal: () => void
  deleteClip: () => void
  splitClip: () => void
  healClip: () => void
  crossfadeClip: () => void
  undo: () => void
  redo: () => void
  auditionTake: () => void
  acceptSuggestion: () => void
  rejectSuggestion: () => void
  toggleRecord: () => void
  toggleFragmentRecord: () => void
  toggleTimeline: () => void
  promptFragment: () => void
  escape: () => boolean
  focusText: () => void
  copySource: () => void
  copyTranslation: () => void
  copyPrompt: () => void
}

function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable
}

function digitKey(e: KeyboardEvent): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
  return m ? Number(m[1]) : null
}

export function useKeyboard(handlers: KeyboardHandlers, enabled: boolean): void {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const handlers = ref.current
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyG') {
        if (e.altKey) return
        e.preventDefault()
        if (e.shiftKey) handlers.promptFragment()
        else handlers.generate()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        if (isTextField(e.target)) return
        e.preventDefault()
        if (e.shiftKey) handlers.redo()
        else handlers.undo()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.code === 'Escape') {
        const consumed = handlers.escape()
        if (!consumed && e.target instanceof HTMLElement && isTextField(e.target)) {
          e.target.blur()
        }
        return
      }
      if (isTextField(e.target)) return

      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (e.target instanceof HTMLElement && e.target.closest('button')) return
        e.preventDefault()
        handlers.auditionTake()
        return
      }
      if (e.code === 'Delete') {
        e.preventDefault()
        handlers.deleteClip()
        return
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault()
        handlers.next()
        return
      }
      if (e.code === 'ArrowUp') {
        e.preventDefault()
        handlers.prev()
        return
      }

      switch (e.code) {
        case 'KeyC':
          e.preventDefault()
          handlers.splitClip()
          return
        case 'KeyH':
          e.preventDefault()
          handlers.healClip()
          return
        case 'KeyX':
          e.preventDefault()
          handlers.crossfadeClip()
          return
        case 'KeyF':
          e.preventDefault()
          handlers.makeFinal()
          return
        case 'KeyE':
          e.preventDefault()
          handlers.focusText()
          return
        case 'KeyR':
          e.preventDefault()
          if (e.shiftKey) handlers.toggleFragmentRecord()
          else handlers.toggleRecord()
          return
        case 'KeyD':
          if (e.shiftKey) return
          e.preventDefault()
          handlers.toggleTimeline()
          return
        case 'KeyJ':
          e.preventDefault()
          handlers.next()
          return
        case 'KeyK':
          e.preventDefault()
          handlers.prev()
          return
        case 'KeyA':
          e.preventDefault()
          if (e.shiftKey) handlers.approveNext()
          else handlers.approve()
          return
        case 'KeyO':
          e.preventDefault()
          handlers.playOriginal()
          return
        case 'KeyB':
          e.preventDefault()
          handlers.abCompare()
          return
        case 'KeyY':
          e.preventDefault()
          handlers.acceptSuggestion()
          return
        case 'KeyN':
          e.preventDefault()
          handlers.rejectSuggestion()
          return
        case 'KeyS':
          e.preventDefault()
          handlers.copySource()
          return
        case 'KeyT':
          e.preventDefault()
          handlers.copyTranslation()
          return
        case 'KeyP':
          e.preventDefault()
          handlers.copyPrompt()
          return
        case 'Space':
          e.preventDefault()
          handlers.playFinal()
          return
      }

      const digit = digitKey(e)
      if (digit !== null) {
        e.preventDefault()
        handlers.selectTakeByIndex(digit - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}
