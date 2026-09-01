import { useEffect, useRef } from 'react'

export interface KeyboardHandlers {
  next: () => void
  prev: () => void
  generate: () => void
  approveToggle: () => void
  playOriginal: () => void
  playFinal: () => void
  abCompare: () => void
  selectTakeByIndex: (n: number) => void
  makeFinal: () => void
  deleteTake: () => void
  splitClip: () => void
  healClip: () => void
  crossfadeClip: () => void
  undo: () => void
  redo: () => void
  auditionTake: () => void
  acceptSuggestion: () => void
  rejectSuggestion: () => void
  toggleRecord: () => void
  escape: () => boolean
  focusText: () => void
}

function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable
}

function digitKey(e: KeyboardEvent): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
  if (m) return Number(m[1])
  if (e.key >= '1' && e.key <= '9') return Number(e.key)
  return null
}

export function useKeyboard(handlers: KeyboardHandlers, enabled: boolean): void {
  const ref = useRef(handlers)
  ref.current = handlers

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      const handlers = ref.current
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyG') {
        e.preventDefault()
        handlers.generate()
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
      if (e.key === 'Escape') {
        const consumed = handlers.escape()
        if (!consumed && e.target instanceof HTMLElement && isTextField(e.target)) {
          e.target.blur()
        }
        return
      }
      if (isTextField(e.target)) return

      if (e.key === 'Enter') {
        if (e.target instanceof HTMLElement && e.target.closest('button')) return
        e.preventDefault()
        handlers.auditionTake()
        return
      }
      if (e.key === 'Delete') {
        e.preventDefault()
        handlers.deleteTake()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        handlers.next()
        return
      }
      if (e.key === 'ArrowUp') {
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
          handlers.toggleRecord()
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
          handlers.approveToggle()
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
