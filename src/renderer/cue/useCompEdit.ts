import { useCallback, useEffect, useReducer, useRef } from 'react'
import { compProblem, normalizeComp } from '@shared/comp'
import { recordCompEdit, stepCompEdit, type CompHistory } from '@shared/comp-history'
import type { CueComp } from '@shared/domain'
import type { StepDir } from '@shared/line-history'

export interface CompEdit {
  commit: (next: CueComp | null) => void
  undo: () => void
  redo: () => void
  pending: () => CueComp | null | undefined
}

export function sameComp(a: CueComp | null, b: CueComp | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export function useCompEdit(
  cueId: string,
  comp: CueComp | undefined,
  history: CompHistory,
  onComp: (cueId: string, comp: CueComp | null) => Promise<boolean>,
  onProblem: (message: string) => void
): CompEdit {
  const inflightRef = useRef(0)
  const pendingRef = useRef<CueComp | null | undefined>(undefined)
  const genRef = useRef(0)
  const [, repaint] = useReducer((n: number) => n + 1, 0)

  const propRef = useRef<CueComp | null>(null)
  propRef.current = comp && comp.clips.length > 0 ? comp : null

  const cbRef = useRef({ onComp, onProblem })
  cbRef.current = { onComp, onProblem }

  useEffect(() => {
    inflightRef.current = 0
    pendingRef.current = undefined
    genRef.current += 1
  }, [cueId])

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
      recordCompEdit(history, cueId, current(), Date.now())
      repaint()
      submit(value)
    },
    [history, cueId, current, submit]
  )

  const step = useCallback(
    (dir: StepDir) => {
      const entry = stepCompEdit(history, cueId, dir, current())
      if (!entry) return
      repaint()
      submit(entry.value)
    },
    [history, cueId, current, submit]
  )

  const undo = useCallback(() => step('undo'), [step])
  const redo = useCallback(() => step('redo'), [step])
  const pending = useCallback(() => pendingRef.current, [])

  return { commit, undo, redo, pending }
}
