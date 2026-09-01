import { useCallback, useEffect, useRef, useState } from 'react'
import { encodeWav, pcmDuration } from './wav'
import {
  createRingForRate,
  ringWrite,
  sliceTake,
  MAX_GAP_SECONDS,
  PREROLL_SECONDS,
  type Ring,
} from './ring'
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from '../worklets/capture.worklet'
import { clipId, transport } from './transport'

export type RecPhase =
  | 'idle'
  | 'arming'
  | 'countin'
  | 'recording'
  | 'preview'

export type MicState =
  | 'off'
  | 'warming'
  | 'ready'
  | 'error'

export interface RecordedClip {
  wav: ArrayBuffer
  url: string
  durationSec: number
  sampleRate: number
}

export interface StartOptions {
  deviceId?: string
  countIn: boolean
  autoReference: boolean
  referenceUrl?: string
  referenceClipId?: string
}

export interface RecorderApi {
  phase: RecPhase
  mic: MicState
  countIn: number
  elapsed: number
  level: number
  error: string | null
  clip: RecordedClip | null
  devices: MediaDeviceInfo[]
  start: (opts: StartOptions) => void
  stop: () => void
  cancel: () => void
  discardClip: () => void
  refreshDevices: () => void
  clearError: () => void
}

const BEEP_GAP = 0.55
const BEEPS = 3
const LEAD_IN = 0.12
const DONE_TIMEOUT_MS = 500
const LATE_MARGIN_MS = 300

let moduleUrlCache: string | null = null
function workletModuleUrl(): string {
  if (!moduleUrlCache) {
    moduleUrlCache = URL.createObjectURL(
      new Blob([CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' })
    )
  }
  return moduleUrlCache
}

function beep(ctx: AudioContext, out: AudioNode, at: number, accent: boolean): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = accent ? 1320 : 880
  const len = accent ? 0.18 : 0.09
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(0.22, at + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + len)
  osc.connect(gain)
  gain.connect(out)
  osc.start(at)
  osc.stop(at + len + 0.05)
}

interface CueOut {
  ctx: AudioContext
  gain: GainNode
}

interface Rig {
  stream: MediaStream
  ctx: AudioContext
  node: AudioWorkletNode
  source: MediaStreamAudioSourceNode
  sink: GainNode
  ring: Ring
  deviceId?: string
  disposed: boolean
}

interface RigHandlers {
  onRms: (v: number) => void
  onFlushed: (token: number, frame: number) => void
}

async function buildRig(deviceId: string | undefined, h: RigHandlers): Promise<Rig> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })
  try {
    const hint = stream.getAudioTracks()[0]?.getSettings().sampleRate
    const ctx =
      typeof hint === 'number' && Number.isFinite(hint) && hint > 0
        ? new AudioContext({ sampleRate: hint })
        : new AudioContext()
    try {
      await ctx.resume()
      await ctx.audioWorklet.addModule(workletModuleUrl())

      const source = ctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      })
      const sink = ctx.createGain()
      sink.gain.value = 0
      source.connect(node)
      node.connect(sink)
      sink.connect(ctx.destination)

      const rig: Rig = {
        stream,
        ctx,
        node,
        source,
        sink,
        ring: createRingForRate(ctx.sampleRate),
        deviceId,
        disposed: false,
      }

      const maxGap = Math.round(MAX_GAP_SECONDS * ctx.sampleRate)
      node.port.onmessage = (e: MessageEvent): void => {
        const m = e.data as {
          samples?: Float32Array
          at?: number
          rms?: number
          flushed?: boolean
          token?: number
          frame?: number
        }
        if (m.samples) ringWrite(rig.ring, m.samples, m.at ?? rig.ring.end, maxGap)
        if (typeof m.rms === 'number') h.onRms(m.rms)
        if (m.flushed) h.onFlushed(m.token ?? 0, m.frame ?? 0)
      }
      return rig
    } catch (err) {
      void ctx.close().catch(() => {})
      throw err
    }
  } catch (err) {
    for (const t of stream.getTracks()) t.stop()
    throw err
  }
}

function disposeRig(r: Rig | null): void {
  if (!r || r.disposed) return
  r.disposed = true
  r.node.port.onmessage = null
  for (const n of [r.node, r.source, r.sink] as AudioNode[]) {
    try {
      n.disconnect()
    } catch {
    }
  }
  for (const t of r.stream.getTracks()) t.stop()
  void r.ctx.close().catch(() => {})
}

interface Take {
  gen: number
  cancelled: boolean
  finalized: boolean
  awaitingFlush: boolean
  beeps: number
  startAtMs: number
  startFrame: number
  stopFrame: number
  refPlaying: boolean
}

function newTake(gen: number): Take {
  return {
    gen,
    cancelled: false,
    finalized: false,
    awaitingFlush: false,
    beeps: 0,
    startAtMs: 0,
    startFrame: 0,
    stopFrame: 0,
    refPlaying: false,
  }
}

function hushReference(t: Take): void {
  if (!t.refPlaying) return
  t.refPlaying = false
  transport.stop()
}

export function useRecorder(): RecorderApi {
  const [phase, setPhaseState] = useState<RecPhase>('idle')
  const [mic, setMicState] = useState<MicState>('off')
  const [countIn, setCountIn] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setErrorState] = useState<string | null>(null)
  const [clip, setClip] = useState<RecordedClip | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])

  const errorRef = useRef<string | null>(null)
  const setError = useCallback((e: string | null) => {
    errorRef.current = e
    setErrorState(e)
  }, [])

  const rigRef = useRef<Rig | null>(null)
  const cueRef = useRef<CueOut | null>(null)
  const warmPromise = useRef<Promise<Rig> | null>(null)
  const warmDevice = useRef<string | undefined>(undefined)
  const warmGen = useRef(0)
  const takeRef = useRef<Take | null>(null)
  const takeGen = useRef(0)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const phaseRef = useRef<RecPhase>('idle')
  const levelRef = useRef(0)
  const aliveRef = useRef(true)
  const clipRef = useRef<RecordedClip | null>(null)

  const setPhase = useCallback((p: RecPhase) => {
    phaseRef.current = p
    if (aliveRef.current) setPhaseState(p)
  }, [])
  const setMic = useCallback((m: MicState) => {
    if (aliveRef.current) setMicState(m)
  }, [])

  const refreshDevices = useCallback(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => {
        if (aliveRef.current) setDevices(list.filter((d) => d.kind === 'audioinput'))
      })
      .catch(() => {})
  }, [])

  useEffect(refreshDevices, [refreshDevices])

  const discardClip = useCallback(() => {
    const c = clipRef.current
    if (c) URL.revokeObjectURL(c.url)
    clipRef.current = null
    if (aliveRef.current) setClip(null)
  }, [])

  const ensureCue = useCallback((): CueOut | null => {
    let c = cueRef.current
    if (!c || c.ctx.state === 'closed') {
      try {
        const ctx = new AudioContext()
        const gain = ctx.createGain()
        gain.gain.value = 1
        gain.connect(ctx.destination)
        c = { ctx, gain }
        cueRef.current = c
      } catch {
        return null
      }
    }
    void c.ctx.resume().catch(() => {})
    return c
  }, [])

  const hushCue = useCallback(() => {
    const c = cueRef.current
    if (!c || c.ctx.state === 'closed') return
    const now = c.ctx.currentTime
    try {
      c.gain.gain.cancelScheduledValues(now)
      c.gain.gain.setValueAtTime(0, now)
    } catch {
    }
  }, [])

  const teardownRig = useCallback(() => {
    warmGen.current++
    warmPromise.current = null
    warmDevice.current = undefined
    disposeRig(rigRef.current)
    rigRef.current = null
    levelRef.current = 0
    if (aliveRef.current) {
      setLevel(0)
      setMicState('off')
    }
  }, [])

  const finalize = useCallback(
    (t: Take, r: Rig) => {
      if (t.finalized || t.cancelled) return
      t.finalized = true
      t.awaitingFlush = false
      if (doneTimer.current) {
        clearTimeout(doneTimer.current)
        doneTimer.current = null
      }
      const rate = r.ctx.sampleRate
      const pcm = sliceTake(
        r.ring,
        { start: t.startFrame, stop: t.stopFrame },
        Math.round(PREROLL_SECONDS * rate)
      )
      if (takeRef.current === t) takeRef.current = null

      teardownRig()

      if (pcm.length === 0) {
        if (aliveRef.current) setError('Nothing was recorded — the microphone returned no samples')
        setPhase('idle')
        return
      }
      const wav = encodeWav(pcm, rate)
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const next: RecordedClip = {
        wav,
        url,
        durationSec: pcmDuration(pcm.length, rate),
        sampleRate: rate,
      }
      clipRef.current = next
      if (aliveRef.current) {
        setClip(next)
        setElapsed(next.durationSec)
      }
      setPhase('preview')
    },
    [setError, setPhase, teardownRig]
  )

  const finalizeRef = useRef(finalize)
  finalizeRef.current = finalize

  const onFlushed = useCallback((token: number, _frame: number) => {
    const t = takeRef.current
    const r = rigRef.current
    if (!t || !r || t.gen !== token || !t.awaitingFlush) return
    finalizeRef.current(t, r)
  }, [])

  const warm = useCallback(
    (deviceId?: string): Promise<Rig> => {
      const cur = rigRef.current
      if (cur && !cur.disposed && cur.deviceId === deviceId) return Promise.resolve(cur)
      if (warmPromise.current && warmDevice.current === deviceId) return warmPromise.current
      if (!navigator.mediaDevices?.getUserMedia) {
        const msg = 'Microphone is not available in this environment'
        setError(msg)
        setMic('error')
        return Promise.reject(new Error(msg))
      }

      const gen = ++warmGen.current
      warmDevice.current = deviceId
      disposeRig(rigRef.current)
      rigRef.current = null
      setMic('warming')

      const p = buildRig(deviceId, {
        onRms: (v) => {
          levelRef.current = v
        },
        onFlushed,
      }).then(
        (built) => {
          if (gen !== warmGen.current || !aliveRef.current) {
            disposeRig(built)
            throw new Error('microphone start cancelled')
          }
          rigRef.current = built
          warmPromise.current = null
          setMic('ready')
          refreshDevices()
          return built
        },
        (err: unknown) => {
          if (gen === warmGen.current) {
            warmPromise.current = null
            if (aliveRef.current) setError(`Could not open the microphone: ${String(err)}`)
            setMic('error')
          }
          throw err
        }
      )
      warmPromise.current = p
      return p
    },
    [onFlushed, refreshDevices, setError, setMic]
  )

  const cancel = useCallback(() => {
    const t = takeRef.current
    if (t) {
      t.cancelled = true
      hushReference(t)
      takeRef.current = null
    }
    if (doneTimer.current) {
      clearTimeout(doneTimer.current)
      doneTimer.current = null
    }
    hushCue()
    discardClip()
    teardownRig()
    if (aliveRef.current) {
      setElapsed(0)
      setCountIn(0)
    }
    setPhase('idle')
  }, [discardClip, hushCue, setPhase, teardownRig])

  const stop = useCallback(() => {
    const t = takeRef.current
    const r = rigRef.current
    if (!t || !r || r.disposed || phaseRef.current !== 'recording') {
      cancel()
      return
    }
    t.stopFrame = Math.round(r.ctx.currentTime * r.ctx.sampleRate)
    t.awaitingFlush = true
    r.node.port.postMessage({ cmd: 'flush', token: t.gen })
    doneTimer.current = setTimeout(() => finalizeRef.current(t, r), DONE_TIMEOUT_MS)
  }, [cancel])

  const start = useCallback(
    (opts: StartOptions) => {
      if (phaseRef.current !== 'idle' && phaseRef.current !== 'preview') return
      discardClip()
      setError(null)
      setElapsed(0)
      setCountIn(0)
      setPhase('arming')

      const t = newTake(++takeGen.current)
      takeRef.current = t

      const rigPromise = warm(opts.deviceId)
      rigPromise.catch(() => {
      })

      void (async (): Promise<void> => {
        try {
          if (opts.autoReference && opts.referenceUrl) {
            t.refPlaying = true
            await transport.playClip({
              id: opts.referenceClipId ?? clipId.reference(opts.referenceUrl),
              url: opts.referenceUrl,
            })
            t.refPlaying = false
            if (t.cancelled || takeRef.current !== t) return
          }

          if (opts.countIn) {
            const c = ensureCue()
            if (c) {
              const now = c.ctx.currentTime
              try {
                c.gain.gain.cancelScheduledValues(now)
                c.gain.gain.setValueAtTime(1, now)
              } catch {
              }
              const t0 = now + LEAD_IN
              for (let i = 0; i < BEEPS; i++) {
                beep(c.ctx, c.gain, t0 + i * BEEP_GAP, i === BEEPS - 1)
              }
              t.beeps = BEEPS
              t.startAtMs =
                performance.now() + (t0 - now) * 1000 + (BEEPS - 1) * BEEP_GAP * 1000
              setPhase('countin')
            }
          }

          const r = await rigPromise
          if (t.cancelled || takeRef.current !== t || r.disposed) return

          const perfNow = performance.now()
          const ctxNow = r.ctx.currentTime
          const rate = r.ctx.sampleRate

          if (t.beeps === 0) {
            t.startAtMs = perfNow
            t.startFrame = Math.round(ctxNow * rate)
            setPhase('recording')
            return
          }

          if (perfNow > t.startAtMs - LATE_MARGIN_MS) {
            const atMs = Math.max(perfNow + LEAD_IN * 1000, t.startAtMs + BEEP_GAP * 1000)
            const c = ensureCue()
            if (c) beep(c.ctx, c.gain, c.ctx.currentTime + (atMs - performance.now()) / 1000, true)
            t.beeps++
            t.startAtMs = atMs
          }
          t.startFrame = Math.round((ctxNow + (t.startAtMs - perfNow) / 1000) * rate)
        } catch (err) {
          if (t.cancelled || takeRef.current !== t) return
          takeRef.current = null
          hushReference(t)
          hushCue()
          teardownRig()
          if (aliveRef.current && !errorRef.current) {
            setError(`Could not start recording: ${String(err)}`)
          }
          setPhase('idle')
        }
      })()
    },
    [discardClip, ensureCue, hushCue, setError, setPhase, teardownRig, warm]
  )

  useEffect(() => {
    if (phase !== 'arming' && phase !== 'countin' && phase !== 'recording') return
    const id = setInterval(() => {
      setLevel(levelRef.current)
      const t = takeRef.current
      if (!t) return
      const p = phaseRef.current
      if (p !== 'countin' && p !== 'recording') return
      const now = performance.now()
      const armed = t.startFrame > 0 && !!rigRef.current
      if (!armed || now < t.startAtMs) {
        setCountIn(Math.max(1, Math.round((t.startAtMs - now) / (BEEP_GAP * 1000)) + 1))
        setElapsed(0)
      } else {
        if (p === 'countin') setPhase('recording')
        setCountIn(0)
        setElapsed((now - t.startAtMs) / 1000)
      }
    }, 50)
    return () => clearInterval(id)
  }, [phase, setPhase])

  useEffect(() => {
    aliveRef.current = true
    const bye = (): void => {
      disposeRig(rigRef.current)
      rigRef.current = null
    }
    window.addEventListener('pagehide', bye)
    return () => {
      aliveRef.current = false
      window.removeEventListener('pagehide', bye)
      if (doneTimer.current) clearTimeout(doneTimer.current)
      const t = takeRef.current
      if (t) hushReference(t)
      takeRef.current = null
      warmGen.current++
      warmPromise.current = null
      bye()
      const c = cueRef.current
      cueRef.current = null
      if (c) void c.ctx.close().catch(() => {})
      if (clipRef.current) URL.revokeObjectURL(clipRef.current.url)
    }
  }, [])

  const clearError = useCallback(() => setError(null), [setError])

  return {
    phase,
    mic,
    countIn,
    elapsed,
    level,
    error,
    clip,
    devices,
    start,
    stop,
    cancel,
    discardClip,
    refreshDevices,
    clearError,
  }
}
