import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_STS_SECONDS, type Cue, type Take, type VoiceSettings } from '@shared/domain'
import { recordingGuard } from '@shared/recording-guard'
import type { AppSettings } from '@shared/ipc'
import { api, audioUrl } from '../api'
import { useRecorder, type RecorderApi } from '../audio/recorder'
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
  onPlace: (cueId: string, take: Take, replaceClipId?: string) => Promise<void>
}

export interface VoiceToVoice {
  rec: RecorderApi
  converting: boolean
  toggleRec: () => void
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
  const savingRef = useRef(false)

  const cancelPre = useCallback((): void => {
    preGen.current++
    targetRef.current = null
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
    const sel = selection()
    if (!sel) {
      targetRef.current = null
      rec.start({
        deviceId: appSettings.micDeviceId,
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
        deviceId: appSettings.micDeviceId,
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
  }, [rec, appSettings, cue.referenceAudio, selection])

  const saveClip = useCallback(
    async (target: string | null): Promise<Take | null> => {
      const clip = rec.clip
      if (!clip || savingRef.current) return null
      const cueId = cue.id
      savingRef.current = true
      setSaving(true)
      useJobsStore.getState().beginSave()
      try {
        const take = await api['take:saveRecording'](
          cueId,
          clip.wav,
          clip.durationSec,
          clip.sampleRate,
          target ? true : undefined
        )
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
    void saveClip(target).then((take) => {
      if (!take) return
      onPlace(cueId, take, target ?? undefined).then(
        () => onStatus('ok', 'Recording placed'),
        (e: unknown) => onStatus('err', String(e))
      )
    })
  }, [recPhase, hasClip, cue.id, saveClip, onPlace, onStatus])

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
        rec.cancel()
        return
      case 'recording':
        rec.stop()
        return
    }
  }, [converting, rec, startRec, cancelPre])

  const recStop = rec.stop
  const onEscape = useCallback((): boolean => {
    if (preRef.current) {
      cancelPre()
      return true
    }
    if (recPhase === 'recording') {
      recStop()
      return true
    }
    if (recPhase === 'arming' || recPhase === 'countin') {
      cancelPre()
      recCancel()
      return true
    }
    return false
  }, [recPhase, recCancel, recStop, cancelPre])

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
    guard,
    reconvert,
    onEscape,
  }
}
