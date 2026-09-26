import type { Take } from '@shared/domain'
import type { PassRange } from '@shared/loop-record'
import type { PcmBitDepth } from '@shared/wav-header'
import { api } from '../api'
import { pcm16, pcm24 } from './wav'

const CHUNK_SECONDS = 0.5

export interface RecStream {
  frames: () => number
  push: (samples: Float32Array) => void
  finish: (fragment: boolean) => Promise<Take>
  finishPasses: (passes: readonly PassRange[]) => Promise<Take[]>
  abort: () => void
}

const encoders: Record<PcmBitDepth, (samples: Float32Array) => Uint8Array> = {
  16: (samples) => new Uint8Array(pcm16(samples).buffer),
  24: pcm24,
}

export function openRecStream(
  cueId: string,
  sampleRate: number,
  bitDepth: PcmBitDepth,
  onError: (error: unknown) => void
): RecStream {
  const batchFrames = Math.round(sampleRate * CHUNK_SECONDS)
  const encode = encoders[bitDepth]
  let session: Promise<string> | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let batch: Uint8Array[] = []
  let batched = 0
  let frames = 0
  let open = true
  let failed: unknown = null

  const id = (): Promise<string> => (session ??= api['rec:begin']({ cueId, sampleRate, bitDepth }))

  const send = (): void => {
    if (batched === 0) return
    const pcm = new Uint8Array(batched * (bitDepth / 8))
    let at = 0
    for (const part of batch) {
      pcm.set(part, at)
      at += part.length
    }
    batch = []
    batched = 0
    chain = chain.then(async () => {
      if (failed) return
      try {
        await api['rec:chunk']({ session: await id(), pcm: pcm.buffer })
      } catch (error) {
        failed = error
        open = false
        onError(error)
      }
    })
  }

  const close = <T>(call: (sid: string) => Promise<T>): Promise<T> => {
    open = false
    send()
    return chain.then(async () => {
      if (failed) throw failed
      if (!session) throw new Error('Nothing was recorded')
      return call(await session)
    })
  }

  return {
    frames: () => frames,
    push: (samples) => {
      if (!open || samples.length === 0) return
      batch.push(encode(samples))
      batched += samples.length
      frames += samples.length
      if (batched >= batchFrames) send()
    },
    finish: (fragment) => close((sid) => api['rec:finish']({ session: sid, fragment })),
    finishPasses: (passes) => close((sid) => api['rec:finishPasses']({ session: sid, passes: [...passes] })),
    abort: () => {
      if (!open) return
      open = false
      batch = []
      batched = 0
      chain = chain
        .then(async () => {
          if (session) await api['rec:abort']({ session: await session })
        })
        .catch(() => undefined)
    },
  }
}
