import type { Take } from '@shared/domain'
import { api } from '../api'
import { pcm16 } from './wav'

const CHUNK_SECONDS = 0.5

export interface RecStream {
  frames: () => number
  push: (samples: Float32Array) => void
  finish: (fragment: boolean) => Promise<Take>
  abort: () => void
}

export function openRecStream(cueId: string, sampleRate: number, onError: (error: unknown) => void): RecStream {
  const batchFrames = Math.round(sampleRate * CHUNK_SECONDS)
  let session: Promise<string> | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let batch: Int16Array[] = []
  let batched = 0
  let frames = 0
  let open = true
  let failed: unknown = null

  const id = (): Promise<string> => (session ??= api['rec:begin']({ cueId, sampleRate }))

  const send = (): void => {
    if (batched === 0) return
    const pcm = new Int16Array(batched)
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

  return {
    frames: () => frames,
    push: (samples) => {
      if (!open || samples.length === 0) return
      batch.push(pcm16(samples))
      batched += samples.length
      frames += samples.length
      if (batched >= batchFrames) send()
    },
    finish: (fragment) => {
      open = false
      send()
      return chain.then(async () => {
        if (failed) throw failed
        if (!session) throw new Error('Nothing was recorded')
        return api['rec:finish']({ session: await session, fragment })
      })
    },
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
