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
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>,
  onProblem: (message: string) => void
): CompEdit {
  const undoRef = useRef<(CueComp | null)[]>([])
  const redoRef = useRef<(CueComp | null)[]>([])
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const genRef = useRef(0)
  const [depth, setDepth] = useState({ u: 0, r: 0 })

  const currentRef = useRef<CueComp | null>(null)
  currentRef.current = comp && comp.clips.length > 0 ? comp : null

  const cbRef = useRef({ onComp, onProblem })
  cbRef.current = { onComp, onProblem }

  useEffect(() => {
    undoRef.current = []
    redoRef.current = []
    queueRef.current = Promise.resolve()
    genRef.current += 1
    setDepth({ u: 0, r: 0 })
  }, [cueId])

  const sync = useCallback(() => {
    setDepth({ u: undoRef.current.length, r: redoRef.current.length })
  }, [])

  const send = useCallback(
    async (next: CueComp | null): Promise<boolean> => {
      const value = next && next.clips.length > 0 ? normalizeComp(next) : null
      if (value) {
        const problem = compProblem(value)
        if (problem) {
          cbRef.current.onProblem(problem)
          return false
        }
      }
      const run = queueRef.current.then(() => cbRef.current.onComp(cueId, value))
      queueRef.current = run.catch(() => undefined)
      return run
    },
    [cueId]
  )

  const commit = useCallback(
    (next: CueComp | null) => {
      const gen = genRef.current
      let prev = currentRef.current
      void queueRef.current.then(() => {
        prev = currentRef.current
      })
      void send(next).then((ok) => {
        if (!ok || gen !== genRef.current) return
        undoRef.current.push(prev)
        if (undoRef.current.length > LIMIT) undoRef.current.shift()
        redoRef.current = []
        sync()
      })
    },
    [send, sync]
  )

  const undo = useCallback(() => {
    if (undoRef.current.length === 0) return
    const prev = undoRef.current[undoRef.current.length - 1]
    const cur = currentRef.current
    const gen = genRef.current
    void send(prev).then((ok) => {
      if (!ok || gen !== genRef.current) return
      undoRef.current.pop()
      redoRef.current.push(cur)
      sync()
    })
  }, [send, sync])

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return
    const next = redoRef.current[redoRef.current.length - 1]
    const cur = currentRef.current
    const gen = genRef.current
    void send(next).then((ok) => {
      if (!ok || gen !== genRef.current) return
      redoRef.current.pop()
      undoRef.current.push(cur)
      sync()
    })
  }, [send, sync])

  return { commit, undo, redo, canUndo: depth.u > 0, canRedo: depth.r > 0 }
}
