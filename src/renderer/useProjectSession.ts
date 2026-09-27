import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import type { Cue, Project, UiSessionState } from '@shared/domain'
import type { TakeDurationUpdate } from '@shared/ipc'
import { applyChangeSet, type ChangeSet, type ProjectCommand, type ProjectSnapshot } from '@shared/project-commands'
import { settleDraft, withSavedText, type TextDraft } from '@shared/text-draft'
import { api } from './api'
import { durationQueue } from './audio/duration-backfill'
import { playback } from './playback'
import { useTextDraft } from './text-draft-store'

const FLUSH_PASSES = 5

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
  draft: TextDraft | null
  setProject: Dispatch<SetStateAction<Project | null>>
  mutateCue: (cueId: string, fn: (c: Cue) => Cue) => void
  dispatch: (command: ProjectCommand, replay?: boolean) => Promise<ChangeSet>
  enter: (snapshot: ProjectSnapshot) => void
  replace: (snapshot: ProjectSnapshot) => void
  abandon: () => void
  close: () => Promise<boolean>
  onText: (cueId: string, text: string) => void
  flushText: () => Promise<boolean>
  flushVoice: () => Promise<boolean>
  debounceVoice: (key: string, fn: () => Promise<unknown>) => void
  cancelCharacterVoice: (characterId: string) => void
  saveUi: (next: UiSessionState) => void
}

export function useProjectSession(o: {
  onStatus: (kind: StatusKind, text: string) => void
  onBootstrap: (project: Project) => void
  onEdit: () => void
  onExternal: (before: Project | null, changes: ChangeSet) => void
}): ProjectSession {
  const [project, setProject] = useState<Project | null>(null)
  const [, setDraftSeen] = useState(0)
  const projectRef = useRef<Project | null>(null)
  projectRef.current = project
  const revisionRef = useRef(0)
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingText = useRef<TextDraft | null>(null)
  const textGenRef = useRef(0)
  const uiTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingUi = useRef<UiSessionState | null>(null)
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingVoice = useRef<{ key: string; fn: () => Promise<unknown> } | null>(null)
  const statusRef = useRef(o.onStatus)
  statusRef.current = o.onStatus
  const bootstrapRef = useRef(o.onBootstrap)
  bootstrapRef.current = o.onBootstrap
  const editRef = useRef(o.onEdit)
  editRef.current = o.onEdit
  const externalRef = useRef(o.onExternal)
  externalRef.current = o.onExternal

  const dispatch = useCallback(async (command: ProjectCommand, replay = false): Promise<ChangeSet> => {
    const result = await api['project:command'](command)
    if (!replay) editRef.current()
    if (result.revision <= revisionRef.current) return result.changes
    revisionRef.current = result.revision
    setProject((current) => (current ? applyChangeSet(current, result.changes) : current))
    return result.changes
  }, [])

  const replace = useCallback((snapshot: ProjectSnapshot) => {
    durationQueue.reset()
    revisionRef.current = snapshot.revision
    if (useTextDraft.getState().draft?.saved) useTextDraft.setState({ draft: null })
    setProject(snapshot.project)
  }, [])

  const enter = useCallback(
    (snapshot: ProjectSnapshot) => {
      replace(snapshot)
      if (snapshot.project) bootstrapRef.current(snapshot.project)
    },
    [replace]
  )

  useEffect(
    () =>
      api.on('project:changed', (result) => {
        editRef.current()
        if (result.revision <= revisionRef.current) return
        revisionRef.current = result.revision
        externalRef.current(projectRef.current, result.changes)
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
    return dispatch({ type: 'cue.saveText', cueId: p.cueId, text: p.text }).then(
      (changes) => {
        const saved = changes.cues?.find((c) => c.id === p.cueId)
        if (saved) setProject((current) => withSavedText(current, saved))
        useTextDraft.setState((s) => ({ draft: settleDraft(s.draft, p) }))
        return true
      },
      (e: unknown) => {
        if (gen === textGenRef.current && !pendingText.current) pendingText.current = p
        statusRef.current('err', String(e))
        return false
      }
    )
  }, [dispatch])

  const onText = useCallback(
    (cueId: string, text: string) => {
      const prev = pendingText.current
      if (prev && prev.cueId !== cueId) void flushText()
      const next = { cueId, text }
      pendingText.current = next
      useTextDraft.setState({ draft: next })
      if (textTimer.current) clearTimeout(textTimer.current)
      textTimer.current = setTimeout(() => void flushText(), 1200)
    },
    [flushText]
  )

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useTextDraft.subscribe(() => {
      clearTimeout(timer)
      timer = setTimeout(() => startTransition(() => setDraftSeen((n) => n + 1)), 100)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  useLayoutEffect(() => {
    if (useTextDraft.getState().draft?.saved) useTextDraft.setState({ draft: null })
  }, [project])

  useEffect(() => {
    let saving = false
    let refused: TextDraft | null = null
    const onUnload = (e: BeforeUnloadEvent): void => {
      if (!pendingText.current || pendingText.current === refused) return
      e.preventDefault()
      e.returnValue = false
      if (saving) return
      saving = true
      const attempt = pendingText.current
      void flushText().then((saved) => {
        saving = false
        if (saved) window.close()
        else if (pendingText.current === attempt) refused = attempt
      })
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [flushText])

  const flushVoice = useCallback(() => {
    if (voiceTimer.current) {
      clearTimeout(voiceTimer.current)
      voiceTimer.current = null
    }
    const p = pendingVoice.current
    if (!p) return Promise.resolve(true)
    pendingVoice.current = null
    return p.fn().then(
      () => true,
      () => {
        if (!pendingVoice.current) pendingVoice.current = p
        return false
      }
    )
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
        void p?.fn().catch(() => undefined)
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

  const abandon = useCallback(() => {
    for (const timer of [textTimer, voiceTimer, uiTimer]) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
    pendingText.current = null
    pendingVoice.current = null
    pendingUi.current = null
    textGenRef.current++
    useTextDraft.setState({ draft: null })
    playback.stop()
    durationQueue.reset()
    revisionRef.current = 0
  }, [])

  const flushAll = useCallback(async (): Promise<boolean> => {
    for (let pass = 0; pendingText.current || pendingVoice.current || pass === 0; pass++) {
      if (pass === FLUSH_PASSES) return false
      const saved = await flushText()
      const voiced = await flushVoice()
      if (!saved || !voiced) return false
    }
    await flushUi()
    await durationQueue.flushNow()
    return true
  }, [flushText, flushVoice, flushUi])

  useEffect(
    () =>
      api.on('bridge:request', ({ id, kind }) => {
        if (kind !== 'flush') return
        void flushAll().then(
          (ok) => api['bridge:reply']({ id, ok, ...(ok ? {} : { error: 'the line text or voice settings could not be saved' }) }),
          (e: unknown) => api['bridge:reply']({ id, ok: false, error: String(e) })
        )
      }),
    [flushAll]
  )

  const close = useCallback(async (): Promise<boolean> => {
    try {
      if (!(await flushAll())) return false
      playback.stop()
      await api['project:close']()
    } catch (e) {
      statusRef.current('err', String(e))
      return false
    }
    abandon()
    setProject(null)
    return true
  }, [flushAll, abandon])

  return {
    project,
    projectRef,
    draft: useTextDraft.getState().draft,
    setProject,
    mutateCue,
    dispatch,
    enter,
    replace,
    abandon,
    close,
    onText,
    flushText,
    flushVoice,
    debounceVoice,
    cancelCharacterVoice,
    saveUi,
  }
}
