import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import {
  DEFAULT_VOICE_SETTINGS,
  liveTakes,
  normalizeOverride,
  resolveVoiceSettings,
  nextOriginal,
  type ClipEffects,
  type Cue,
  type CueComp,
  type Project,
  type Take,
  type MatchRule,
  type TimelineViewState,
  type UsageInfo,
  type VoiceSettings,
} from '@shared/domain'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import type { UpdateStatus } from '@shared/updater'
import { api, audioUrl } from './api'
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
import { ImportRoom } from './rooms/ImportRoom'
import type { GridApi } from './import/LinesTable'
import { WorkRoom } from './rooms/WorkRoom'
import { ExportRoom } from './rooms/ExportRoom'
import { useProjectSession, type StatusKind } from './useProjectSession'
import { PropertiesPanel } from './work/PropertiesPanel'
import type { CompApi, TimelineSelection } from './work/TimelinePanel'
import type { LibraryPanel } from './work/LibraryPanel'
import { ProgramPanel, type ProgramApi } from './work/ProgramPanel'
import { CueText } from './work/CueText'
import { TimelinePanel } from './work/TimelinePanel'
import { RulesDialog } from './RulesPanel'
import { ProjectHome } from './ProjectHome'
import { TopBar, type MenuItem, type Route } from './shell/TopBar'
import { HotkeyHint } from './shell/HotkeyHint'
import type { MenuEntry } from './shell/ContextMenu'
import { hotkeyText } from './keyboard'
import { StatusToast, type Status } from './StatusToast'
import { SettingsDialog } from './SettingsDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { JobsDrawer } from './JobsDrawer'
import { useKeyboard, type KeyboardHandlers } from './keyboard'
import {
  initialPreviewSource,
  outputSource,
  sameSource,
  setFinalEligible,
  shouldSelectCandidate,
  type PreviewSource,
} from '@shared/workspace-source'
import { compDuration, isEmptyComp } from '@shared/comp'
import { libraryRow, lineLabel, locateText, resolveTake, type LibraryRow } from '@shared/library'
import type { ProjectCommand, ProjectSnapshot } from '@shared/project-commands'
import { buildPrompt } from '@shared/prompt'
import {
  clipTargetText,
  deriveGenTarget,
  placeTake,
  targetText,
  toPercent,
  type GenTarget,
  type TextRange,
} from '@shared/generation'
import { reportTakeDuration } from './audio/duration-backfill'
import { getPeaks, sourceColor } from './Waveform'

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
  const [matchBy, setMatchBy] = useState<MatchRule>('id')
  const [showRules, setShowRules] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [showJobs, setShowJobs] = useState(false)
  const [previewCueId, setPreviewCueId] = useState<string | undefined>(undefined)
  const [previewSource, setPreviewSource] = useState<PreviewSource>({ kind: 'none' })
  const [selection, setSelection] = useState<TimelineSelection | null>(null)
  const [targetTrack, setTargetTrack] = useState<Record<string, string>>({})
  const [timelineView, setTimelineView] = useState<Record<string, TimelineViewState>>({})
  const [exported, setExported] = useState<ReadonlySet<string>>(() => new Set())
  const [textSel, setTextSel] = useState<TextRange | null>(null)
  const [sourceTakeId, setSourceTakeId] = useState<string | null>(null)
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const compRef = useRef<CompApi | null>(null)
  const programRef = useRef<ProgramApi | null>(null)
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

  const onBootstrap = useCallback((p: Project) => {
    setFilter(p.ui.filter || DEFAULT_FILTER)
    setSearch(p.ui.search ?? '')
    setMatchBy(p.ui.matchBy ?? 'id')
    setTargetTrack(p.ui.targetTrack ?? {})
    setTimelineView(p.ui.timeline ?? {})
    setActiveCueId(p.ui.activeCueId)
  }, [])

  const refreshExported = useCallback(() => {
    void api['export:info']().then(
      (info) => setExported(new Set(info.last?.cueIds ?? [])),
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
    setSourceTakeId(null)
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


  useEffect(() => {
    if (!project) return
    saveUi({ activeCueId, filter, search, matchBy, targetTrack, timeline: timelineView })
  }, [saveUi, activeCueId, filter, search, matchBy, targetTrack, timelineView, project !== null])

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
    (cueId: string, takeId: string) => {
      const cue = projectRef.current?.cues.find((c) => c.id === cueId)
      if (!cue) return
      if (sourceTakeId === takeId) setSourceTakeId(null)
      if (previewSource.kind === 'take' && previewSource.takeId === takeId) {
        const rest = liveTakes(cue).filter((t) => t.id !== takeId)
        setPreviewSource(rest[0] ? { kind: 'take', takeId: rest[0].id } : { kind: 'none' })
      }
      void dispatch({ type: 'cue.deleteTake', cueId, takeId }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [projectRef, previewSource, sourceTakeId, dispatch, pushStatus]
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
    (kind: CopyKind, target?: Cue) => {
      const cue = target ?? activeCue
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

  const revealFile = useCallback(
    (absPath: string | undefined) => {
      if (!absPath) return
      void api['shell:reveal'](absPath).catch((e: unknown) => pushStatus('err', String(e)))
    },
    [pushStatus]
  )

  const deleteSelectedSource = useCallback((): boolean => {
    const p = projectRef.current
    const cue = p?.cues.find((c) => c.id === activeCueIdRef.current)
    const row = cue && p && sourceTakeId ? libraryRow(cue, p, sourceTakeId) : undefined
    if (!row) return false
    onDeleteTake(row.cueId, row.take.id)
    return true
  }, [projectRef, sourceTakeId, onDeleteTake])

  const setExcluded = useCallback(
    (cueId: string, excluded: boolean) => {
      void dispatch({ type: 'cue.setExcluded', cueId, excluded }).catch((e: unknown) =>
        pushStatus('err', String(e))
      )
    },
    [dispatch, pushStatus]
  )

  const onRejectSuggestion = useCallback(() => {
    const cue = activeCue
    if (!cue || cue.suggestedText === undefined) return
    void dispatch({ type: 'cue.rejectSuggestion', cueId: cue.id }).catch((e: unknown) =>
      pushStatus('err', String(e))
    )
  }, [activeCue, dispatch, pushStatus])

  const placeOnComp = useCallback(
    async (
      cueId: string,
      take: Take,
      replaceClipId?: string,
      drop?: { trackId: string; at: number }
    ): Promise<void> => {
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
        targetTrackId: drop?.trackId ?? targetTrackRef.current[cueId],
        playhead:
          drop?.at ??
          (isActiveCue(cueId)
            ? (compRef.current?.playhead() ?? 0)
            : state.clipId === clipId.comp(cueId)
              ? state.pos
              : 0),
        ...(replace ? { replaceClipId: replace } : {}),
      })
      setTargetTrack((m) => (m[cueId] === placed.trackId ? m : { ...m, [cueId]: placed.trackId }))
      if (isActiveCue(cueId) && compRef.current) {
        compRef.current.place(placed.comp)
        selectSource({ kind: 'comp' })
        return
      }
      await dispatch({ type: 'cue.setComp', cueId, comp: placed.comp })
    },
    [projectRef, dispatch, isActiveCue, selectSource]
  )

  const pinTake = useCallback(
    (cueId: string, takeId: string, pinned: boolean): Promise<void> =>
      dispatch({ type: 'cue.setTakePinned', cueId, takeId, pinned }).catch((e: unknown) => {
        pushStatus('err', String(e))
        throw e
      }),
    [dispatch, pushStatus]
  )

  const insertSource = useCallback(
    (row: LibraryRow, drop?: { trackId: string; at: number }) => {
      const cueId = activeCueIdRef.current
      if (!cueId) return
      const pin =
        row.cueId === cueId || row.take.pinned === true
          ? Promise.resolve()
          : pinTake(row.cueId, row.take.id, true)
      void pin
        .then(() => placeOnComp(cueId, row.take, undefined, drop))
        .catch((e: unknown) => pushStatus('err', String(e)))
    },
    [pinTake, placeOnComp, pushStatus]
  )

  const submitTts = useCallback(
    (
      cueId: string,
      text: string,
      announce: boolean,
      target: GenTarget = { kind: 'all' },
      override?: VoiceSettings
    ) => {
      submitJob({
        kind: 'tts',
        cueId,
        run: async () => {
          if (announce) pushStatus('info', 'Generating TTS…')
          const project = projectRef.current
          const cue = project?.cues.find((c) => c.id === cueId)
          if (!project || !cue) throw new Error('Cue is no longer in the project')
          const character = project.characters.find((c) => c.id === cue.characterId)
          const voiceSettings = override ?? resolveVoiceSettings(character, cue)
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

  const selectedClipId = selection?.clip?.id

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
    (kind: GenTarget['kind'], onClipId?: string) => {
      const cue = activeCue
      if (!cue) return
      const clip = onClipId
        ? { clipId: onClipId, text: clipTargetText(project ?? undefined, cue, onClipId) }
        : clipTarget
      const target: GenTarget =
        kind === 'clip' && clip
          ? { kind: 'clip', clipId: clip.clipId, text: clip.text }
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
      project,
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

  const runCommand = useCallback(
    (command: ProjectCommand) => {
      void dispatch(command).catch((e: unknown) => pushStatus('err', String(e)))
    },
    [dispatch, pushStatus]
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
    setSelection(null)
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

  const onTakeEffects = useCallback(
    (takeId: string, effects: ClipEffects | undefined) => {
      const p = projectRef.current
      const cue = p?.cues.find((c) => c.id === activeCueIdRef.current)
      const owner = cue && p ? resolveTake(p, cue, takeId)?.cue : undefined
      if (!owner) return
      void dispatch({
        type: 'cue.setTakeEffects',
        cueId: owner.id,
        takeId,
        effects: effects ?? null,
      }).catch((e: unknown) => pushStatus('err', String(e)))
    },
    [projectRef, dispatch, pushStatus]
  )

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
      playPause: () => {
        if (!programRef.current?.toggle()) playback.toggle()
      },
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
        if (!t) return
        selectSource({ kind: 'take', takeId: t.id })
        setSourceTakeId(t.id)
      },
      insertSource: () => programRef.current?.insert(),
      replaceSource: () => programRef.current?.replace(),
      makeFinal,
      deleteClip: () => {
        const el = document.activeElement
        if (el instanceof HTMLElement && el.closest('.panel.lib') && deleteSelectedSource()) return
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
      escape: () => {
        if (escRef.current?.()) return true
        if (sourceTakeId === null) return false
        setSourceTakeId(null)
        return true
      },
      focusText: () => focusTextRef.current?.(),
      muteTrack: () => {
        compRef.current?.muteHovered()
      },
      soloTrack: () => {
        if (!compRef.current?.soloHovered()) onCopy('source')
      },
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
      activeTakes,
      selectSource,
      makeFinal,
      onAcceptSuggestion,
      onRejectSuggestion,
      onCopy,
      sourceTakeId,
      deleteSelectedSource,
    ]
  )

  const blocked = showRules || showSettings || showShortcuts || showJobs || menuOpen

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
    { label: 'Rules…', onClick: () => setShowRules(true) },
    { label: 'Settings', onClick: () => setShowSettings(true) },
    { label: 'Shortcuts', onClick: () => setShowShortcuts(true) },
  ]

  const spliceTranslation = (el: HTMLTextAreaElement, insert: string): void => {
    onText(el.value.slice(0, el.selectionStart) + insert + el.value.slice(el.selectionEnd))
  }

  const lineMenu = (cue: Cue): MenuEntry[] => [
    { label: 'Open', hotkey: 'Enter', onClick: () => void selectCue(cue.id) },
    {
      label: 'Play original',
      disabled: !cue.referenceAudio,
      onClick: () => {
        const rel = cue.referenceAudio?.relPath
        if (rel) void transport.playClip({ id: clipId.original(rel), url: audioUrl(rel) })
      },
    },
    {
      label: 'Play translation',
      disabled: isEmptyComp(cue.comp),
      onClick: () =>
        void selectCue(cue.id).then((ok) => {
          if (ok) window.setTimeout(() => playback.restart(), 0)
        }),
    },
    { sep: true },
    {
      label: 'Generate',
      hotkey: hotkeyText('generate'),
      onClick: () => void generateSelected([cue]),
    },
    {
      label: 'Copy original',
      hotkey: hotkeyText('copySource'),
      onClick: () => onCopy('source', cue),
    },
    {
      label: 'Copy translation',
      hotkey: hotkeyText('copyTranslation'),
      onClick: () => onCopy('translation', cue),
    },
    {
      label: 'Copy as prompt',
      hotkey: hotkeyText('copyPrompt'),
      onClick: () => onCopy('prompt', cue),
    },
    { sep: true },
    {
      label: cue.status === 'excluded' ? 'Include in export' : 'Exclude from export',
      onClick: () => setExcluded(cue.id, cue.status !== 'excluded'),
    },
    {
      label: 'Reveal source file',
      disabled: !cue.referenceAudio,
      onClick: () => revealFile(cue.referenceAudio?.relPath),
    },
    { sep: true },
    {
      label: 'Reset line',
      confirm: 'Reset line?',
      danger: true,
      disabled: isEmptyComp(cue.comp),
      onClick: () => {
        if (activeCueIdRef.current === cue.id && compRef.current) compRef.current.place({ clips: [] })
        else void onSetComp(cue.id, null)
      },
    },
  ]

  const libraryMenu = (row: LibraryRow): MenuEntry[] => {
    const take = row.take
    const users = project.cues.filter((c) =>
      (c.comp?.clips ?? []).some((clip) => clip.sourceTakeId === take.id)
    )
    return [
      {
        label: 'Audition',
        hotkey: hotkeyText('playPause'),
        onClick: () => {
          if (programRef.current?.toggle()) return
          void transport.playClip({ id: clipId.take(take.id), url: audioUrl(take.file.relPath) })
        },
      },
      {
        label: 'Insert at playhead',
        hotkey: hotkeyText('insertSource'),
        onClick: () => insertSource(row),
      },
      {
        label: 'Replace selected clip',
        hotkey: hotkeyText('replaceSource'),
        disabled: !clipTarget,
        onClick: () => {
          const target = compRef.current?.selection()?.clipId
          if (activeCue && target) {
            void placeOnComp(activeCue.id, take, target).catch((e: unknown) =>
              pushStatus('err', String(e))
            )
          }
        },
      },
      { sep: true },
      {
        label: 'Regenerate with same settings',
        disabled: !activeCue || !take.meta.text?.trim(),
        onClick: () => {
          const cue = activeCue
          const text = take.meta.text?.trim()
          if (!cue || !text) return
          if (isCueBusyNow(cue.id) || refuseWhileExporting() || refuseWithoutKey()) return
          noteSubmit(cue.id)
          submitTts(cue.id, text, true, { kind: 'all' }, take.meta.voiceSettings)
        },
      },
      {
        label: take.pinned === true ? 'Unpin' : 'Pin to all lines',
        onClick: () => {
          void pinTake(row.cueId, take.id, take.pinned !== true).catch(() => {})
        },
      },
      {
        label: 'Show where used',
        disabled: users.length === 0,
        submenu: users.map((c) => ({ label: lineLabel(c), onClick: () => openCue(c.id) })),
      },
      { sep: true },
      {
        label: 'Copy text',
        disabled: !take.meta.text?.trim(),
        onClick: () => {
          void navigator.clipboard.writeText(take.meta.text ?? '').then(
            () => pushStatus('ok', 'Copied'),
            (e: unknown) => pushStatus('err', String(e))
          )
        },
      },
      { label: 'Reveal file', onClick: () => revealFile(take.file.relPath) },
      { sep: true },
      {
        label: 'Delete',
        hotkey: hotkeyText('deleteClip'),
        danger: true,
        onClick: () => onDeleteTake(row.cueId, take.id),
      },
    ]
  }

  const originalMenu = (): MenuEntry[] => [
    { label: 'Copy', hotkey: hotkeyText('copySource'), onClick: () => onCopy('source') },
    { label: 'Copy as prompt', hotkey: hotkeyText('copyPrompt'), onClick: () => onCopy('prompt') },
  ]

  const translationMenu = (range: TextRange, el: HTMLTextAreaElement): MenuEntry[] => {
    const comp = activeCue?.comp
    const hit = comp && activeCue ? locateText(comp, activeCue, project, range) : null
    const hasRange = range.end > range.start
    const copySelection = (): void => {
      void navigator.clipboard.writeText(el.value.slice(range.start, range.end))
    }
    return [
      {
        label: 'Generate selection',
        hotkey: hotkeyText('generate'),
        disabled: !hasRange,
        onClick: () => generate('range'),
      },
      {
        label: 'Find on timeline',
        disabled: !hit,
        onClick: () => hit && compRef.current?.selectClip(hit.clipId),
      },
      {
        label: 'Split clip here',
        disabled: !hit,
        onClick: () => hit && compRef.current?.splitAt(hit.clipId, hit.time),
      },
      { sep: true },
      {
        label: 'Cut',
        hotkey: 'Ctrl+X',
        disabled: !hasRange,
        onClick: () => {
          copySelection()
          spliceTranslation(el, '')
        },
      },
      { label: 'Copy', hotkey: 'Ctrl+C', disabled: !hasRange, onClick: copySelection },
      {
        label: 'Paste',
        onClick: () => {
          void navigator.clipboard
            .readText()
            .then((t) => spliceTranslation(el, t))
            .catch((e: unknown) => pushStatus('err', String(e)))
        },
        hotkey: 'Ctrl+V',
      },
    ]
  }

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
    menu: lineMenu,
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
    originalMenu,
    translationMenu,
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

  const sourceRow =
    activeCue && sourceTakeId ? libraryRow(activeCue, project, sourceTakeId) : undefined
  const sourceTake = sourceRow?.take
  const compDur = activeCue?.comp ? compDuration(activeCue.comp) : 0
  const refDur = activeCue?.referenceDuration ?? 0
  const sourceVoice = sourceTake?.meta.voiceSettings ?? resolveVoiceSettings(activeCharacter, activeCue)

  const program: ComponentProps<typeof ProgramPanel> = {
    sourceText: activeCue?.sourceText ?? '',
    text: activeCue?.text ?? '',
    duration: Math.max(compDur, refDur),
    referenceDuration: refDur,
    compDuration: compDur,
    monitorId: activeCueId ? clipId.comp(activeCueId) : null,
    source:
      activeCue && sourceTake
        ? {
            takeId: sourceTake.id,
            label: sourceRow?.label ?? '',
            duration: sourceTake.duration,
            relPath: sourceTake.file.relPath,
            text: sourceTake.meta.text?.trim() || activeCue.text,
            settings: [
              activeCharacter?.name ?? 'No character',
              toPercent(sourceVoice.stability),
              toPercent(sourceVoice.similarity),
              toPercent(sourceVoice.style),
              sourceVoice.speed.toFixed(2),
            ].join(' · '),
            color: sourceColor(sourceTake.kind),
            ...(sourceTake.words ? { words: sourceTake.words } : {}),
          }
        : null,
    onInsert: () => {
      if (activeCue && sourceTake) {
        void placeOnComp(activeCue.id, sourceTake).catch((e: unknown) => pushStatus('err', String(e)))
      }
    },
    onReplace: () => {
      const target = compRef.current?.selection()?.clipId
      if (activeCue && sourceTake && target) {
        void placeOnComp(activeCue.id, sourceTake, target).catch((e: unknown) =>
          pushStatus('err', String(e))
        )
      }
    },
    canReplace: !!clipTarget,
    programRef,
  }

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
    onSelect: setSelection,
    compRef,
    busyClipId: activeCueBusy ? (clipTarget?.clipId ?? null) : null,
    onDropSource: (takeId, trackId, at) => {
      const row = activeCue ? libraryRow(activeCue, project, takeId) : undefined
      if (row) insertSource(row, { trackId, at })
    },
    onRegenerateClip: (clipId) => generate('clip', clipId),
    onPinSource: (takeId, pinned) => {
      const row = activeCue ? libraryRow(activeCue, project, takeId) : undefined
      if (row) void pinTake(row.cueId, takeId, pinned).catch(() => {})
    },
    onShowInLibrary: setSourceTakeId,
  }

  const library: ComponentProps<typeof LibraryPanel> = {
    cue: activeCue ?? null,
    cues: project.cues,
    selectedTakeId: sourceTakeId,
    clipTakeId: selection?.clip?.sourceTakeId ?? null,
    onSelect: (row) => setSourceTakeId((id) => (id === row.take.id ? null : row.take.id)),
    onInsert: (row) => insertSource(row),
    menu: libraryMenu,
  }

  const properties: ComponentProps<typeof PropertiesPanel> = {
    cue: activeCue ?? null,
    cues: project.cues,
    characters: project.characters,
    selection,
    sourceTakeId,
    original: activeCue?.original,
    exportName: activeCue ? activeCue.fields['exportName'] || activeCue.key : '',
    compRef,
    onCharacter: onCueCharacter,
    onOriginal: (patch) => {
      if (!activeCueId) return
      void dispatch({
        type: 'cue.setOriginal',
        cueId: activeCueId,
        original: nextOriginal(activeCue?.original, patch),
      }).catch((e: unknown) => pushStatus('err', String(e)))
    },
    onTakeEffects,
    onPinSource: (takeId, pinned) => {
      const row = activeCue ? libraryRow(activeCue, project, takeId) : undefined
      if (row) void pinTake(row.cueId, takeId, pinned).catch(() => {})
    },
    onDeleteSource: (takeId) => {
      const row = activeCue ? libraryRow(activeCue, project, takeId) : undefined
      if (row) onDeleteTake(row.cueId, takeId)
    },
    onOpenLine: openCue,
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

      <ImportRoom
        hidden={route !== 'import'}
        project={project}
        search={search}
        onSearch={setSearch}
        searchRef={tableSearchRef}
        gridRef={gridRef}
        matchBy={matchBy}
        onMatchBy={setMatchBy}
        hasKey={hasKey}
        onStatus={pushStatus}
        onOpenCue={openCue}
        onReviewSelection={startReviewSelection}
        onGenerate={generateSelected}
        onAssignCharacter={(ids, characterId) => void assignCharacter(ids, characterId)}
        dispatch={dispatch}
        onVoiceSettings={onCharacterVoice}
        onProvider={onCharacterProvider}
        onFlushVoice={flushVoice}
        onCancelVoice={session.cancelCharacterVoice}
      />

      <WorkRoom
        hidden={route !== 'work'}
        lines={lines}
        total={project.cues.length}
        text={text}
        cueText={cueText}
        program={program}
        timeline={timeline}
        library={library}
        properties={properties}
      />

      <ExportRoom
        hidden={route !== 'export'}
        project={project}
        onStatus={pushStatus}
        onOpenCue={openCue}
        onCommand={runCommand}
        beginExport={beginExport}
        endExport={endExport}
      />

      {toastUi}

      <HotkeyHint />

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
