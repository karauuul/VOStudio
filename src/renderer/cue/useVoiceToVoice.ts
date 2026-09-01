import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_STS_SECONDS, type Cue, type Take, type VoiceSettings } from '@shared/domain'
import type { AppSettings } from '@shared/ipc'
import { api, audioUrl } from '../api'
import { useRecorder, type RecorderApi } from '../audio/recorder'
import { clipId, transport } from '../audio/transport'
import { useCueBusy, useJobsStore } from '../jobs/store'
import { credits } from './shared'
import type { FragmentApi } from './useFragment'
import type { ClipSelection } from './WaveLanes'

interface Options {
  cue: Cue
  voice: VoiceSettings
  appSettings: AppSettings
  onTakeAdded: (cueId: string, take: Take) => void
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
  toggleRec: () => void
  convertClip: () => void
  reconvert: (take: Take) => void
  convertBlocked: string
  onEscape: () => boolean
}

export function useVoiceToVoice({
  cue,
  voice,
  appSettings,
  onTakeAdded,
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

  const cancelPre = useCallback((): void => {
    preGen.current++
    targetRef.current = null
    if (!preRef.current) return
    preRef.current = false
    setPre(false)
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

  const toggleRec = useCallback(() => {
    if (converting) return
    if (preRef.current) {
      cancelPre()
      return
    }
    switch (rec.phase) {
      case 'idle':
      case 'preview':
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

  const recPhase = rec.phase
  const onEscape = useCallback((): boolean => {
    if (preRef.current) {
      cancelPre()
      return true
    }
    if (recPhase === 'idle') return false
    cancelPre()
    recCancel()
    return true
  }, [recPhase, recCancel, cancelPre])

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
    const voiceSettings = voice
    const target = targetRef.current
    setSaving(true)
    useJobsStore.getState().beginSave()
    onStatus(
      'info',
      `Converting ${clip.durationSec.toFixed(1)}s (≈${credits(clip.durationSec)} credits)…`
    )
    void (async () => {
      try {
        const recTake = await api['take:saveRecording'](
          cueId,
          clip.wav,
          clip.durationSec,
          clip.sampleRate,
          target ? true : undefined
        )
        onTakeAdded(cueId, recTake)
        targetRef.current = null
        rec.cancel()
        submitSts(
          cueId,
          recTake.id,
          voiceSettings,
          target ? 'Fragment replaced' : 'Voice converted',
          target ? { clipId: target } : {}
        )
      } catch (e) {
        onStatus('err', String(e))
      } finally {
        setSaving(false)
        useJobsStore.getState().endSave()
      }
    })()
  }, [rec, converting, cue.id, voice, onStatus, onTakeAdded, submitSts])

  const reconvert = useCallback(
    (take: Take) => {
      if (converting) return
      if (take.duration > MAX_STS_SECONDS) {
        onStatus('err', `Recording is ${take.duration.toFixed(1)}s — the STS limit is 5 min`)
        return
      }
      onStatus('info', `Converting again (≈${credits(take.duration)} credits)…`)
      submitSts(cue.id, take.id, voice, 'New take from the same recording', {
        mark: take.fragment,
      })
    },
    [converting, cue.id, voice, onStatus, submitSts]
  )

  const convertBlocked =
    noVoiceReason ||
    (rec.clip && rec.clip.durationSec > MAX_STS_SECONDS
      ? `Recording is ${rec.clip.durationSec.toFixed(1)}s — ElevenLabs accepts at most 5 min per request. Record a shorter one.`
      : '')

  return {
    rec,
    converting,
    preroll: pre,
    toggleRec,
    convertClip,
    reconvert,
    convertBlocked,
    onEscape,
  }
}
