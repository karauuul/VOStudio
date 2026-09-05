import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import {
  DEFAULT_VOICE_SETTINGS,
  liveTakes,
  normalizeOverride,
  resolveVoiceSettings,
  type ClipEditPatch,
  type Cue,
  type CueComp,
  type Project,
  type Take,
  type UsageInfo,
  type VoiceSettings,
} from '@shared/domain'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import type { UpdateStatus } from '@shared/updater'
import { api } from './api'
import { transport } from './audio/transport'
import { playback } from './playback'
import {
  busyCountNow,
  isCueBusyNow,
  useBusyCount,
  useCueBusy,
  useJobCount,
  useJobFailed,
  useJobTotal,
  useJobsStore,
} from './jobs/store'
import { ALL_CHARACTERS, DEFAULT_FILTER, filterCues } from '@shared/cue-filter'
import { CueList } from './CueList'
import { CueEditor } from './CueEditor'
import { ProjectTable, type GridApi } from './ProjectTable'
import { DeliverScreen } from './DeliverScreen'
import { WorkScreen } from './WorkScreen'
import { useProjectSession, type StatusKind } from './useProjectSession'
import type { EffectName, EffectsTarget } from './cue/ClipParams'
import { Inspector, type InspectorTab } from './cue/Inspector'
import { compositionLabel } from './cue/shared'
import type { CompApi } from './cue/WaveLanes'
import { TransportBar } from './TransportBar'
import { CharactersDialog } from './CharactersDialog'
import { RulesDialog } from './RulesPanel'
import { ProjectHome } from './ProjectHome'
import { ProjectHeader, type MenuItem, type Route } from './ProjectHeader'
import { StatusToast, type Status } from './StatusToast'
import { SettingsDialog } from './SettingsDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { JobsDrawer } from './JobsDrawer'
import { useTemplateReimport } from './TemplateReimport'
import { useKeyboard, type KeyboardHandlers } from './keyboard'
import { approvalState } from '@shared/approval'
import {
  cueDecision,
  initialPreviewSource,
  outputSource,
  resolvePreview,
  sameSource,
  setFinalEligible,
  shouldSelectCandidate,
  type PreviewSource,
} from '@shared/workspace-source'
import { isEmptyComp } from '@shared/comp'
import type { ProjectCommand, ProjectSnapshot } from '@shared/project-commands'
import { buildPrompt } from '@shared/prompt'
import type { CopyKind } from './cue/TextBlock'

export default function App() {
  const [activeCueId, setActiveCueId] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState(DEFAULT_FILTER)
  const [characterFilter, setCharacterFilter] = useState(ALL_CHARACTERS)
  const [search, setSearch] = useState('')
  const [route, setRoute] = useState<Route>('work')
  const [reviewIds, setReviewIds] = useState<string[] | null>(null)
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const [status, setStatus] = useState<Status>(null)
  const [bulk, setBulk] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showCharacters, setShowCharacters] = useState(false)
  const [showRules, setShowRules] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showJobs, setShowJobs] = useState(false)
  const [tableOverlay, setTableOverlay] = useState(false)
  const [previewCueId, setPreviewCueId] = useState<string | undefined>(undefined)
  const [previewSource, setPreviewSource] = useState<PreviewSource>({ kind: 'none' })
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('take')
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [effects, setEffects] = useState<EffectsTarget | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const compRef = useRef<CompApi | null>(null)
  const recRef = useRef<((fragment?: boolean) => void) | null>(null)
  const escRef = useRef<(() => boolean) | null>(null)
  const recActiveRef = useRef<(() => boolean) | null>(null)
  const decisionRef = useRef<(() => boolean) | null>(null)
  const guardRef = useRef<((proceed: () => void) => boolean) | null>(null)
  const gridRef = useRef<GridApi | null>(null)
  const queueSearchRef = useRef<HTMLInputElement>(null)
  const tableSearchRef = useRef<HTMLInputElement>(null)
  const previewSourceRef = useRef<PreviewSource>({ kind: 'none' })
  const submittedRef = useRef<{ cueId: string; source: PreviewSource } | null>(null)
  const focusTextRef = useRef<(() => void) | null>(null)
  const selectSeqRef = useRef(0)
  const statusSeq = useRef(0)
  const activeCueIdRef = useRef<string | undefined>(undefined)
  const exportingRef = useRef(false)

  const submitJob = useJobsStore((s) => s.submit)
  const jobCount = useJobCount()
  const jobTotal = useJobTotal()
  const jobFailed = useJobFailed()
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
  const reimport = useTemplateReimport(pushStatus)

  const onBootstrap = useCallback((p: Project) => {
    setFilter(p.ui.filter || DEFAULT_FILTER)
    setSearch(p.ui.search ?? '')
    setActiveCueId(p.ui.activeCueId ?? p.cues[0]?.id)
  }, [])

  const session = useProjectSession({ onStatus: pushStatus, onBootstrap })
  const {
    project,
    projectRef,
    setProject,
    mutateCue,
    dispatch: sessionDispatch,
    flushText,
    flushVoice,
    debounceVoice,
    saveUi,
    onText: sessionText,
  } = session

  const refuseWhileExporting = useCallback((): boolean => {
    if (!exportingRef.current) return false
    pushStatus('info', 'Export in progress')
    return true
  }, [pushStatus])

  const dispatch = useCallback(
    (command: ProjectCommand): Promise<void> =>
      exportingRef.current
        ? Promise.reject(new Error('Export in progress'))
        : sessionDispatch(command),
    [sessionDispatch]
  )

  const beginExport = useCallback(async (): Promise<boolean> => {
    if (refuseWhileExporting()) return false
    if (busyCountNow() > 0) {
      pushStatus('info', 'Generation is still running')
      return false
    }
    exportingRef.current = true
    const saved = await flushText()
    await flushVoice()
    if (!saved) {
      exportingRef.current = false
      return false
    }
    setExporting(true)
    return true
  }, [flushText, flushVoice, pushStatus])

  const endExport = useCallback(() => {
    exportingRef.current = false
    setExporting(false)
  }, [])

  const enterProject = useCallback(
    (snapshot: ProjectSnapshot) => {
      setCharacterFilter(ALL_CHARACTERS)
      setRoute('work')
      setReviewIds(null)
      session.enter(snapshot)
    },
    [session]
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

  const onAppSettings = useCallback(
    (s: AppSettings) => {
      setAppSettings(s)
      void api['settings:set'](s).catch((e: unknown) => pushStatus('err', String(e)))
    },
    [pushStatus]
  )

  const liveCharacterFilter =
    characterFilter !== ALL_CHARACTERS &&
    project &&
    !project.characters.some((c) => c.id === characterFilter)
      ? ALL_CHARACTERS
      : characterFilter

  const visible = useMemo(() => {
    if (!project) return []
    if (reviewIds) {
      const byId = new Map(project.cues.map((c) => [c.id, c]))
      return reviewIds.flatMap((id) => byId.get(id) ?? [])
    }
    return filterCues(project.cues, filter, search, liveCharacterFilter)
  }, [project, reviewIds, filter, search, liveCharacterFilter])

  const activeCue = useMemo(
    () => project?.cues.find((c) => c.id === activeCueId),
    [project, activeCueId]
  )
  const activeCharacter = useMemo(
    () => project?.characters.find((c) => c.id === activeCue?.characterId),
    [project, activeCue]
  )
  const activeIndex = useMemo(
    () => visible.findIndex((c) => c.id === activeCueId),
    [visible, activeCueId]
  )

  const activeTakes = useMemo(() => (activeCue ? liveTakes(activeCue) : []), [activeCue])

  if (previewCueId !== activeCue?.id) {
    setPreviewCueId(activeCue?.id)
    setPreviewSource(activeCue ? initialPreviewSource(activeCue) : { kind: 'none' })
  } else if (activeCue && previewSource.kind === 'comp' && isEmptyComp(activeCue.comp)) {
    setPreviewSource(initialPreviewSource(activeCue))
  }

  previewSourceRef.current = previewSource

  const noteSubmit = useCallback((cueId: string) => {
    submittedRef.current = { cueId, source: previewSourceRef.current }
  }, [])

  const selectSource = useCallback((source: PreviewSource) => {
    setPreviewSource((prev) => (sameSource(prev, source) ? prev : source))
  }, [])

  const preview = useMemo(
    () => (activeCue ? resolvePreview(activeCue, previewSource) : { source: previewSource }),
    [activeCue, previewSource]
  )
  const shownTake = preview.take
  const output = useMemo(() => (activeCue ? outputSource(activeCue) : null), [activeCue])

  const approved = useMemo(
    () =>
      (project?.cues ?? []).reduce(
        (n, c) => (c.status !== 'excluded' && approvalState(c) === 'approved' ? n + 1 : n),
        0
      ),
    [project]
  )

  useEffect(() => {
    if (!project) return
    saveUi({ activeCueId, filter, search })
  }, [saveUi, activeCueId, filter, search, project !== null])

  const doSelectCue = useCallback(
    async (cueId: string | undefined): Promise<boolean> => {
      const seq = ++selectSeqRef.current
      const saved = await flushText()
      await flushVoice()
      if (!saved || seq !== selectSeqRef.current) return false
      playback.stop()
      setActiveCueId(cueId)
      return true
    },
    [flushText, flushVoice]
  )

  const selectCue = useCallback(
    (cueId: string | undefined): Promise<boolean> => {
      if (cueId === activeCueIdRef.current) {
        selectSeqRef.current++
        return Promise.resolve(true)
      }
      if (guardRef.current?.(() => void doSelectCue(cueId))) return Promise.resolve(false)
      return doSelectCue(cueId)
    },
    [doSelectCue]
  )

  const onText = useCallback(
    (text: string) => {
      const id = activeCueId
      if (!id || refuseWhileExporting()) return
      sessionText(id, text)
    },
    [activeCueId, sessionText, refuseWhileExporting]
  )

  const onApprove = useCallback(
    (approvedNow: boolean): Promise<boolean> => {
      const cue = activeCue
      if (!cue) return Promise.resolve(false)
      if (approvedNow) {
        const decision = cueDecision(cue, previewSource)
        if (decision === 'approved') return Promise.resolve(false)
        if (decision !== 'approve') {
          pushStatus('err', 'Approval requires the previewed source to be the final output')
          return Promise.resolve(false)
        }
      }
      return flushText().then((saved) => {
        if (!saved) return false
        return dispatch({ type: 'cue.approve', cueId: cue.id, approved: approvedNow }).then(
          () => true,
          (e: unknown) => {
            pushStatus('err', String(e))
            return false
          }
        )
      })
    },
    [activeCue, previewSource, pushStatus, flushText, dispatch]
  )

  const onApproveNext = useCallback(() => {
    const cue = activeCue
    if (!cue || cueDecision(cue, previewSource) !== 'approve') return
    const targetId = visible[activeIndex + 1]?.id
    void onApprove(true).then((ok) => {
      if (!ok) return
      if (targetId === undefined) pushStatus('ok', 'Queue complete')
      else void selectCue(targetId)
    })
  }, [activeCue, previewSource, visible, activeIndex, onApprove, selectCue, pushStatus])

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
    (cueId: string, comp: CueComp | null): Promise<boolean> =>
      dispatch({ type: 'cue.setComp', cueId, comp }).then(
        () => {
          if (comp && isActiveCue(cueId)) selectSource({ kind: 'comp' })
          return true
        },
        (e: unknown) => {
          pushStatus('err', String(e))
          return false
        }
      ),
    [dispatch, pushStatus, selectSource, isActiveCue]
  )

  const makeFinal = useCallback(() => {
    const cue = activeCue
    if (!cue) return
    const current = outputSource(cue)
    if (current && sameSource(current, previewSource)) return
    if (previewSource.kind === 'take') {
      onSetFinal(previewSource.takeId)
      return
    }
    if (previewSource.kind === 'comp' && cue.comp && setFinalEligible(cue, previewSource)) {
      onSetComp(cue.id, cue.comp)
    }
  }, [activeCue, previewSource, onSetFinal, onSetComp])

  const onDeleteTake = useCallback(
    (takeId: string) => {
      const cue = activeCue
      if (!cue) return
      if (takeId === cue.finalTakeId) {
        pushStatus('err', 'The final take cannot be deleted')
        return
      }
      if (previewSource.kind === 'take' && previewSource.takeId === takeId) {
        const rest = liveTakes(cue).filter((t) => t.id !== takeId)
        setPreviewSource(rest[0] ? { kind: 'take', takeId: rest[0].id } : { kind: 'none' })
      }
      void dispatch({ type: 'cue.deleteTake', cueId: cue.id, takeId }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [activeCue, previewSource, dispatch, pushStatus]
  )

  const onVoiceChange = useCallback(
    (patch: Partial<VoiceSettings>) => {
      const cue = activeCue
      if (!cue || refuseWhileExporting()) return
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
        dispatch({ type: 'cue.setVoiceOverride', cueId: cue.id, override: next }).catch(
          (e: unknown) => pushStatus('err', String(e))
        )
      )
    },
    [
      activeCue,
      activeCharacter,
      mutateCue,
      debounceVoice,
      pushStatus,
      dispatch,
      refuseWhileExporting,
    ]
  )

  const onVoiceReset = useCallback(() => {
    const cue = activeCue
    if (!cue || refuseWhileExporting()) return
    mutateCue(cue.id, (c) => {
      const { voiceSettingsOverride: _drop, ...rest } = c
      return rest
    })
    debounceVoice(`cue:${cue.id}`, () =>
      dispatch({ type: 'cue.setVoiceOverride', cueId: cue.id, override: null }).catch(
        (e: unknown) => pushStatus('err', String(e))
      )
    )
  }, [activeCue, mutateCue, debounceVoice, pushStatus, dispatch, refuseWhileExporting])

  const onCharacterVoice = useCallback(
    (characterId: string, settings: VoiceSettings) => {
      if (refuseWhileExporting()) return
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
        dispatch({ type: 'character.setVoiceSettings', characterId, settings }).catch(
          (e: unknown) => pushStatus('err', String(e))
        )
      )
    },
    [setProject, debounceVoice, pushStatus, dispatch, refuseWhileExporting]
  )

  const onVoiceDefault = useCallback(() => {
    const cue = activeCue
    const character = activeCharacter
    if (!cue || !character) return
    onCharacterVoice(character.id, resolveVoiceSettings(character, cue))
    onVoiceReset()
  }, [activeCue, activeCharacter, onCharacterVoice, onVoiceReset])

  const onCharacterProvider = useCallback(
    (characterId: string, patch: { voiceId?: string; ttsModel?: string; stsModel?: string }) => {
      if (refuseWhileExporting()) return
      setProject((p) =>
        p
          ? {
              ...p,
              characters: p.characters.map((c) =>
                c.id === characterId ? { ...c, provider: { ...c.provider, ...patch } } : c
              ),
            }
          : p
      )
      void dispatch({ type: 'character.setProvider', characterId, ...patch }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [setProject, dispatch, pushStatus, refuseWhileExporting]
  )

  const onCueCharacter = useCallback(
    (characterId: string) => {
      const cue = activeCue
      if (!cue || cue.characterId === characterId) return
      if (characterFilter !== ALL_CHARACTERS && characterFilter !== characterId) {
        setCharacterFilter(ALL_CHARACTERS)
      }
      void dispatch({ type: 'cue.setCharacter', cueId: cue.id, characterId }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [activeCue, characterFilter, dispatch, pushStatus]
  )

  const onTakeAdded = useCallback(
    (cueId: string, take: Take, explicit?: boolean) => {
      const submitted = submittedRef.current
      const ok = shouldSelectCandidate({
        active: isActiveCue(cueId) && (!!explicit || submitted?.cueId === cueId),
        take,
        submitted: submitted?.source ?? null,
        current: previewSourceRef.current,
        playing: transport.getState().playing,
        recording: recActiveRef.current?.() ?? false,
        explicit,
      })
      if (ok) setPreviewSource({ kind: 'take', takeId: take.id })
    },
    [isActiveCue]
  )

  const onAcceptSuggestion = useCallback(() => {
    const cue = activeCue
    if (!cue || cue.suggestedText === undefined) return
    void flushText()
      .then(() => dispatch({ type: 'cue.acceptSuggestion', cueId: cue.id }))
      .catch((e: unknown) => pushStatus('err', String(e)))
  }, [activeCue, flushText, pushStatus, dispatch])

  const onCopy = useCallback(
    (kind: CopyKind) => {
      const cue = activeCue
      if (!cue || !project) return
      const text =
        kind === 'source'
          ? cue.sourceText
          : kind === 'translation'
            ? cue.text
            : buildPrompt(project, cue)
      void navigator.clipboard.writeText(text).then(
        () => pushStatus('ok', 'Copied'),
        (e: unknown) => pushStatus('err', String(e))
      )
    },
    [activeCue, project, pushStatus]
  )

  const onRejectSuggestion = useCallback(() => {
    const cue = activeCue
    if (!cue || cue.suggestedText === undefined) return
    void dispatch({ type: 'cue.rejectSuggestion', cueId: cue.id }).catch((e: unknown) =>
      pushStatus('err', String(e))
    )
  }, [activeCue, dispatch, pushStatus])

  const submitTts = useCallback(
    (cueId: string, text: string, announce: boolean) => {
      submitJob({
        kind: 'tts',
        cueId,
        run: async () => {
          if (announce) pushStatus('info', 'Generating TTS…')
          const project = projectRef.current
          const cue = project?.cues.find((c) => c.id === cueId)
          if (!project || !cue) throw new Error('Cue is no longer in the project')
          const character = project.characters.find((c) => c.id === cue.characterId)
          const voiceSettings = resolveVoiceSettings(character, cue)
          const take = await api['provider:tts']({ cueId, text, voiceSettings, selectOutput: false })
          onTakeAdded(cueId, take)
          if (announce) pushStatus('ok', `Take ready (${take.kind})`)
        },
        onError: (e) => pushStatus('err', String(e)),
      })
    },
    [submitJob, onTakeAdded, pushStatus, projectRef]
  )

  const refuseWithoutKey = useCallback((): boolean => {
    if (hasKey) return false
    pushStatus('err', 'API key missing — open Settings')
    return true
  }, [hasKey, pushStatus])

  const generate = useCallback(() => {
    const cue = activeCue
    if (!cue || !cue.text.trim()) return
    if (isCueBusyNow(cue.id) || refuseWhileExporting() || refuseWithoutKey()) return
    noteSubmit(cue.id)
    void flushText()
    submitTts(cue.id, cue.text, true)
  }, [activeCue, flushText, noteSubmit, submitTts, refuseWhileExporting, refuseWithoutKey])

  const generateSelected = useCallback(
    async (cues: Cue[]) => {
      if (refuseWhileExporting() || refuseWithoutKey() || !(await flushText())) return
      let queued = 0
      for (const cue of cues) {
        if (isCueBusyNow(cue.id)) continue
        submitTts(cue.id, cue.text, false)
        queued++
      }
      pushStatus('info', `Queued ${queued} ${queued === 1 ? 'job' : 'jobs'}`)
    },
    [flushText, submitTts, pushStatus, refuseWhileExporting, refuseWithoutKey]
  )

  const assignCharacter = useCallback(
    async (cueIds: string[], characterId: string) => {
      const failed: string[] = []
      let busy = 0
      for (const cueId of cueIds) {
        if (isCueBusyNow(cueId)) {
          busy++
          continue
        }
        try {
          await dispatch({ type: 'cue.setCharacter', cueId, characterId })
        } catch {
          const cue = projectRef.current?.cues.find((c) => c.id === cueId)
          failed.push(cue?.fields['EventName'] || cue?.key || cueId)
        }
      }
      const done = cueIds.length - failed.length - busy
      const skipped = busy > 0 ? ` · ${busy} busy, skipped` : ''
      if (failed.length > 0) pushStatus('err', `Assigned ${done}${skipped} · failed: ${failed.join(', ')}`)
      else pushStatus(busy > 0 ? 'info' : 'ok', `Assigned ${done}${skipped}`)
    },
    [dispatch, projectRef, pushStatus]
  )

  const goRoute = useCallback(
    (next: Route) => {
      if (next === route) return
      if (guardRef.current?.(() => setRoute(next))) return
      setRoute(next)
    },
    [route]
  )

  const openFilter = useCallback(
    (id: string) => {
      setFilter(id)
      setReviewIds(null)
      goRoute('project')
    },
    [goRoute]
  )

  const openCue = useCallback(
    (cueId: string) => {
      void selectCue(cueId).then((ok) => {
        if (!ok) return
        setReviewIds(null)
        setRoute('work')
      })
    },
    [selectCue]
  )

  const startReviewSelection = useCallback(
    (cueIds: string[]) => {
      if (cueIds.length === 0) return
      void selectCue(cueIds[0]).then((ok) => {
        if (!ok) return
        setReviewIds(cueIds)
        setRoute('work')
      })
    },
    [selectCue]
  )

  const leaveProject = useCallback(async () => {
    if (!(await session.close())) return
    setActiveCueId(undefined)
    setTimelineOpen(false)
    setEffects(null)
    setRoute('work')
    setReviewIds(null)
  }, [session])

  const goHome = useCallback(() => {
    if (refuseWhileExporting()) return
    if (guardRef.current?.(() => void leaveProject())) return
    void leaveProject()
  }, [leaveProject, refuseWhileExporting])

  const startReimport = useCallback(async () => {
    if (refuseWhileExporting()) return
    const saved = await flushText()
    await flushVoice()
    if (!saved) return
    playback.stop()
    reimport.start()
  }, [flushText, flushVoice, reimport, refuseWhileExporting])

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

  const onKeySaved = useCallback(() => {
    setHasKey(true)
    void api['provider:usage']().then(setUsage)
  }, [])

  const toggleTimeline = useCallback(() => setTimelineOpen((v) => !v), [])

  const openTimeline = useCallback(() => setTimelineOpen(true), [])

  useEffect(() => {
    if (!timelineOpen) return
    const cue = projectRef.current?.cues.find((c) => c.id === activeCueIdRef.current)
    if (cue && !isEmptyComp(cue.comp)) selectSource({ kind: 'comp' })
  }, [timelineOpen, activeCueId, selectSource, projectRef])

  const onClipEdit = useCallback((patch: ClipEditPatch, commit: boolean) => {
    compRef.current?.editSelected(patch, commit)
  }, [])

  const onClipTrim = useCallback((edge: 'start' | 'end', at: number, commit: boolean) => {
    compRef.current?.trimSelected(edge, at, commit)
  }, [])

  const onClipEffect = useCallback((which: EffectName) => {
    compRef.current?.toggleEffect(which)
  }, [])

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
      settings: () => setShowSettings(true),
      shortcuts: () => setShowShortcuts(true),
      routeWork: () => goRoute('work'),
      routeProject: () => goRoute('project'),
      routeDeliver: () => goRoute('deliver'),
      focusSearch: () =>
        (route === 'project' ? tableSearchRef : queueSearchRef).current?.focus(),
      gridNext: () => gridRef.current?.move(1),
      gridPrev: () => gridRef.current?.move(-1),
      gridOpen: () => gridRef.current?.open(),
      gridToggle: () => gridRef.current?.toggle(),
      gridSelectAll: () => gridRef.current?.selectAll(),
      next: () => move(1),
      prev: () => move(-1),
      generate: () => generate(),
      approve: () => void onApprove(true),
      approveNext: onApproveNext,
      playOriginal: () => playback.toggle('orig'),
      playPause: () => playback.toggleTarget(),
      restartActive: () => playback.restart('active'),
      compare: () => playback.compare(),
      stopPlayback: () => playback.stop(),
      selectTake: (n) => {
        const t = activeTakes[n]
        if (t) selectSource({ kind: 'take', takeId: t.id })
      },
      makeFinal,
      deleteClip: () => {
        compRef.current?.deleteSelected()
      },
      splitClip: () => compRef.current?.split(),
      healClip: () => compRef.current?.heal(),
      crossfadeClip: () => compRef.current?.crossfade(),
      undo: () => compRef.current?.undo(),
      redo: () => compRef.current?.redo(),
      acceptSuggestion: onAcceptSuggestion,
      rejectSuggestion: onRejectSuggestion,
      toggleRecord: () => recRef.current?.(),
      toggleFragmentRecord: () => recRef.current?.(true),
      toggleTimeline,
      promptFragment: () => {
        compRef.current?.promptFragment()
      },
      escape: () => escRef.current?.() ?? false,
      focusText: () => focusTextRef.current?.(),
      copySource: () => onCopy('source'),
      copyTranslation: () => onCopy('translation'),
      copyPrompt: () => onCopy('prompt'),
    }),
    [
      goRoute,
      route,
      move,
      generate,
      onApprove,
      onApproveNext,
      activeTakes,
      selectSource,
      makeFinal,
      onAcceptSuggestion,
      onRejectSuggestion,
      onCopy,
      toggleTimeline,
    ]
  )

  const blocked =
    showCharacters ||
    showRules ||
    showSettings ||
    showShortcuts ||
    showJobs ||
    menuOpen ||
    tableOverlay ||
    reimport.open

  useEffect(() => {
    if (blocked) playback.cancelCompare()
  }, [blocked])

  useKeyboard(handlers, !blocked, {
    home: !project,
    timeline: timelineOpen,
    grid: route === 'project',
    deliver: route === 'deliver',
    decision: () => decisionRef.current?.() ?? false,
  })

  const settingsUi = showSettings && (
    <SettingsDialog
      hasKey={hasKey}
      onKeySaved={onKeySaved}
      settings={appSettings}
      onSettings={onAppSettings}
      updateStatus={updateStatus}
      onUpdateStatus={setUpdateStatus}
      onShortcuts={() => setShowShortcuts(true)}
      onStatus={pushStatus}
      onClose={() => setShowSettings(false)}
    />
  )

  const shortcutsUi = showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />

  const toastUi = status && <StatusToast status={status} onClose={closeStatus} />

  if (!project) {
    return (
      <>
        <ProjectHome
          onOpen={enterProject}
          onStatus={pushStatus}
          onSettings={() => setShowSettings(true)}
        />
        {settingsUi}
        {shortcutsUi}
        {toastUi}
      </>
    )
  }

  const menuItems: MenuItem[] = [
    { label: 'Home', disabled: bulk || exporting || busyCount > 0, onClick: goHome },
    ...(project.csvBinding
      ? [{ label: 'Sync CSV', disabled: bulk || exporting, onClick: () => void syncCsv() }]
      : []),
    {
      label: 'Re-import template…',
      disabled: bulk || exporting || busyCount > 0,
      onClick: () => {
        if (guardRef.current?.(() => void startReimport())) return
        void startReimport()
      },
    },
    { label: 'Characters', onClick: () => setShowCharacters(true) },
    { label: 'Rules…', onClick: () => setShowRules(true) },
    { label: 'Settings', onClick: () => setShowSettings(true) },
    { label: 'Shortcuts', onClick: () => setShowShortcuts(true) },
  ]

  const queue: ComponentProps<typeof CueList> = {
    cues: visible,
    allCues: project.cues,
    activeCueId,
    filter,
    search,
    characters: project.characters,
    characterFilter: liveCharacterFilter,
    onFilter: setFilter,
    onSearch: setSearch,
    onCharacterFilter: setCharacterFilter,
    onSelect: selectCue,
    scrollToIndex: activeIndex,
    searchRef: queueSearchRef,
    scope: reviewIds
      ? { label: `Selection · ${visible.length}`, onExit: () => setReviewIds(null) }
      : undefined,
  }

  const editor: ComponentProps<typeof CueEditor> | null = activeCue
    ? {
        cue: activeCue,
        character: activeCharacter,
        characters: project.characters,
        onCharacter: onCueCharacter,
        preview,
        onSelectSource: selectSource,
        onText,
        onCopy,
        terms: project.terms ?? [],
        onGenerate: generate,
        onApprove,
        onApproveNext,
        onSetFinal: makeFinal,
        onDetails: () => setInspectorTab('take'),
        onDeleteTake,
        onSubmit: noteSubmit,
        onAcceptSuggestion,
        onRejectSuggestion,
        cueBusy: activeCueBusy,
        compRef,
        onComp: onSetComp,
        timelineOpen,
        onTimeline: toggleTimeline,
        onEffectsTarget: setEffects,
        recRef,
        escRef,
        recActiveRef,
        decisionRef,
        guardRef,
        focusTextRef,
        appSettings,
        onAppSettings,
        onTakeAdded,
        onStatus: pushStatus,
        isActiveCue,
        hasKey,
        rules: project.pronunciationRules,
      }
    : null

  const inspector: ComponentProps<typeof Inspector> = {
    cueId: activeCue?.id ?? '',
    tab: inspectorTab,
    onTab: setInspectorTab,
    take: shownTake,
    comp: preview.source.kind === 'comp' ? preview.comp : undefined,
    isFinal: !!output && sameSource(output, preview.source),
    canSetFinal: !!activeCue && setFinalEligible(activeCue, previewSource),
    onSetFinal: makeFinal,
    onDelete: () => shownTake && onDeleteTake(shownTake.id),
    character: activeCharacter,
    voice: resolveVoiceSettings(activeCharacter, activeCue),
    voiceOverride: activeCue?.voiceSettingsOverride,
    onVoiceChange,
    onVoiceReset,
    onVoiceDefault,
    effects,
    effectsLabel: timelineOpen && activeCue ? compositionLabel(activeCue) : 'Composition',
    onClipEdit,
    onClipTrim,
    onClipEffect,
    onEditAsComposition:
      !timelineOpen &&
      activeCue &&
      (previewSource.kind === 'comp'
        ? !isEmptyComp(activeCue.comp)
        : !!shownTake && shownTake.kind !== 'recording')
        ? openTimeline
        : undefined,
  }

  return (
    <div className="app">
      <ProjectHeader
        name={project.name}
        cues={project.cues.length}
        approved={approved}
        route={route}
        onRoute={goRoute}
        usage={usage}
        jobsTotal={jobTotal}
        jobsPending={jobCount}
        jobsFailed={jobFailed}
        onJobs={() => setShowJobs(true)}
        updateReady={updateStatus?.phase === 'ready'}
        items={menuItems}
        onMenu={setMenuOpen}
      />

      <WorkScreen
        hidden={route !== 'work'}
        queue={queue}
        editor={editor}
        inspector={inspector}
      />

      <ProjectTable
        hidden={route !== 'project'}
        project={project}
        filter={filter}
        search={search}
        characterFilter={liveCharacterFilter}
        onFilter={setFilter}
        onSearch={setSearch}
        onCharacterFilter={setCharacterFilter}
        searchRef={tableSearchRef}
        gridRef={gridRef}
        onOpenCue={openCue}
        onReviewSelection={startReviewSelection}
        onGenerate={generateSelected}
        onAssignCharacter={(ids, characterId) => void assignCharacter(ids, characterId)}
        onOverlay={setTableOverlay}
      />

      <DeliverScreen
        hidden={route !== 'deliver'}
        project={project}
        onStatus={pushStatus}
        onOpenFilter={openFilter}
        onOpenCue={openCue}
        beginExport={beginExport}
        endExport={endExport}
      />

      <TransportBar />

      {toastUi}

      {reimport.dialog}

      {settingsUi}
      {shortcutsUi}

      {showJobs && (
        <JobsDrawer
          cues={project.cues}
          onOpenCue={(cueId) => {
            setShowJobs(false)
            openCue(cueId)
          }}
          onStatus={pushStatus}
          onClose={() => setShowJobs(false)}
        />
      )}

      {showCharacters && (
        <CharactersDialog
          characters={project.characters}
          cues={project.cues}
          hasKey={hasKey}
          onVoiceSettings={onCharacterVoice}
          onProvider={onCharacterProvider}
          onFlushVoice={flushVoice}
          onCancelVoice={session.cancelCharacterVoice}
          dispatch={dispatch}
          onStatus={pushStatus}
          onClose={() => setShowCharacters(false)}
        />
      )}

      {showRules && (
        <RulesDialog
          rules={project.pronunciationRules}
          cue={activeCue}
          onSaved={(text) => setProject((p) => (p ? { ...p, pronunciationRules: text } : p))}
          onClose={() => setShowRules(false)}
        />
      )}
    </div>
  )
}
