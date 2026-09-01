import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  DEFAULT_VOICE_SETTINGS,
  liveTakes,
  normalizeOverride,
  resolveVoiceSettings,
  type Cue,
  type CueComp,
  type Project,
  type Take,
  type UiSessionState,
  type UsageInfo,
  type VoiceSettings,
} from '@shared/domain'
import { DEFAULT_APP_SETTINGS, type AppSettings, type TakeDurationUpdate } from '@shared/ipc'
import type { UpdateStatus } from '@shared/updater'
import { api, audioUrl } from './api'
import { clipId, transport } from './audio/transport'
import { isCueBusyNow, useBusyCount, useCueBusy, useJobCount, useJobsStore } from './jobs/store'
import { durationQueue } from './audio/duration-backfill'
import { ALL_CHARACTERS, CueList, DEFAULT_FILTER, filterCues } from './CueList'
import { CueEditor } from './CueEditor'
import { Inspector } from './cue/Inspector'
import type { CompApi } from './cue/WaveLanes'
import { TransportBar } from './cue/TransportBar'
import { BatchExportDialog } from './BatchExportDialog'
import { CharactersDialog } from './CharactersDialog'
import { ProjectHome } from './ProjectHome'
import { useKeyboard, type KeyboardHandlers } from './keyboard'
import type { WaveformHandle } from './Waveform'
import { approvalState, hasValidVoicedOutput } from '@shared/approval'
import { applyChangeSet, type ProjectCommand, type ProjectSnapshot } from '@shared/project-commands'

type StatusKind = 'ok' | 'err' | 'info'
type Status = { id: number; kind: StatusKind; text: string } | null

const UPDATE_LABEL: Record<UpdateStatus['phase'], string> = {
  idle: 'Ready',
  checking: 'Checking…',
  available: 'Available',
  downloading: 'Downloading',
  ready: 'Ready',
  'up-to-date': 'Up to date',
  error: 'Error',
}

const TOAST_MS: Record<StatusKind, number> = { ok: 4000, info: 4000, err: 8000 }
const TOAST_FADE_MS = 260

function Toast({ status, onClose }: { status: NonNullable<Status>; onClose: () => void }) {
  const [hover, setHover] = useState(false)
  const [out, setOut] = useState(false)
  const leftRef = useRef(TOAST_MS[status.kind])

  useEffect(() => {
    leftRef.current = TOAST_MS[status.kind]
    setOut(false)
    setHover(false)
  }, [status.id, status.kind])

  useEffect(() => {
    if (out || hover) return
    const left = leftRef.current
    const from = Date.now()
    const t = setTimeout(() => setOut(true), left)
    return () => {
      clearTimeout(t)
      leftRef.current = Math.max(0, left - (Date.now() - from))
    }
  }, [status.id, out, hover])

  useEffect(() => {
    if (!out) return
    const t = setTimeout(onClose, TOAST_FADE_MS)
    return () => clearTimeout(t)
  }, [out, onClose])

  return (
    <div
      className={`toast ${status.kind}` + (out ? ' out' : '')}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="status"
    >
      <span className="toast-tx">{status.text}</span>
      {status.kind === 'err' && (
        <button className="toast-x" onClick={onClose} title="Dismiss">
          ×
        </button>
      )}
    </div>
  )
}

const SIDE = { key: 'vo.sidebar.w', def: 320, min: 280, max: 460 }
const INSP = { key: 'vo.inspector.w', def: 300, min: 280, max: 320 }

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

function storedWidth({ key, def, min, max }: { key: string; def: number; min: number; max: number }): number {
  try {
    const v = parseInt(localStorage.getItem(key) ?? '', 10)
    return Number.isFinite(v) ? clamp(v, min, max) : def
  } catch {
    return def
  }
}

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

function Chip({
  label,
  value,
  total,
  tone,
}: {
  label: string
  value: number
  total: number
  tone?: 'ok' | 'warn'
}) {
  const pct = total > 0 ? Math.min(100, (value / total) * 100) : 0
  return (
    <div className={'chip' + (tone ? ' ' + tone : '')}>
      <div className="chip-top">
        <span className="chip-label">{label}</span>
        <span className="chip-val">
          {value}
          <span className="dim"> / {total}</span>
        </span>
      </div>
      <div className="chip-bar">
        <div className="chip-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null)
  const revisionRef = useRef(0)
  const [activeCueId, setActiveCueId] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState(DEFAULT_FILTER)
  const [characterFilter, setCharacterFilter] = useState(ALL_CHARACTERS)
  const [search, setSearch] = useState('')
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const [keyInput, setKeyInput] = useState('')
  const [status, setStatus] = useState<Status>(null)
  const [bulk, setBulk] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const [showCharacters, setShowCharacters] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sideW, setSideW] = useState(() => storedWidth(SIDE))
  const [rightW, setRightW] = useState(() => storedWidth(INSP))
  const [selectedTakeId, setSelectedTakeId] = useState<string | undefined>(undefined)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const origRef = useRef<WaveformHandle | null>(null)
  const takeRef = useRef<WaveformHandle | null>(null)
  const abRef = useRef<(() => void) | null>(null)
  const compRef = useRef<CompApi | null>(null)
  const recRef = useRef<(() => void) | null>(null)
  const escRef = useRef<(() => boolean) | null>(null)
  const focusTextRef = useRef<(() => void) | null>(null)
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingText = useRef<{ id: string; text: string } | null>(null)
  const uiTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingUi = useRef<UiSessionState | null>(null)
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingVoice = useRef<{ key: string; fn: () => Promise<unknown> } | null>(null)
  const bootstrapped = useRef(false)
  const statusSeq = useRef(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const activeCueIdRef = useRef<string | undefined>(undefined)

  const submitJob = useJobsStore((s) => s.submit)
  const jobCount = useJobCount()
  const busyCount = useBusyCount()
  const activeCueBusy = useCueBusy(activeCueId ?? '')

  useEffect(() => {
    activeCueIdRef.current = activeCueId
  }, [activeCueId])

  const isActiveCue = useCallback((cueId: string) => activeCueIdRef.current === cueId, [])

  const pushStatus = useCallback((kind: StatusKind, text: string) => {
    setStatus({ id: ++statusSeq.current, kind, text })
  }, [])
  const closeStatus = useCallback(() => setStatus(null), [])

  const load = useCallback((snapshot: ProjectSnapshot | null) => {
    const p = snapshot?.project ?? null
    revisionRef.current = snapshot?.revision ?? 0
    setProject(p)
    if (!p) return
    if (!bootstrapped.current) {
      bootstrapped.current = true
      setFilter(p.ui.filter || DEFAULT_FILTER)
      setSearch(p.ui.search ?? '')
      setActiveCueId(p.ui.activeCueId ?? p.cues[0]?.id)
    }
  }, [])

  const dispatch = useCallback(async (command: ProjectCommand) => {
    const result = await api['project:command'](command)
    if (result.revision <= revisionRef.current) return
    revisionRef.current = result.revision
    setProject((current) => current ? applyChangeSet(current, result.changes) : current)
  }, [])

  const enterProject = useCallback(
    (snapshot: ProjectSnapshot) => {
      bootstrapped.current = false
      setCharacterFilter(ALL_CHARACTERS)
      durationQueue.reset()
      load(snapshot)
    },
    [load]
  )

  useEffect(() => {
    void api['provider:hasApiKey']().then(setHasKey)
    void api['provider:usage']().then(setUsage)
    void api['settings:get']()
      .then(setAppSettings)
      .catch(() => {})
    void api['updater:getStatus']().then(setUpdateStatus)
  }, [])

  useEffect(() => api.on('usage:updated', setUsage), [])
  useEffect(() => api.on('updater:status', setUpdateStatus), [])
  useEffect(() => api.on('project:changed', (result) => {
    if (result.revision <= revisionRef.current) return
    revisionRef.current = result.revision
    setProject((current) => current ? applyChangeSet(current, result.changes) : current)
  }), [])

  useEffect(
    () => api.on('takes:durations', (items) => setProject((p) => (p ? applyDurations(p, items) : p))),
    []
  )

  const onAppSettings = useCallback((s: AppSettings) => {
    setAppSettings(s)
    void api['settings:set'](s).catch((e: unknown) =>
      pushStatus('err', String(e))
    )
  }, [pushStatus])

  useEffect(() => {
    try {
      localStorage.setItem(SIDE.key, String(sideW))
      localStorage.setItem(INSP.key, String(rightW))
    } catch {
    }
  }, [sideW, rightW])

  const startDrag = useCallback(
    (side: 'left' | 'right') => (e: ReactMouseEvent) => {
      e.preventDefault()
      const x0 = e.clientX
      const w0 = side === 'left' ? sideW : rightW
      const cfg = side === 'left' ? SIDE : INSP
      const set = side === 'left' ? setSideW : setRightW
      document.body.classList.add('resizing')
      const move = (ev: MouseEvent): void => {
        const dx = side === 'left' ? ev.clientX - x0 : x0 - ev.clientX
        set(clamp(w0 + dx, cfg.min, cfg.max))
      }
      const up = (): void => {
        document.body.classList.remove('resizing')
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [sideW, rightW]
  )

  const visible = useMemo(
    () => (project ? filterCues(project.cues, filter, search, characterFilter) : []),
    [project, filter, search, characterFilter]
  )
  const activeCue = useMemo(
    () => project?.cues.find((c) => c.id === activeCueId),
    [project, activeCueId]
  )
  const activeCharacter = useMemo(
    () => project?.characters.find((c) => c.id === activeCue?.characterId),
    [project, activeCue]
  )
  useEffect(() => {
    if (characterFilter === ALL_CHARACTERS) return
    if (project && !project.characters.some((c) => c.id === characterFilter)) setCharacterFilter(ALL_CHARACTERS)
  }, [project?.characters, characterFilter])

  const activeIndex = useMemo(
    () => visible.findIndex((c) => c.id === activeCueId),
    [visible, activeCueId]
  )

  const activeTakes = useMemo(() => (activeCue ? liveTakes(activeCue) : []), [activeCue])

  const shownTake = useMemo(
    () =>
      activeTakes.find((t) => t.id === selectedTakeId) ??
      activeTakes.find((t) => t.id === activeCue?.finalTakeId),
    [activeTakes, selectedTakeId, activeCue?.finalTakeId]
  )

  const stats = useMemo(() => {
    const s = { translated: 0, generated: 0, approved: 0, suggested: 0 }
    for (const c of project?.cues ?? []) {
      if (c.suggestedText !== undefined) s.suggested++
      if (c.status === 'excluded') continue
      if (c.text.trim()) s.translated++
      if (hasValidVoicedOutput(c)) s.generated++
      if (approvalState(c) === 'approved') s.approved++
    }
    return s
  }, [project])

  useEffect(() => {
    if (!project) return
    const next: UiSessionState = { activeCueId, filter, search }
    pendingUi.current = next
    if (uiTimer.current) clearTimeout(uiTimer.current)
    uiTimer.current = setTimeout(() => {
      pendingUi.current = null
      void api['ui:save'](next).catch(() => {})
    }, 1000)
    return () => {
      if (uiTimer.current) clearTimeout(uiTimer.current)
    }
  }, [activeCueId, filter, search, project !== null])

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

  const mutateCue = useCallback((cueId: string, fn: (c: Cue) => Cue) => {
    setProject((p) => (p ? { ...p, cues: p.cues.map((c) => (c.id === cueId ? fn(c) : c)) } : p))
  }, [])

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
      if (prev && prev.key !== key) flushVoice()
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

  const flushText = useCallback(() => {
    if (textTimer.current) {
      clearTimeout(textTimer.current)
      textTimer.current = null
    }
    const p = pendingText.current
    if (!p) return Promise.resolve()
    pendingText.current = null
    return dispatch({ type: 'cue.saveText', cueId: p.id, text: p.text }).catch((e: unknown) =>
      pushStatus('err', String(e))
    )
  }, [pushStatus, dispatch])

  const onText = useCallback(
    (text: string) => {
      const id = activeCueId
      if (!id) return
      mutateCue(id, (c) => ({ ...c, text }))
      const prev = pendingText.current
      if (prev && prev.id !== id) void flushText()
      pendingText.current = { id, text }
      if (textTimer.current) clearTimeout(textTimer.current)
      textTimer.current = setTimeout(() => void flushText(), 1200)
    },
    [activeCueId, mutateCue, flushText]
  )

  const selectCue = useCallback(
    (cueId: string | undefined) => {
      void flushText()
      void flushVoice()
      transport.stop()
      setActiveCueId(cueId)
      setSelectedTakeId(undefined)
    },
    [flushText, flushVoice]
  )

  const onApprove = useCallback(
    (approved: boolean) => {
      const cue = activeCue
      if (!cue) return
      if (approved && !hasValidVoicedOutput(cue)) {
        pushStatus('err', 'Approval requires a valid voiced output')
        return
      }
      void flushText()
        .then(() => dispatch({ type: 'cue.approve', cueId: cue.id, approved }))
        .catch((e: unknown) => pushStatus('err', String(e)))
    },
    [activeCue, pushStatus, flushText, dispatch]
  )

  const onSetFinal = useCallback(
    (takeId: string) => {
      const cue = activeCue
      if (!cue) return
      if (cue.takes.find((t) => t.id === takeId)?.kind === 'recording') {
        pushStatus('err', 'A raw recording cannot be final — convert it first')
        return
      }
      void dispatch({ type: 'cue.setFinalTake', cueId: cue.id, takeId }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [activeCue, pushStatus, dispatch]
  )

  const onSetComp = useCallback(
    (cueId: string, comp: CueComp | null) => {
      void dispatch({ type: 'cue.setComp', cueId, comp }).catch((e: unknown) => pushStatus('err', String(e)))
    },
    [dispatch, pushStatus]
  )

  const audition = useCallback((take: Take) => {
    void transport.playClip({ id: clipId.take(take.id), url: audioUrl(take.file.relPath) }, 0)
  }, [])

  const makeShownFinal = useCallback(() => {
    if (shownTake && shownTake.kind !== 'recording') onSetFinal(shownTake.id)
  }, [shownTake, onSetFinal])

  const onDeleteTake = useCallback(
    (takeId: string) => {
      const cue = activeCue
      if (!cue || takeId === cue.finalTakeId) return
      const rest = liveTakes(cue).filter((t) => t.id !== takeId)
      setSelectedTakeId(rest[0]?.id)
      void dispatch({ type: 'cue.deleteTake', cueId: cue.id, takeId }).catch((e: unknown) => pushStatus('err', String(e)))
    },
    [activeCue, dispatch, pushStatus]
  )

  const onVoiceChange = useCallback(
    (patch: Partial<VoiceSettings>) => {
      const cue = activeCue
      if (!cue) return
      const base = activeCharacter?.voiceSettings ?? DEFAULT_VOICE_SETTINGS
      const effective = resolveVoiceSettings(activeCharacter, cue)
      const next = normalizeOverride(base, { ...effective, ...patch })
      mutateCue(cue.id, (c) => {
        if (next === null) {
          const { voiceSettingsOverride: _drop, ...rest } = c
          return rest
        }
        return { ...c, voiceSettingsOverride: next }
      })
      debounceVoice(`cue:${cue.id}`, () =>
        dispatch({ type: 'cue.setVoiceOverride', cueId: cue.id, override: next }).catch((e: unknown) =>
          pushStatus('err', String(e))
        )
      )
    },
    [activeCue, activeCharacter, mutateCue, debounceVoice, pushStatus, dispatch]
  )

  const onVoiceReset = useCallback(() => {
    const cue = activeCue
    if (!cue) return
    mutateCue(cue.id, (c) => {
      const { voiceSettingsOverride: _drop, ...rest } = c
      return rest
    })
    debounceVoice(`cue:${cue.id}`, () =>
      dispatch({ type: 'cue.setVoiceOverride', cueId: cue.id, override: null }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    )
  }, [activeCue, mutateCue, debounceVoice, pushStatus, dispatch])

  const onCharacterVoice = useCallback(
    (characterId: string, settings: VoiceSettings) => {
      setProject((p) =>
        p
          ? {
              ...p,
              characters: p.characters.map((c) =>
                c.id === characterId ? { ...c, voiceSettings: settings } : c
              ),
            }
          : p
      )
      debounceVoice(`char:${characterId}`, () =>
        dispatch({ type: 'character.setVoiceSettings', characterId, settings }).catch((e: unknown) =>
          pushStatus('err', String(e))
        )
      )
    },
    [debounceVoice, pushStatus, dispatch]
  )

  const onCueCharacter = useCallback(
    (characterId: string) => {
      const cue = activeCue
      if (!cue || cue.characterId === characterId) return
      void dispatch({ type: 'cue.setCharacter', cueId: cue.id, characterId }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [activeCue, dispatch, pushStatus]
  )

  const onTakeAdded = useCallback(
    (_cueId: string, _take: Take) => {},
    []
  )

  const onAcceptSuggestion = useCallback(() => {
    const cue = activeCue
    if (!cue || cue.suggestedText === undefined) return
    void flushText()
      .then(() => dispatch({ type: 'cue.acceptSuggestion', cueId: cue.id }))
      .catch((e: unknown) => pushStatus('err', String(e)))
  }, [activeCue, flushText, pushStatus, dispatch])

  const onRejectSuggestion = useCallback(() => {
    const cue = activeCue
    if (!cue || cue.suggestedText === undefined) return
    void dispatch({ type: 'cue.rejectSuggestion', cueId: cue.id }).catch((e: unknown) =>
      pushStatus('err', String(e))
    )
  }, [activeCue, dispatch, pushStatus])

  const generate = useCallback(() => {
    if (compRef.current?.promptFragment()) return
    const cue = activeCue
    if (!cue || !cue.text.trim()) return
    if (isCueBusyNow(cue.id)) return
    const cueId = cue.id
    const text = cue.text
    const voiceSettings = resolveVoiceSettings(activeCharacter, cue)
    void flushText()
    submitJob({
      kind: 'tts',
      cueId,
      run: async () => {
        pushStatus('info', 'Generating TTS…')
        const take = await api['provider:tts']({ cueId, text, voiceSettings })
        pushStatus('ok', `Take ready (${take.kind})`)
      },
      onError: (e) => pushStatus('err', String(e)),
    })
  }, [activeCue, activeCharacter, flushText, pushStatus, submitJob])

  const goHome = useCallback(async () => {
    try {
      await flushText()
      await flushVoice()
      await flushUi()
      await durationQueue.flushNow()
      transport.stop()
      await api['project:close']()
    } catch (e) {
      pushStatus('err', String(e))
      return
    }
    durationQueue.reset()
    bootstrapped.current = false
    revisionRef.current = 0
    setProject(null)
    setActiveCueId(undefined)
    setSelectedTakeId(undefined)
  }, [flushText, flushVoice, flushUi, pushStatus])

  async function syncCsv(): Promise<void> {
    setBulk(true)
    try {
      await flushText()
      const r = await api['csv:sync']()
      pushStatus('ok', `CSV: ${r.changedCells} cells changed → ${r.path}`)
    } catch (e) {
      pushStatus('err', String(e))
    } finally {
      setBulk(false)
    }
  }

  async function saveKey(): Promise<void> {
    try {
      await api['provider:setApiKey'](keyInput.trim())
      setHasKey(true)
      setKeyInput('')
      setShowSettings(false)
      void api['provider:usage']().then(setUsage)
      pushStatus('ok', 'API key saved (safeStorage/DPAPI)')
    } catch (e) {
      pushStatus('err', String(e))
    }
  }

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const i = activeIndex < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, activeIndex + delta))
      selectCue(visible[i].id)
    },
    [visible, activeIndex, selectCue]
  )

  const handlers: KeyboardHandlers = useMemo(
    () => ({
      next: () => move(1),
      prev: () => move(-1),
      generate: () => generate(),
      approveToggle: () => onApprove(activeCue ? approvalState(activeCue) !== 'approved' : false),
      playOriginal: () => origRef.current?.toggle(),
      playFinal: () => takeRef.current?.toggle(),
      abCompare: () => abRef.current?.(),
      selectTakeByIndex: (n) => {
        const t = activeTakes[n]
        if (t) setSelectedTakeId(t.id)
      },
      makeFinal: makeShownFinal,
      deleteTake: () => {
        if (compRef.current?.deleteSelected()) return
        if (shownTake) onDeleteTake(shownTake.id)
      },
      splitClip: () => compRef.current?.split(),
      healClip: () => compRef.current?.heal(),
      crossfadeClip: () => compRef.current?.crossfade(),
      undo: () => compRef.current?.undo(),
      redo: () => compRef.current?.redo(),
      auditionTake: () => {
        if (shownTake) audition(shownTake)
      },
      acceptSuggestion: onAcceptSuggestion,
      rejectSuggestion: onRejectSuggestion,
      toggleRecord: () => recRef.current?.(),
      escape: () => escRef.current?.() ?? false,
      focusText: () => focusTextRef.current?.(),
    }),
    [
      move,
      generate,
      onApprove,
      activeCue,
      activeTakes,
      shownTake,
      audition,
      makeShownFinal,
      onDeleteTake,
      onAcceptSuggestion,
      onRejectSuggestion,
    ]
  )
  useKeyboard(handlers, !!project && !showExport && !showCharacters && !menuOpen)

  if (!project) {
    return (
      <>
        <ProjectHome onOpen={enterProject} onStatus={pushStatus} />
        {status && <Toast status={status} onClose={closeStatus} />}
      </>
    )
  }

  const creditsLow = usage ? usage.remaining / Math.max(1, usage.limit) < 0.15 : false

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-id">
          <span className="hdr-name">{project.name}</span>
          <span className="hdr-sub">{project.cues.length} cues</span>
        </div>

        <div className="chips">
          <Chip label="Translated" value={stats.translated} total={project.cues.length} />
          <Chip label="Voiced" value={stats.generated} total={project.cues.length} tone="ok" />
          <Chip label="Approved" value={stats.approved} total={project.cues.length} tone="ok" />
          {stats.suggested > 0 && (
            <Chip
              label="Suggestions"
              value={stats.suggested}
              total={project.cues.length}
              tone="warn"
            />
          )}
        </div>

        <div className="hdr-right">
          {updateStatus?.phase === 'ready' && (
            <button className="btn primary" onClick={() => void api['updater:restart']()}>
              Restart to update
            </button>
          )}
          {}
          {jobCount > 0 && (
            <span className="jobs" title="Generation tasks in the queue">
              <i className="spin" />
              {jobCount} {jobCount === 1 ? 'job' : 'jobs'}
            </span>
          )}
          <span className={'credits' + (creditsLow ? ' low' : '')}>
            {usage
              ? `${usage.remaining.toLocaleString('en-US')} / ${usage.limit.toLocaleString('en-US')} chars`
              : 'credits —'}
          </span>
          {}
          <div className="menu" ref={menuRef}>
            <button
              className="btn ghost menu-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="More"
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="menu-pop" role="menu">
                {}
                <button
                  className="menu-item"
                  role="menuitem"
                  disabled={bulk || busyCount > 0}
                  onClick={() => {
                    setMenuOpen(false)
                    void goHome()
                  }}
                >
                  Home
                </button>
                {project.csvBinding && (
                  <button
                    className="menu-item"
                    role="menuitem"
                    disabled={bulk}
                    onClick={() => {
                      setMenuOpen(false)
                      void syncCsv()
                    }}
                  >
                    Sync CSV
                  </button>
                )}
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowCharacters(true)
                  }}
                >
                  Characters
                </button>
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    void flushText()
                    setShowExport(true)
                  }}
                >
                  Batch Export
                </button>
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    setShowSettings(true)
                  }}
                >
                  Settings
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {(!hasKey || showSettings) && (
        <div className="keybar">
          <span className="lbl">ElevenLabs API key</span>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={hasKey ? 'sk_… (replaces the stored key)' : 'sk_...'}
          />
          <button className="btn primary" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
            Save
          </button>
          {showSettings && updateStatus && (
            <div className="update-setting">
              <span className="lbl">Version {updateStatus.currentVersion}</span>
              <span className="update-state" title={updateStatus.error}>
                {UPDATE_LABEL[updateStatus.phase]}
                {updateStatus.phase === 'downloading' && updateStatus.percent !== undefined
                  ? ` ${Math.round(updateStatus.percent)}%`
                  : ''}
              </span>
              {updateStatus.phase === 'ready' ? (
                <button className="btn primary" onClick={() => void api['updater:restart']()}>
                  Restart to update
                </button>
              ) : (
                <button
                  className="btn ghost"
                  disabled={updateStatus.phase === 'checking' || updateStatus.phase === 'downloading'}
                  onClick={() => void api['updater:check']().then(setUpdateStatus)}
                >
                  Check for updates
                </button>
              )}
            </div>
          )}
          {}
          {showSettings && (
            <button className="icon-btn" onClick={() => setShowSettings(false)} title="Close">
              ×
            </button>
          )}
        </div>
      )}

      <div className="work">
        <div style={{ width: sideW, flex: `0 0 ${sideW}px`, display: 'flex', minHeight: 0 }}>
          <CueList
            cues={visible}
            total={project.cues.length}
            activeCueId={activeCueId}
            filter={filter}
            search={search}
            characters={project.characters}
            characterFilter={characterFilter}
            onFilter={setFilter}
            onSearch={setSearch}
            onCharacterFilter={setCharacterFilter}
            onSelect={selectCue}
            scrollToIndex={activeIndex}
          />
        </div>

        <div className="resizer" onMouseDown={startDrag('left')} title="Drag to resize" />

        <main className="center">
          {activeCue ? (
            <CueEditor
              cue={activeCue}
              character={activeCharacter}
              characters={project.characters}
              onCharacter={onCueCharacter}
              shownTake={shownTake}
              selectedTakeId={selectedTakeId}
              onSelectTake={setSelectedTakeId}
              onText={onText}
              onGenerate={generate}
              onApprove={onApprove}
              onAcceptSuggestion={onAcceptSuggestion}
              onRejectSuggestion={onRejectSuggestion}
              onVoiceChange={onVoiceChange}
              onVoiceReset={onVoiceReset}
              cueBusy={activeCueBusy}
              origRef={origRef}
              takeRef={takeRef}
              abRef={abRef}
              compRef={compRef}
              onComp={onSetComp}
              recRef={recRef}
              escRef={escRef}
              focusTextRef={focusTextRef}
              appSettings={appSettings}
              onAppSettings={onAppSettings}
              onTakeAdded={onTakeAdded}
              onStatus={pushStatus}
              isActiveCue={isActiveCue}
              rulesVersion={project.pronunciationRules}
            />
          ) : (
            <div className="center-empty">Select a cue from the list</div>
          )}
        </main>

        <div className="resizer" onMouseDown={startDrag('right')} title="Drag to resize" />

        <aside className="right" style={{ width: rightW, flex: `0 0 ${rightW}px` }}>
          <Inspector
            take={shownTake}
            isFinal={!!shownTake && shownTake.id === activeCue?.finalTakeId}
            canSetFinal={!!shownTake && shownTake.kind !== 'recording'}
            onSetFinal={makeShownFinal}
            onDelete={() => shownTake && onDeleteTake(shownTake.id)}
            character={activeCharacter}
            onCharacterVoice={onCharacterVoice}
            rules={project.pronunciationRules}
            onRulesSaved={(text) =>
              setProject((p) => (p ? { ...p, pronunciationRules: text } : p))
            }
          />
        </aside>
      </div>

      {}
      <TransportBar />

      {status && <Toast status={status} onClose={closeStatus} />}

      {showExport && <BatchExportDialog onClose={() => setShowExport(false)} />}

      {showCharacters && (
        <CharactersDialog
          characters={project.characters}
          cues={project.cues}
          onVoiceSettings={onCharacterVoice}
          dispatch={dispatch}
          onStatus={pushStatus}
          onClose={() => setShowCharacters(false)}
        />
      )}
    </div>
  )
}
