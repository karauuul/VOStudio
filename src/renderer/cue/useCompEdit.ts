import { useCallback, useEffect, useRef, useState } from 'react'
import { compProblem, normalizeComp } from '@shared/comp'
import type { CueComp } from '@shared/domain'

const LIMIT = 100

export interface CompEdit {
  commit: (next: CueComp | null) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function sameComp(a: CueComp | null, b: CueComp | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export function useCompEdit(
  cueId: string,
  comp: CueComp | undefined,
  onComp: (cueId: string, comp: CueComp | null) => void,
  onProblem: (message: string) => void
): CompEdit {
  const undoRef = useRef<(CueComp | null)[]>([])
  const redoRef = useRef<(CueComp | null)[]>([])
  const [depth, setDepth] = useState({ u: 0, r: 0 })

  const currentRef = useRef<CueComp | null>(null)
  currentRef.current = comp && comp.clips.length > 0 ? comp : null

  const cbRef = useRef({ onComp, onProblem })
  cbRef.current = { onComp, onProblem }

  useEffect(() => {
    undoRef.current = []
    redoRef.current = []
    setDepth({ u: 0, r: 0 })
  }, [cueId])

  const sync = useCallback(() => {
    setDepth({ u: undoRef.current.length, r: redoRef.current.length })
  }, [])

  const send = useCallback((next: CueComp | null): boolean => {
    const value = next && next.clips.length > 0 ? normalizeComp(next) : null
    if (value) {
      const problem = compProblem(value)
      if (problem) {
        cbRef.current.onProblem(problem)
        return false
      }
    }
    cbRef.current.onComp(cueId, value)
    return true
  }, [cueId])

  const commit = useCallback(
    (next: CueComp | null) => {
      const prev = currentRef.current
      if (!send(next)) return
      undoRef.current.push(prev)
      if (undoRef.current.length > LIMIT) undoRef.current.shift()
      redoRef.current = []
      sync()
    },
    [send, sync]
  )

  const undo = useCallback(() => {
    if (undoRef.current.length === 0) return
    const prev = undoRef.current[undoRef.current.length - 1]
    const cur = currentRef.current
    if (!send(prev)) return
    undoRef.current.pop()
    redoRef.current.push(cur)
    sync()
  }, [send, sync])

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return
    const next = redoRef.current[redoRef.current.length - 1]
    const cur = currentRef.current
    if (!send(next)) return
    redoRef.current.pop()
    undoRef.current.push(cur)
    sync()
  }, [send, sync])

  return { commit, undo, redo, canUndo: depth.u > 0, canRedo: depth.r > 0 }
}
