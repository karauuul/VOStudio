import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_STS_SECONDS, type Cue, type Take, type VoiceSettings } from '@shared/domain'
import { recordingGuard } from '@shared/recording-guard'
import type { AppSettings } from '@shared/ipc'
import { api, audioUrl } from '../api'
import { useRecorder, type RecorderApi } from '../audio/recorder'
import { clipId, transport } from '../audio/transport'
import { useCueBusy, useJobsStore } from '../jobs/store'
import { credits } from './shared'
import type { FragmentApi } from './useFragment'
import type { ClipSelection } from './WaveLanes'

export type PendingChoice = 'save' | 'discard' | 'cancel'

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
  fragment: FragmentApi
}

export interface VoiceToVoice {
  rec: RecorderApi
  converting: boolean
  preroll: boolean
  pending: boolean
  toggleRec: (fragment?: boolean) => void
  saveRecording: () => void
  convertClip: () => void
  discard: () => void
  retake: () => void
  resolvePending: (choice: PendingChoice) => void
  guard: (proceed: () => void) => boolean
  reconvert: (take: Take) => void
  convertBlocked: string
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
  fragment,
}: Options): VoiceToVoice {
  const rec = useRecorder()
  const [saving, setSaving] = useState(false)
  const submitJob = useJobsStore((s) => s.submit)
  const cueBusy = useCueBusy(cue.id)
  const converting = saving || cueBusy

  const [pre, setPre] = useState(false)
  const preRef = useRef(false)
  const preGen = useRef(0)
  const targetRef = useRef<string | null>(null)
  const savingRef = useRef(false)
  const pendingRef = useRef<(() => void) | null>(null)
  const [pending, setPending] = useState(false)

  const cancelPre = useCallback((): void => {
    preGen.current++
    targetRef.current = null
    if (!preRef.current) return
    preRef.current = false
    setPre(false)
    transport.stop()
  }, [])

  const clearPending = useCallback((): void => {
    pendingRef.current = null
    setPending(false)
  }, [])

  const recCancel = rec.cancel
  useEffect(() => {
    clearPending()
    cancelPre()
    recCancel()
  }, [cue.id, recCancel, cancelPre, clearPending])

  const recError = rec.error
  const clearRecError = rec.clearError
  useEffect(() => {
    if (!recError) return
    onStatus('err', recError)
    clearRecError()
  }, [recError, clearRecError, onStatus])

  const startRec = useCallback((useSelection: boolean) => {
    const sel = useSelection ? selection() : null
    if (useSelection && !sel) return
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
      setPre(false)
      rec.start({
        deviceId: appSettings.micDeviceId,
        countIn: appSettings.countIn,
        autoReference: false,
      })
    }
    if (appSettings.autoReference && sel.reference) {
      const r = sel.reference
      preRef.current = true
      setPre(true)
      void transport.playRange({ id: r.id, url: r.url }, r.from, r.to).then(armed, armed)
    } else {
      armed()
    }
  }, [rec, appSettings, cue.referenceAudio, selection])

  const saveClip = useCallback(
    async (select: boolean): Promise<Take | null> => {
      const clip = rec.clip
      if (!clip || savingRef.current) return null
      const cueId = cue.id
      const target = targetRef.current
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
        onTakeAdded(cueId, take, select)
        return take
      } catch (e) {
        onStatus('err', String(e))
        return null
      } finally {
        savingRef.current = false
        setSaving(false)
        useJobsStore.getState().endSave()
      }
    },
    [rec, cue.id, onTakeAdded, onStatus]
  )

  const submitSts = useCallback(
    (
      cueId: string,
      sourceTakeId: string,
      voiceSettings: VoiceSettings,
      okText: string,
      frag: { clipId?: string; mark?: boolean } = {}
    ) => {
      const target = frag.clipId ?? null
      const isFragment = !!target || !!frag.mark
      if (target) fragment.begin(cueId, target)
      submitJob({
        kind: 'sts',
        cueId,
        run: async () => {
          const take = await api['provider:sts']({
            cueId,
            sourceTakeId,
            voiceSettings,
            selectOutput: false,
            ...(isFragment ? { fragment: true } : {}),
          })
          onTakeAdded(cueId, take)
          if (target) {
            await fragment.apply(cueId, target, take)
          } else if (isActiveCue(cueId)) {
            void transport.playClip(
              { id: clipId.take(take.id), url: audioUrl(take.file.relPath) },
              0
            )
          }
          onStatus('ok', okText)
        },
        onError: (e) => {
          if (target) fragment.release(cueId, target)
          onStatus('err', String(e))
        },
      })
    },
    [submitJob, onTakeAdded, onStatus, isActiveCue, fragment]
  )

  const convertClip = useCallback(() => {
    const clip = rec.clip
    if (!clip || converting) return
    const cueId = cue.id
    const target = targetRef.current
    const voiceSettings = voice
    clearPending()
    onSubmit(cueId)
    onStatus(
      'info',
      `Converting ${clip.durationSec.toFixed(1)}s (≈${credits(clip.durationSec)} credits)…`
    )
    void saveClip(false).then((recTake) => {
      if (!recTake) return
      submitSts(
        cueId,
        recTake.id,
        voiceSettings,
        target ? 'Fragment replaced' : 'Voice converted',
        target ? { clipId: target } : {}
      )
    })
  }, [rec.clip, converting, cue.id, voice, clearPending, onSubmit, onStatus, saveClip, submitSts])

  const saveRecording = useCallback(() => {
    if (!rec.clip || converting) return
    clearPending()
    void saveClip(true).then((take) => {
      if (take) onStatus('ok', 'Recording saved')
    })
  }, [rec.clip, converting, clearPending, saveClip, onStatus])

  const discard = useCallback(() => {
    clearPending()
    recCancel()
  }, [clearPending, recCancel])

  const guard = useCallback(
    (proceed: () => void): boolean => {
      const decision = recordingGuard(rec.phase, !!rec.clip)
      if (decision === 'block') {
        onStatus('info', 'Stop the recording first')
        return true
      }
      if (decision === 'cancel') {
        cancelPre()
        recCancel()
        return false
      }
      if (decision === 'allow') return false
      pendingRef.current = proceed
      setPending(true)
      return true
    },
    [rec.phase, rec.clip, cancelPre, recCancel, onStatus]
  )

  const resolvePending = useCallback(
    (choice: PendingChoice) => {
      const run = pendingRef.current
      clearPending()
      if (choice === 'cancel') return
      if (choice === 'discard') {
        recCancel()
        run?.()
        return
      }
      void saveClip(true).then((take) => {
        if (!take) return
        onStatus('ok', 'Recording saved')
        run?.()
      })
    },
    [clearPending, recCancel, saveClip, onStatus]
  )

  const retake = useCallback(() => {
    if (converting) return
    const frag = targetRef.current !== null
    const again = (): void => startRec(frag)
    if (guard(again)) return
    again()
  }, [converting, guard, startRec])

  const toggleRec = useCallback((fragment?: boolean) => {
    if (converting) return
    if (preRef.current) {
      cancelPre()
      return
    }
    switch (rec.phase) {
      case 'idle':
        startRec(fragment === true)
        return
      case 'preview':
        retake()
        return
      case 'arming':
      case 'countin':
        rec.cancel()
        return
      case 'recording':
        rec.stop()
        return
    }
  }, [converting, rec, startRec, retake, cancelPre])

  const recPhase = rec.phase
  const hasClip = !!rec.clip
  const recStop = rec.stop
  const onEscape = useCallback((): boolean => {
    if (preRef.current) {
      cancelPre()
      return true
    }
    if (pendingRef.current !== null || pending) {
      clearPending()
      return true
    }
    const decision = recordingGuard(recPhase, hasClip)
    if (decision === 'allow') {
      if (recPhase === 'preview') recCancel()
      return recPhase !== 'idle'
    }
    if (decision === 'block') {
      recStop()
      return true
    }
    if (decision === 'cancel') {
      cancelPre()
      recCancel()
      return true
    }
    pendingRef.current = null
    setPending(true)
    return true
  }, [recPhase, hasClip, pending, recCancel, recStop, cancelPre, clearPending])

  const reconvert = useCallback(
    (take: Take) => {
      if (converting) return
      if (take.duration > MAX_STS_SECONDS) {
        onStatus('err', `Recording is ${take.duration.toFixed(1)}s — the STS limit is 5 min`)
        return
      }
      onSubmit(cue.id)
      onStatus('info', `Converting again (≈${credits(take.duration)} credits)…`)
      submitSts(cue.id, take.id, voice, 'New take from the same recording', {
        mark: take.fragment,
      })
    },
    [converting, cue.id, voice, onStatus, onSubmit, submitSts]
  )

  const convertBlocked =
    noVoiceReason ||
    (rec.clip && rec.clip.durationSec > MAX_STS_SECONDS
      ? `Recording is ${rec.clip.durationSec.toFixed(1)}s — the STS limit is 5 min`
      : '')

  return {
    rec,
    converting,
    preroll: pre,
    pending,
    toggleRec,
    saveRecording,
    convertClip,
    discard,
    retake,
    resolvePending,
    guard,
    reconvert,
    convertBlocked,
    onEscape,
  }
}
