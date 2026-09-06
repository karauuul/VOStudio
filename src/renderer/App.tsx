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
  type TimelineViewState,
  type UsageInfo,
  type VoiceSettings,
} from '@shared/domain'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import type { UpdateStatus } from '@shared/updater'
import { api } from './api'
import { clipId, transport } from './audio/transport'
import { playback } from './playback'
import {
  busyCountNow,
  clearTerminalJobs,
  isCueBusyNow,
  useBusyCount,
  useCueBusy,
  useJobCount,
  useJobFailed,
  useJobsStore,
} from './jobs/store'
import { ALL_CHARACTERS, DEFAULT_FILTER, filterCues, groupByCharacter } from '@shared/cue-filter'
import { LinesPanel } from './work/LinesPanel'
import type { TextPanelProps } from './work/TextPanel'
import { ProjectTable, type GridApi } from './ProjectTable'
import { DeliverScreen } from './DeliverScreen'
import { ImportRoom } from './rooms/ImportRoom'
import { WorkRoom } from './rooms/WorkRoom'
import { ExportRoom } from './rooms/ExportRoom'
import { useProjectSession, type StatusKind } from './useProjectSession'
import type { EffectName, EffectsTarget } from './cue/ClipParams'
import { Inspector, type InspectorTab } from './cue/Inspector'
import type { CompApi } from './work/TimelinePanel'
import { CueText } from './work/CueText'
import { TimelinePanel } from './work/TimelinePanel'
import { CharactersDialog } from './CharactersDialog'
import { RulesDialog } from './RulesPanel'
import { ProjectHome } from './ProjectHome'
import { TopBar, type MenuItem, type Route } from './shell/TopBar'
import { StatusToast, type Status } from './StatusToast'
import { SettingsDialog } from './SettingsDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { JobsDrawer } from './JobsDrawer'
import { useTemplateReimport } from './TemplateReimport'
import { useKeyboard, type KeyboardHandlers } from './keyboard'
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
import {
  clipTargetText,
  deriveGenTarget,
  placeTake,
  targetText,
  type GenTarget,
  type TextRange,
} from '@shared/generation'
import { reportTakeDuration } from './audio/duration-backfill'
import { getPeaks } from './Waveform'

type CopyKind = 'source' | 'translation' | 'prompt'

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
  const [effects, setEffects] = useState<EffectsTarget | null>(null)
  const [targetTrack, setTargetTrack] = useState<Record<string, string>>({})
  const [timelineView, setTimelineView] = useState<Record<string, TimelineViewState>>({})
  const [exported, setExported] = useState<ReadonlySet<string>>(() => new Set())
  const [textSel, setTextSel] = useState<TextRange | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const compRef = useRef<CompApi | null>(null)
  const recRef = useRef<(() => void) | null>(null)
  const escRef = useRef<(() => boolean) | null>(null)
  const recActiveRef = useRef<(() => boolean) | null>(null)
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
  const targetTrackRef = useRef<Record<string, string>>({})
  targetTrackRef.current = targetTrack

  const submitJob = useJobsStore((s) => s.submit)
  const jobCount = useJobCount()
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
    setTargetTrack(p.ui.targetTrack ?? {})
    setTimelineView(p.ui.timeline ?? {})
    setActiveCueId(p.ui.activeCueId)
  }, [])

  const refreshExported = useCallback(() => {
    void api['export:last']().then(
      (last) => setExported(new Set(last?.cueIds ?? [])),
      () => setExported(new Set())
    )
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
    refreshExported()
  }, [refreshExported])

  const enterProject = useCallback(
    (snapshot: ProjectSnapshot) => {
      setCharacterFilter(ALL_CHARACTERS)
      setRoute('work')
      setReviewIds(null)
      clearTerminalJobs()
      session.enter(snapshot)
      refreshExported()
    },
    [session, refreshExported]
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

  const grouped = useMemo(() => {
    if (!project) return { cues: [], groups: [] }
    if (reviewIds) {
      const byId = new Map(project.cues.map((c) => [c.id, c]))
      const picked = reviewIds.flatMap((id) => byId.get(id) ?? [])
      return groupByCharacter(picked, project.characters)
    }
    return groupByCharacter(
      filterCues(project.cues, filter, search, liveCharacterFilter),
      project.characters
    )
  }, [project, reviewIds, filter, search, liveCharacterFilter])

  const visible = grouped.cues

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

  useEffect(() => {
    if (!project) return
    saveUi({ activeCueId, filter, search, targetTrack, timeline: timelineView })
  }, [saveUi, activeCueId, filter, search, targetTrack, timelineView, project !== null])

  useEffect(() => setTextSel(null), [activeCueId])

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

  const placeOnComp = useCallback(
    async (cueId: string, take: Take, replaceClipId?: string): Promise<void> => {
      const peaks = await getPeaks(take.file.relPath)
      reportTakeDuration(cueId, take, peaks.duration)
      const duration = take.duration > 0 ? take.duration : peaks.duration
      if (!(duration > 0)) throw new Error('the new take decoded to nothing')
      const cue = projectRef.current?.cues.find((c) => c.id === cueId)
      if (!cue) return
      const state = transport.getState()
      const replace =
        replaceClipId && cue.comp?.clips.some((c) => c.id === replaceClipId)
          ? replaceClipId
          : undefined
      const placed = placeTake({
        comp: cue.comp,
        takeId: take.id,
        duration,
        targetTrackId: targetTrackRef.current[cueId],
        playhead: isActiveCue(cueId)
          ? (compRef.current?.playhead() ?? 0)
          : state.clipId === clipId.comp(cueId)
            ? state.pos
            : 0,
        ...(replace ? { replaceClipId: replace } : {}),
      })
      setTargetTrack((m) => (m[cueId] === placed.trackId ? m : { ...m, [cueId]: placed.trackId }))
      await dispatch({ type: 'cue.setComp', cueId, comp: placed.comp })
      if (isActiveCue(cueId)) selectSource({ kind: 'comp' })
    },
    [projectRef, dispatch, isActiveCue, selectSource]
  )

  const submitTts = useCallback(
    (cueId: string, text: string, announce: boolean, target: GenTarget = { kind: 'all' }) => {
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
          const take = await api['provider:tts']({
            cueId,
            text,
            voiceSettings,
            selectOutput: false,
            ...(target.kind === 'all' ? {} : { fragment: true }),
          })
          onTakeAdded(cueId, take)
          await placeOnComp(cueId, take, target.kind === 'clip' ? target.clipId : undefined)
          if (announce) pushStatus('ok', 'Take placed')
        },
        onError: (e) => pushStatus('err', String(e)),
      })
    },
    [submitJob, onTakeAdded, pushStatus, projectRef, placeOnComp]
  )

  const refuseWithoutKey = useCallback((): boolean => {
    if (hasKey) return false
    pushStatus('err', 'API key missing — open Settings')
    return true
  }, [hasKey, pushStatus])

  const selectedClipId = effects?.clip.id

  const clipTarget = useMemo(
    () =>
      activeCue && selectedClipId
        ? {
            clipId: selectedClipId,
            text: clipTargetText(project ?? undefined, activeCue, selectedClipId),
          }
        : null,
    [project, activeCue, selectedClipId]
  )

  const genTarget = useMemo(() => deriveGenTarget(clipTarget, textSel), [clipTarget, textSel])

  const generate = useCallback(
    (kind: GenTarget['kind']) => {
      const cue = activeCue
      if (!cue) return
      const target: GenTarget =
        kind === 'clip' && clipTarget
          ? { kind: 'clip', clipId: clipTarget.clipId, text: clipTarget.text }
          : kind === 'range' && textSel
            ? { kind: 'range', start: textSel.start, end: textSel.end }
            : { kind: 'all' }
      const text = targetText(cue.text, target)
      if (!text) return
      if (isCueBusyNow(cue.id) || refuseWhileExporting() || refuseWithoutKey()) return
      noteSubmit(cue.id)
      void flushText()
      submitTts(cue.id, text, true, target)
    },
    [
      activeCue,
      clipTarget,
      textSel,
      flushText,
      noteSubmit,
      submitTts,
      refuseWhileExporting,
      refuseWithoutKey,
    ]
  )

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
      goRoute('import')
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
    setEffects(null)
    setTargetTrack({})
    setTimelineView({})
    setExported(new Set())
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

  const renameProject = useCallback(
    (name: string) => {
      void dispatch({ type: 'project.rename', name }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [dispatch, pushStatus]
  )

  const saveVersion = useCallback(() => {
    void api['project:saveVersion']({}).then(
      (versions) => pushStatus('ok', `Saved v${versions[versions.length - 1]?.n ?? 1}`),
      (e: unknown) => pushStatus('err', String(e))
    )
  }, [pushStatus])

  const onKeySaved = useCallback(() => {
    setHasKey(true)
    void api['provider:usage']().then(setUsage)
  }, [])

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
      routeImport: () => goRoute('import'),
      routeWork: () => goRoute('work'),
      routeExport: () => goRoute('export'),
      focusSearch: () =>
        (route === 'import' ? tableSearchRef : queueSearchRef).current?.focus(),
      gridNext: () => gridRef.current?.move(1),
      gridPrev: () => gridRef.current?.move(-1),
      gridOpen: () => gridRef.current?.open(),
      gridToggle: () => gridRef.current?.toggle(),
      gridSelectAll: () => gridRef.current?.selectAll(),
      next: () => move(1),
      prev: () => move(-1),
      generate: () => generate(genTarget.kind),
      approve: () => void onApprove(true),
      approveNext: onApproveNext,
      playPause: () => playback.toggle(),
      playClip: () => playback.playClip(),
      restartActive: () => playback.restart(),
      goIn: () => playback.goIn(),
      goOut: () => playback.goOut(),
      setIn: () => compRef.current?.setIn(),
      setOut: () => compRef.current?.setOut(),
      zoomIn: () => compRef.current?.zoom(1.5),
      zoomOut: () => compRef.current?.zoom(1 / 1.5),
      toolSelect: () => compRef.current?.selectTool(),
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
      genTarget,
      onApprove,
      onApproveNext,
      activeTakes,
      selectSource,
      makeFinal,
      onAcceptSuggestion,
      onRejectSuggestion,
      onCopy,
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

  useKeyboard(handlers, !blocked, {
    home: !project,
    timeline: route === 'work' && !!activeCueId,
    grid: route === 'import',
    deliver: route === 'export',
  })

  const settingsUi = showSettings && (
    <SettingsDialog
      hasKey={hasKey}
      onKeySaved={onKeySaved}
      settings={appSettings}
      onSettings={onAppSettings}
      usage={usage}
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
    ...(updateStatus?.phase === 'ready'
      ? [{ label: 'Update ready · Restart', onClick: () => void api['updater:restart']() }]
      : []),
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

  const lines: ComponentProps<typeof LinesPanel> = {
    cues: visible,
    groups: grouped.groups,
    activeCueId,
    search,
    onSearch: setSearch,
    onSelect: selectCue,
    scrollToIndex: activeIndex,
    searchRef: queueSearchRef,
    exported,
    scope: reviewIds
      ? { label: `Selection · ${visible.length}`, onExit: () => setReviewIds(null) }
      : undefined,
  }

  const text: TextPanelProps = {
    cue: activeCue,
    terms: project.terms ?? [],
    characters: project.characters,
    voice: resolveVoiceSettings(activeCharacter, activeCue),
    target: genTarget,
    onText,
    onSelection: setTextSel,
    onAcceptSuggestion,
    onRejectSuggestion,
    onCharacter: onCueCharacter,
    onVoiceChange,
    hasRange: !!textSel,
    hasClip: !!clipTarget,
  }

  const cueText: ComponentProps<typeof CueText> | null = activeCue
    ? {
        cue: activeCue,
        character: activeCharacter,
        onGenerate: generate,
        onSubmit: noteSubmit,
        cueBusy: activeCueBusy,
        compRef,
        onPlace: placeOnComp,
        recRef,
        escRef,
        recActiveRef,
        guardRef,
        focusTextRef,
        appSettings,
        onAppSettings,
        onTakeAdded,
        onStatus: pushStatus,
        isActiveCue,
        hasKey,
        text,
      }
    : null

  const timeline: ComponentProps<typeof TimelinePanel> = {
    cue: activeCue ?? null,
    cues: project.cues,
    targetTrackId: activeCueId ? targetTrack[activeCueId] : undefined,
    onTargetTrack: (trackId) => {
      if (activeCueId) setTargetTrack((m) => ({ ...m, [activeCueId]: trackId }))
    },
    view: activeCueId ? timelineView[activeCueId] : undefined,
    onView: (v) => {
      if (activeCueId) setTimelineView((m) => ({ ...m, [activeCueId]: v }))
    },
    onComp: onSetComp,
    onOriginal: (original) => {
      if (!activeCueId) return
      void dispatch({ type: 'cue.setOriginal', cueId: activeCueId, original }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    onStatus: pushStatus,
    onEffectsTarget: setEffects,
    compRef,
    busyClipId: activeCueBusy ? (clipTarget?.clipId ?? null) : null,
  }

  const inspector: ComponentProps<typeof Inspector> = {
    tab: inspectorTab,
    onTab: setInspectorTab,
    take: shownTake,
    comp: preview.source.kind === 'comp' ? preview.comp : undefined,
    isFinal: !!output && sameSource(output, preview.source),
    canSetFinal: !!activeCue && setFinalEligible(activeCue, previewSource),
    onSetFinal: makeFinal,
    onDelete: () => shownTake && onDeleteTake(shownTake.id),
    effects,
    effectsLabel: 'Composition',
    onClipEdit,
    onClipTrim,
    onClipEffect,
  }

  const table: Omit<ComponentProps<typeof ProjectTable>, 'hidden'> = {
    project,
    filter,
    search,
    characterFilter: liveCharacterFilter,
    onFilter: setFilter,
    onSearch: setSearch,
    onCharacterFilter: setCharacterFilter,
    searchRef: tableSearchRef,
    gridRef,
    onOpenCue: openCue,
    onReviewSelection: startReviewSelection,
    onGenerate: generateSelected,
    onAssignCharacter: (ids, characterId) => void assignCharacter(ids, characterId),
    onOverlay: setTableOverlay,
  }

  const deliver: Omit<ComponentProps<typeof DeliverScreen>, 'hidden'> = {
    project,
    onStatus: pushStatus,
    onOpenFilter: openFilter,
    onOpenCue: openCue,
    beginExport,
    endExport,
  }

  return (
    <div className="app">
      <TopBar
        name={project.name}
        onRename={renameProject}
        versions={project.versions ?? []}
        onSaveVersion={saveVersion}
        route={route}
        onRoute={goRoute}
        items={menuItems}
        jobsPending={jobCount}
        jobsFailed={jobFailed}
        onJobs={() => setShowJobs(true)}
        onMenu={setMenuOpen}
      />

      <ImportRoom hidden={route !== 'import'} table={table} />

      <WorkRoom
        hidden={route !== 'work'}
        lines={lines}
        total={project.cues.length}
        text={text}
        cueText={cueText}
        timeline={timeline}
        inspector={inspector}
      />

      <ExportRoom hidden={route !== 'export'} deliver={deliver} />

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
