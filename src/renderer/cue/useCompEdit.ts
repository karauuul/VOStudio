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
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const queuedRef = useRef(0)
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
    queueRef.current = Promise.resolve()
    queuedRef.current = 0
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

  const enqueue = useCallback(
    (value: CueComp | null, rollback: () => void): void => {
      const gen = genRef.current
      pendingRef.current = value
      queuedRef.current += 1
      const run = queueRef.current
        .then(() => cbRef.current.onComp(cueId, value))
        .then(
          (ok) => ok,
          () => false
        )
        .then((ok) => {
          if (gen !== genRef.current) return
          queuedRef.current -= 1
          if (queuedRef.current === 0) pendingRef.current = undefined
          if (!ok) {
            rollback()
            sync()
          }
        })
      queueRef.current = run
    },
    [cueId, sync]
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
      enqueue(value, () => {
        const i = undoRef.current.lastIndexOf(prev)
        if (i >= 0) undoRef.current.splice(i, 1)
      })
    },
    [current, enqueue, sync]
  )

  const undo = useCallback(() => {
    if (undoRef.current.length === 0) return
    const prev = undoRef.current.pop() as CueComp | null
    const cur = current()
    redoRef.current.push(cur)
    sync()
    enqueue(prev, () => {
      const i = redoRef.current.lastIndexOf(cur)
      if (i >= 0) redoRef.current.splice(i, 1)
      undoRef.current.push(prev)
    })
  }, [current, enqueue, sync])

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return
    const next = redoRef.current.pop() as CueComp | null
    const cur = current()
    undoRef.current.push(cur)
    sync()
    enqueue(next, () => {
      const i = undoRef.current.lastIndexOf(cur)
      if (i >= 0) undoRef.current.splice(i, 1)
      redoRef.current.push(next)
    })
  }, [current, enqueue, sync])

  const pending = useCallback(() => pendingRef.current, [])

  return { commit, undo, redo, pending, canUndo: depth.u > 0, canRedo: depth.r > 0 }
}
