import { useCallback, useEffect, useRef, useState } from 'react'
import { compProblem, normalizeComp } from '@shared/comp'
import type { CueComp } from '@shared/domain'

const LIMIT = 100

export interface CompEdit {
  commit: (next: CueComp | null) => void
  undo: () => void
  redo: () => void
  pending: () => CueComp | null | undefined
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
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>,
  onProblem: (message: string) => void
): CompEdit {
  const undoRef = useRef<(CueComp | null)[]>([])
  const redoRef = useRef<(CueComp | null)[]>([])
  const inflightRef = useRef(0)
  const pendingRef = useRef<CueComp | null | undefined>(undefined)
  const genRef = useRef(0)
  const [depth, setDepth] = useState({ u: 0, r: 0 })

  const propRef = useRef<CueComp | null>(null)
  propRef.current = comp && comp.clips.length > 0 ? comp : null

  const cbRef = useRef({ onComp, onProblem })
  cbRef.current = { onComp, onProblem }

  useEffect(() => {
    undoRef.current = []
    redoRef.current = []
    inflightRef.current = 0
    pendingRef.current = undefined
    genRef.current += 1
    setDepth({ u: 0, r: 0 })
  }, [cueId])

  const sync = useCallback(() => {
    setDepth({ u: undoRef.current.length, r: redoRef.current.length })
  }, [])

  const current = useCallback(
    (): CueComp | null => (pendingRef.current === undefined ? propRef.current : pendingRef.current),
    []
  )

  const submit = useCallback(
    (value: CueComp | null): void => {
      const gen = genRef.current
      pendingRef.current = value
      inflightRef.current += 1
      void cbRef.current
        .onComp(cueId, value)
        .catch(() => false)
        .then(() => {
          if (gen !== genRef.current) return
          inflightRef.current -= 1
          if (inflightRef.current === 0) pendingRef.current = undefined
        })
    },
    [cueId]
  )

  const commit = useCallback(
    (next: CueComp | null) => {
      const value = next && next.clips.length > 0 ? normalizeComp(next) : null
      if (value) {
        const problem = compProblem(value)
        if (problem) {
          cbRef.current.onProblem(problem)
          return
        }
      }
      const prev = current()
      undoRef.current.push(prev)
      if (undoRef.current.length > LIMIT) undoRef.current.shift()
      redoRef.current = []
      sync()
      submit(value)
    },
    [current, submit, sync]
  )

  const undo = useCallback(() => {
    if (undoRef.current.length === 0) return
    const prev = undoRef.current.pop() as CueComp | null
    const cur = current()
    redoRef.current.push(cur)
    sync()
    submit(prev)
  }, [current, submit, sync])

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return
    const next = redoRef.current.pop() as CueComp | null
    const cur = current()
    undoRef.current.push(cur)
    sync()
    submit(next)
  }, [current, submit, sync])

  const pending = useCallback(() => pendingRef.current, [])

  return { commit, undo, redo, pending, canUndo: depth.u > 0, canRedo: depth.r > 0 }
}
