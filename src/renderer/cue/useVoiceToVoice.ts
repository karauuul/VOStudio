import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_STS_SECONDS, type Cue, type Take, type VoiceSettings } from '@shared/domain'
import { recordingGuard } from '@shared/recording-guard'
import type { AppSettings } from '@shared/ipc'
import { pcmBitDepth } from '@shared/wav-header'
import { api, audioUrl } from '../api'
import { useRecorder, type RecordedClip, type RecorderApi } from '../audio/recorder'
import { clipId, transport } from '../audio/transport'
import { useCueBusy, useJobsStore } from '../jobs/store'
import { credits } from './shared'
import type { ClipSelection } from '../work/TimelinePanel'

interface Options {
  cue: Cue
  voice: VoiceSettings
  appSettings: AppSettings
  onTakeAdded: (cueId: string, take: Take, explicit?: boolean) => void
  onSubmit: (cueId: string) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  isActiveCue: (cueId: string) => boolean
  noVoiceReason: string
  selection: () => ClipSelection | null
  playhead: () => number
  targetTrack: () => string | undefined
  preroll: (at: number, lead: number, onInterrupt: () => void) => Promise<number>
  onPlace: (
    cueId: string,
    take: Take,
    replaceClipId?: string,
    drop?: undefined,
    punch?: PunchPlacement
  ) => Promise<void>
}

export interface PunchPlacement {
  at: number
  hidden: number
  trackId?: string
}

export const PUNCH_PREROLL_SECONDS = 5

export interface VoiceToVoice {
  rec: RecorderApi
  converting: boolean
  toggleRec: () => void
  punch: () => void
  guard: (proceed: () => void) => boolean
  reconvert: (take: Take) => void
  onEscape: () => boolean
}

export function useVoiceToVoice({
  cue,
  voice,
  appSettings,
  onTakeAdded,
  onSubmit,
  onStatus,
  isActiveCue,
  noVoiceReason,
  selection,
  playhead,
  targetTrack,
  preroll,
  onPlace,
}: Options): VoiceToVoice {
  const rec = useRecorder()
  const [saving, setSaving] = useState(false)
  const submitJob = useJobsStore((s) => s.submit)
  const cueBusy = useCueBusy(cue.id)
  const converting = saving || cueBusy

  const preRef = useRef(false)
  const preGen = useRef(0)
  const targetRef = useRef<string | null>(null)
  const punchRef = useRef<number | null>(null)
  const punchTrackRef = useRef<string | undefined>(undefined)
  const savingRef = useRef(false)
  const savedClipRef = useRef<RecordedClip | null>(null)

  const cancelPre = useCallback((): void => {
    preGen.current++
    targetRef.current = null
    punchRef.current = null
    if (!preRef.current) return
    preRef.current = false
    transport.stop()
  }, [])

  const recCancel = rec.cancel
  useEffect(() => {
    cancelPre()
    recCancel()
  }, [cue.id, recCancel, cancelPre])

  const recError = rec.error
  const clearRecError = rec.clearError
  useEffect(() => {
    if (!recError) return
    onStatus('err', recError)
    clearRecError()
  }, [recError, clearRecError, onStatus])

  const startRec = useCallback(() => {
    punchRef.current = null
    const sel = selection()
    if (!sel) {
      targetRef.current = null
      rec.start({
        cueId: cue.id,
        device: appSettings.micDeviceLabel ?? appSettings.micDeviceId,
        bitDepth: pcmBitDepth(appSettings.recordBitDepth),
        countIn: appSettings.countIn,
        autoReference: appSettings.autoReference,
        referenceUrl: cue.referenceAudio ? audioUrl(cue.referenceAudio.relPath) : undefined,
        referenceClipId: cue.referenceAudio
          ? clipId.original(cue.referenceAudio.relPath)
          : undefined,
      })
      return
    }

    targetRef.current = sel.clipId
    const token = ++preGen.current
    const armed = (): void => {
      if (token !== preGen.current) return
      preRef.current = false
      rec.start({
        cueId: cue.id,
        device: appSettings.micDeviceLabel ?? appSettings.micDeviceId,
        bitDepth: pcmBitDepth(appSettings.recordBitDepth),
        countIn: appSettings.countIn,
        autoReference: false,
      })
    }
    if (appSettings.autoReference && sel.reference) {
      const r = sel.reference
      preRef.current = true
      void transport.playRange({ id: r.id, url: r.url }, r.from, r.to).then(armed, armed)
    } else {
      armed()
    }
  }, [rec, appSettings, cue.id, cue.referenceAudio, selection])

  const saveClip = useCallback(
    async (target: string | null): Promise<Take | null> => {
      const clip = rec.clip
      if (!clip || savingRef.current || savedClipRef.current === clip) return null
      const cueId = cue.id
      savedClipRef.current = clip
      savingRef.current = true
      setSaving(true)
      useJobsStore.getState().beginSave()
      try {
        const take = await clip.finish(!!target || punchRef.current !== null)
        targetRef.current = null
        rec.cancel()
        onTakeAdded(cueId, take, true)
        return take
      } catch (e) {
        onStatus('err', String(e))
        rec.cancel()
        return null
      } finally {
        savingRef.current = false
        setSaving(false)
        useJobsStore.getState().endSave()
      }
    },
    [rec, cue.id, onTakeAdded, onStatus]
  )

  const hasClip = !!rec.clip
  const recPhase = rec.phase
  useEffect(() => {
    if (recPhase !== 'preview' || !hasClip || savingRef.current) return
    const cueId = cue.id
    const target = targetRef.current
    const at = punchRef.current
    const trackId = punchTrackRef.current
    const punch = at === null ? undefined : { at, hidden: rec.clip?.hidden ?? 0, ...(trackId ? { trackId } : {}) }
    void saveClip(target).then((take) => {
      punchRef.current = null
      if (!take) return
      onPlace(cueId, take, target ?? undefined, undefined, punch).then(
        () => onStatus('ok', 'Recording placed'),
        (e: unknown) => onStatus('err', String(e))
      )
    })
  }, [recPhase, hasClip, cue.id, saveClip, onPlace, onStatus, rec.clip])

  const submitSts = useCallback(
    (cueId: string, sourceTakeId: string, voiceSettings: VoiceSettings, fragment: boolean) => {
      submitJob({
        kind: 'sts',
        cueId,
        run: async () => {
          const take = await api['provider:sts']({
            cueId,
            sourceTakeId,
            voiceSettings,
            selectOutput: false,
            ...(fragment ? { fragment: true } : {}),
          })
          onTakeAdded(cueId, take)
          await onPlace(cueId, take)
          if (isActiveCue(cueId)) {
            void transport.playClip(
              { id: clipId.take(take.id), url: audioUrl(take.file.relPath) },
              0
            )
          }
          onStatus('ok', 'Voice converted')
        },
        onError: (e) => onStatus('err', String(e)),
      })
    },
    [submitJob, onTakeAdded, onStatus, isActiveCue, onPlace]
  )

  const guard = useCallback(
    (proceed: () => void): boolean => {
      const decision = recordingGuard(rec.phase, hasClip)
      if (decision === 'allow') return false
      if (decision === 'cancel') {
        cancelPre()
        recCancel()
        return false
      }
      onStatus('info', decision === 'block' ? 'Stop the recording first' : 'Saving the recording…')
      return true
    },
    [rec.phase, hasClip, cancelPre, recCancel, onStatus]
  )

  const toggleRec = useCallback(() => {
    if (converting) return
    if (preRef.current) {
      cancelPre()
      return
    }
    switch (rec.phase) {
      case 'idle':
        startRec()
        return
      case 'arming':
      case 'countin':
      case 'recording':
        rec.stop()
        return
    }
  }, [converting, rec, startRec, cancelPre])

  const punch = useCallback(() => {
    if (converting || preRef.current || rec.phase !== 'idle') return
    const at = Math.max(0, playhead())
    targetRef.current = null
    punchRef.current = at
    punchTrackRef.current = targetTrack()
    rec.start({
      cueId: cue.id,
      device: appSettings.micDeviceLabel ?? appSettings.micDeviceId,
      bitDepth: pcmBitDepth(appSettings.recordBitDepth),
      countIn: false,
      autoReference: false,
      preroll: () =>
        preroll(at, Math.min(PUNCH_PREROLL_SECONDS, at), () => {
          if (punchRef.current === at) rec.cancel()
        }),
    })
  }, [converting, rec, playhead, targetTrack, preroll, cue.id, appSettings])

  const recStop = rec.stop
  const recLive = rec.live
  const onEscape = useCallback((): boolean => {
    if (preRef.current) {
      cancelPre()
      return true
    }
    if (recLive()) {
      recStop()
      return true
    }
    if (recPhase === 'arming' || recPhase === 'countin') {
      cancelPre()
      recCancel()
      return true
    }
    return false
  }, [recPhase, recCancel, recStop, recLive, cancelPre])

  const reconvert = useCallback(
    (take: Take) => {
      if (converting) return
      if (take.duration > MAX_STS_SECONDS) {
        onStatus('err', `Recording is ${take.duration.toFixed(1)}s — the STS limit is 5 min`)
        return
      }
      onSubmit(cue.id)
      onStatus('info', `Converting (≈${credits(take.duration)} credits)…`)
      submitSts(cue.id, take.id, voice, take.fragment === true)
    },
    [converting, cue.id, voice, onStatus, onSubmit, submitSts]
  )

  return {
    rec,
    converting,
    toggleRec,
    punch,
    guard,
    reconvert,
    onEscape,
  }
}
