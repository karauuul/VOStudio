import { useCallback, useRef, useState } from 'react'
import type { Cue, Take, VoiceSettings } from '@shared/domain'
import { api } from '../api'
import { reportTakeDuration } from '../audio/duration-backfill'
import { useJobsStore, isCueBusyNow } from '../jobs/store'
import { getPeaks } from '../Waveform'
import type { CompApi } from './WaveLanes'

interface Options {
  cue: Cue
  voice: VoiceSettings
  compRef: React.MutableRefObject<CompApi | null>
  onTakeAdded: (cueId: string, take: Take) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  isActiveCue: (cueId: string) => boolean
  noVoiceReason: string
}

export interface FragmentApi {
  busyClipId: string | null
  generate: (clipId: string, text: string) => void
  begin: (cueId: string, clipId: string) => void
  release: (cueId: string, clipId: string) => void
  apply: (cueId: string, clipId: string, take: Take) => Promise<void>
}

export function useFragment({
  cue,
  voice,
  compRef,
  onTakeAdded,
  onStatus,
  isActiveCue,
  noVoiceReason,
}: Options): FragmentApi {
  const submitJob = useJobsStore((s) => s.submit)
  const [busy, setBusy] = useState<{ cueId: string; clipId: string } | null>(null)

  const cbRef = useRef({ onTakeAdded, onStatus, isActiveCue, compRef })
  cbRef.current = { onTakeAdded, onStatus, isActiveCue, compRef }

  const begin = useCallback((cueId: string, clipId: string) => {
    setBusy({ cueId, clipId })
  }, [])

  const release = useCallback((cueId: string, clipId: string) => {
    setBusy((b) => (b && b.cueId === cueId && b.clipId === clipId ? null : b))
  }, [])

  const apply = useCallback(
    async (cueId: string, clipId: string, take: Take): Promise<void> => {
      const { onStatus: status, isActiveCue: active, compRef: ref } = cbRef.current
      try {
        const peaks = await getPeaks(take.file.relPath)
        reportTakeDuration(cueId, take, peaks.duration)
        if (!(peaks.duration > 0)) throw new Error('the new take decoded to nothing')
        if (!active(cueId)) return
        ref.current?.replaceSource(clipId, take.id, peaks.duration)
      } catch (e) {
        status('err', `Could not replace the clip: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        release(cueId, clipId)
      }
    },
    [release]
  )

  const generate = useCallback(
    (clipId: string, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (noVoiceReason) {
        onStatus('err', noVoiceReason)
        return
      }
      const cueId = cue.id
      if (isCueBusyNow(cueId)) return
      const voiceSettings = voice
      begin(cueId, clipId)
      submitJob({
        kind: 'tts',
        cueId,
        run: async () => {
          onStatus('info', 'Generating TTS…')
          const take = await api['provider:tts']({
            cueId,
            text: trimmed,
            voiceSettings,
            fragment: true,
          })
          cbRef.current.onTakeAdded(cueId, take)
          await apply(cueId, clipId, take)
          onStatus('ok', 'Fragment replaced')
        },
        onError: (e) => {
          release(cueId, clipId)
          onStatus('err', String(e))
        },
      })
    },
    [cue.id, voice, noVoiceReason, onStatus, submitJob, begin, release, apply]
  )

  return {
    busyClipId: busy && busy.cueId === cue.id ? busy.clipId : null,
    generate,
    begin,
    release,
    apply,
  }
}
