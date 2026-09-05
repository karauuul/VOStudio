import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { Cue, Project, UiSessionState } from '@shared/domain'
import type { TakeDurationUpdate } from '@shared/ipc'
import { applyChangeSet, type ProjectCommand, type ProjectSnapshot } from '@shared/project-commands'
import { api } from './api'
import { durationQueue } from './audio/duration-backfill'
import { playback } from './playback'

export type StatusKind = 'ok' | 'err' | 'info'

function applyDurations(project: Project, items: TakeDurationUpdate[]): Project {
  const byCue = new Map<string, Map<string, number>>()
  for (const it of items) {
    let m = byCue.get(it.cueId)
    if (!m) byCue.set(it.cueId, (m = new Map()))
    m.set(it.takeId, it.duration)
  }
  let touched = false
  const cues = project.cues.map((c) => {
    const m = byCue.get(c.id)
    if (!m) return c
    let cueTouched = false
    const takes = c.takes.map((t) => {
      const d = m.get(t.id)
      if (d === undefined || t.duration === d) return t
      cueTouched = true
      return { ...t, duration: d }
    })
    if (!cueTouched) return c
    touched = true
    return { ...c, takes }
  })
  return touched ? { ...project, cues } : project
}

export interface ProjectSession {
  project: Project | null
  projectRef: MutableRefObject<Project | null>
  setProject: Dispatch<SetStateAction<Project | null>>
  mutateCue: (cueId: string, fn: (c: Cue) => Cue) => void
  dispatch: (command: ProjectCommand) => Promise<void>
  enter: (snapshot: ProjectSnapshot) => void
  close: () => Promise<boolean>
  onText: (cueId: string, text: string) => void
  flushText: () => Promise<boolean>
  flushVoice: () => Promise<unknown>
  debounceVoice: (key: string, fn: () => Promise<unknown>) => void
  cancelCharacterVoice: (characterId: string) => void
  saveUi: (next: UiSessionState) => void
}

export function useProjectSession(o: {
  onStatus: (kind: StatusKind, text: string) => void
  onBootstrap: (project: Project) => void
}): ProjectSession {
  const [project, setProject] = useState<Project | null>(null)
  const projectRef = useRef<Project | null>(null)
  projectRef.current = project
  const revisionRef = useRef(0)
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingText = useRef<{ id: string; text: string } | null>(null)
  const textGenRef = useRef(0)
  const uiTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingUi = useRef<UiSessionState | null>(null)
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingVoice = useRef<{ key: string; fn: () => Promise<unknown> } | null>(null)
  const statusRef = useRef(o.onStatus)
  statusRef.current = o.onStatus
  const bootstrapRef = useRef(o.onBootstrap)
  bootstrapRef.current = o.onBootstrap

  const dispatch = useCallback(async (command: ProjectCommand) => {
    const result = await api['project:command'](command)
    if (result.revision <= revisionRef.current) return
    revisionRef.current = result.revision
    setProject((current) => (current ? applyChangeSet(current, result.changes) : current))
  }, [])

  const enter = useCallback((snapshot: ProjectSnapshot) => {
    durationQueue.reset()
    revisionRef.current = snapshot.revision
    setProject(snapshot.project)
    if (snapshot.project) bootstrapRef.current(snapshot.project)
  }, [])

  useEffect(
    () =>
      api.on('project:changed', (result) => {
        if (result.revision <= revisionRef.current) return
        revisionRef.current = result.revision
        setProject((current) => (current ? applyChangeSet(current, result.changes) : current))
      }),
    []
  )

  useEffect(
    () =>
      api.on('takes:durations', (items) =>
        setProject((p) => (p ? applyDurations(p, items) : p))
      ),
    []
  )

  const mutateCue = useCallback((cueId: string, fn: (c: Cue) => Cue) => {
    setProject((p) => (p ? { ...p, cues: p.cues.map((c) => (c.id === cueId ? fn(c) : c)) } : p))
  }, [])

  const flushText = useCallback(() => {
    if (textTimer.current) {
      clearTimeout(textTimer.current)
      textTimer.current = null
    }
    const p = pendingText.current
    if (!p) return Promise.resolve(true)
    pendingText.current = null
    const gen = ++textGenRef.current
    return dispatch({ type: 'cue.saveText', cueId: p.id, text: p.text }).then(
      () => true,
      (e: unknown) => {
        if (gen === textGenRef.current && !pendingText.current) pendingText.current = p
        statusRef.current('err', String(e))
        return false
      }
    )
  }, [dispatch])

  const onText = useCallback(
    (cueId: string, text: string) => {
      mutateCue(cueId, (c) => ({ ...c, text }))
      const prev = pendingText.current
      if (prev && prev.id !== cueId) void flushText()
      pendingText.current = { id: cueId, text }
      if (textTimer.current) clearTimeout(textTimer.current)
      textTimer.current = setTimeout(() => void flushText(), 1200)
    },
    [mutateCue, flushText]
  )

  const flushVoice = useCallback(() => {
    if (voiceTimer.current) {
      clearTimeout(voiceTimer.current)
      voiceTimer.current = null
    }
    const p = pendingVoice.current
    if (!p) return Promise.resolve()
    pendingVoice.current = null
    return p.fn()
  }, [])

  const debounceVoice = useCallback(
    (key: string, fn: () => Promise<unknown>) => {
      const prev = pendingVoice.current
      if (prev && prev.key !== key) void flushVoice()
      pendingVoice.current = { key, fn }
      if (voiceTimer.current) clearTimeout(voiceTimer.current)
      voiceTimer.current = setTimeout(() => {
        voiceTimer.current = null
        const p = pendingVoice.current
        pendingVoice.current = null
        void p?.fn()
      }, 400)
    },
    [flushVoice]
  )

  const cancelCharacterVoice = useCallback((characterId: string) => {
    if (pendingVoice.current?.key !== `char:${characterId}`) return
    pendingVoice.current = null
    if (voiceTimer.current) {
      clearTimeout(voiceTimer.current)
      voiceTimer.current = null
    }
  }, [])

  const saveUi = useCallback((next: UiSessionState) => {
    pendingUi.current = next
    if (uiTimer.current) clearTimeout(uiTimer.current)
    uiTimer.current = setTimeout(() => {
      uiTimer.current = null
      pendingUi.current = null
      void api['ui:save'](next).catch(() => {})
    }, 1000)
  }, [])

  const flushUi = useCallback(() => {
    if (uiTimer.current) {
      clearTimeout(uiTimer.current)
      uiTimer.current = null
    }
    const next = pendingUi.current
    pendingUi.current = null
    if (!next) return Promise.resolve()
    return api['ui:save'](next).catch(() => {})
  }, [])

  const close = useCallback(async (): Promise<boolean> => {
    try {
      const saved = await flushText()
      await flushVoice()
      if (!saved) return false
      await flushUi()
      await durationQueue.flushNow()
      playback.stop()
      await api['project:close']()
    } catch (e) {
      statusRef.current('err', String(e))
      return false
    }
    durationQueue.reset()
    revisionRef.current = 0
    setProject(null)
    return true
  }, [flushText, flushVoice, flushUi])

  return {
    project,
    projectRef,
    setProject,
    mutateCue,
    dispatch,
    enter,
    close,
    onText,
    flushText,
    flushVoice,
    debounceVoice,
    cancelCharacterVoice,
    saveUi,
  }
}
