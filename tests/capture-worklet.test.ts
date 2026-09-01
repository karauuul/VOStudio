import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPTURE_FLUSH_SAMPLES,
  CAPTURE_PROCESSOR,
  CAPTURE_WORKLET_SOURCE,
} from '../src/renderer/worklets/capture.worklet'
import { createRing, ringSlice, ringWrite } from '../src/renderer/audio/ring'

describe('capture.worklet', () => {
  it('source is syntactically valid JS', () => {
    expect(() => new Function(CAPTURE_WORKLET_SOURCE)).not.toThrow()
  })

  it('registers the processor under the expected name', () => {
    expect(CAPTURE_WORKLET_SOURCE).toContain(`registerProcessor('${CAPTURE_PROCESSOR}'`)
    expect(CAPTURE_PROCESSOR).toBe('vo-capture')
  })

  it('interpolations were substituted, not left as placeholders', () => {
    expect(CAPTURE_WORKLET_SOURCE).toContain(`const FLUSH = ${CAPTURE_FLUSH_SAMPLES}`)
    expect(CAPTURE_WORKLET_SOURCE).not.toContain('${')
  })

  it('protocol with the main thread is in place: flush / ack / chunk with a frame mark', () => {
    for (const token of ["'flush'", 'flushed: true', 'samples: out', 'at: at']) {
      expect(CAPTURE_WORKLET_SOURCE).toContain(token)
    }
  })

  it('has no recording state of its own — capture is continuous', () => {
    expect(CAPTURE_WORKLET_SOURCE).not.toContain('this.rec')
    expect(CAPTURE_WORKLET_SOURCE).not.toContain('startAt')
  })
})

interface Msg {
  samples?: Float32Array
  at?: number
  rms?: number
  flushed?: boolean
  token?: number
  frame?: number
}

interface Proc {
  process: (inputs: Float32Array[][]) => boolean
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void }
}

const QUANTUM = 128
let frameNow = 0

function instantiate(): { proc: Proc; out: Msg[] } {
  const out: Msg[] = []
  let ctor: (new () => Proc) | null = null

  class FakeProcessor {
    port = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage: (m: unknown) => out.push(m as Msg),
    }
  }

  const register = (_name: string, c: new () => Proc): void => {
    ctor = c
  }

  Object.defineProperty(globalThis, 'currentFrame', {
    configurable: true,
    get: () => frameNow,
  })

  new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    CAPTURE_WORKLET_SOURCE
  )(FakeProcessor, register)

  if (!ctor) throw new Error('registerProcessor was not called')
  return { proc: new (ctor as new () => Proc)(), out }
}

function run(proc: Proc, quanta: number): void {
  for (let q = 0; q < quanta; q++) {
    const ch = new Float32Array(QUANTUM)
    for (let i = 0; i < QUANTUM; i++) ch[i] = frameNow + i
    proc.process([[ch]])
    frameNow += QUANTUM
  }
}

describe('capture.worklet: processor behavior', () => {
  afterEach(() => {
    frameNow = 0
    Reflect.deleteProperty(globalThis, 'currentFrame')
  })

  it('emits chunks with the correct first-frame mark', () => {
    frameNow = 5_000
    const { proc, out } = instantiate()
    run(proc, CAPTURE_FLUSH_SAMPLES / QUANTUM)
    const chunks = out.filter((m) => m.samples)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].at).toBe(5_000)
    expect(chunks[0].samples?.length).toBe(CAPTURE_FLUSH_SAMPLES)
    expect(chunks[0].samples?.[0]).toBe(5_000)
  })

  it('chunks assemble into the ring seamlessly — the signal does not break', () => {
    frameNow = 1_234
    const { proc, out } = instantiate()
    run(proc, (CAPTURE_FLUSH_SAMPLES / QUANTUM) * 3)
    const r = createRing(CAPTURE_FLUSH_SAMPLES * 4)
    for (const m of out) if (m.samples) ringWrite(r, m.samples, m.at ?? 0)
    expect(r.end).toBe(1_234 + CAPTURE_FLUSH_SAMPLES * 3)
    const pcm = ringSlice(r, 1_234, 1_234 + CAPTURE_FLUSH_SAMPLES * 3)
    for (let i = 0; i < pcm.length; i += 997) expect(pcm[i]).toBe(1_234 + i)
  })

  it('flush returns the tail and always acknowledges — even when the tail is empty', () => {
    const { proc, out } = instantiate()
    run(proc, 3)
    expect(out.filter((m) => m.samples)).toHaveLength(0)

    proc.port.onmessage?.({ data: { cmd: 'flush', token: 7 } })
    const tail = out.filter((m) => m.samples)
    expect(tail).toHaveLength(1)
    expect(tail[0].samples?.length).toBe(3 * QUANTUM)
    expect(tail[0].at).toBe(0)

    const ack = out.filter((m) => m.flushed)
    expect(ack).toHaveLength(1)
    expect(ack[0].token).toBe(7)
    expect(ack[0].frame).toBe(3 * QUANTUM)

    proc.port.onmessage?.({ data: { cmd: 'flush', token: 8 } })
    expect(out.filter((m) => m.flushed)).toHaveLength(2)
    expect(out.filter((m) => m.samples)).toHaveLength(1)
  })

  it('frame numbering does not drift after a flush', () => {
    const { proc, out } = instantiate()
    run(proc, 2)
    proc.port.onmessage?.({ data: { cmd: 'flush', token: 1 } })
    run(proc, 2)
    proc.port.onmessage?.({ data: { cmd: 'flush', token: 2 } })
    const chunks = out.filter((m) => m.samples)
    expect(chunks.map((c) => c.at)).toEqual([0, 2 * QUANTUM])
    expect(chunks[1].samples?.[0]).toBe(2 * QUANTUM)
  })

  it('the meter stays alive independently of recording', () => {
    const { proc, out } = instantiate()
    run(proc, 16)
    expect(out.some((m) => typeof m.rms === 'number')).toBe(true)
  })

  it('a silent input (no channel) does not crash the processor', () => {
    const { proc } = instantiate()
    expect(() => proc.process([[]])).not.toThrow()
    expect(proc.process([[]])).toBe(true)
  })
})
