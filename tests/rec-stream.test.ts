import { describe, expect, it, vi } from 'vitest'

const calls: { channel: string; req: Record<string, unknown> }[] = []
let failChunk = false
const fakeApi = {
  'rec:begin': vi.fn(async (req: Record<string, unknown>) => {
    calls.push({ channel: 'rec:begin', req })
    return 'session-1'
  }),
  'rec:chunk': vi.fn(async (req: Record<string, unknown>) => {
    calls.push({ channel: 'rec:chunk', req })
    if (failChunk) throw new Error('Project was closed during recording')
  }),
  'rec:finish': vi.fn(async (req: Record<string, unknown>) => {
    calls.push({ channel: 'rec:finish', req })
    return { id: 'take' }
  }),
  'rec:abort': vi.fn(async (req: Record<string, unknown>) => {
    calls.push({ channel: 'rec:abort', req })
  }),
}
vi.stubGlobal('window', { api: fakeApi })

const { openRecStream } = await import('../src/renderer/audio/rec-stream')

const reset = (): void => {
  calls.length = 0
  failChunk = false
}

describe('recording stream', () => {
  it('batches pcm16 chunks in order and finishes after the last one', async () => {
    reset()
    const s = openRecStream('c', 8000, vi.fn())
    s.push(new Float32Array(3000).fill(0.5))
    s.push(new Float32Array(3000).fill(-1))
    s.push(new Float32Array(10).fill(1))
    expect(s.frames()).toBe(6010)
    const take = await s.finish(true)
    expect(take).toEqual({ id: 'take' })
    expect(calls.map((c) => c.channel)).toEqual(['rec:begin', 'rec:chunk', 'rec:chunk', 'rec:finish'])
    expect(calls[0].req).toEqual({ cueId: 'c', sampleRate: 8000 })
    const first = new Int16Array(calls[1].req['pcm'] as ArrayBuffer)
    const last = new Int16Array(calls[2].req['pcm'] as ArrayBuffer)
    expect(first.length).toBe(6000)
    expect(first[0]).toBe(Math.round(0.5 * 0x7fff))
    expect(first[5999]).toBe(-0x8000)
    expect(Array.from(last)).toEqual(new Array(10).fill(0x7fff))
    expect(calls[3].req).toEqual({ session: 'session-1', fragment: true })
    s.abort()
    await Promise.resolve()
    expect(calls.some((c) => c.channel === 'rec:abort')).toBe(false)
  })

  it('abort deletes an opened session and ignores later samples', async () => {
    reset()
    const s = openRecStream('c', 8000, vi.fn())
    s.push(new Float32Array(4000))
    s.abort()
    s.push(new Float32Array(4000))
    await vi.waitFor(() => expect(calls.map((c) => c.channel)).toEqual(['rec:begin', 'rec:chunk', 'rec:abort']))
  })

  it('a refused chunk reports once and never aborts, so the partial survives', async () => {
    reset()
    failChunk = true
    const onError = vi.fn()
    const s = openRecStream('c', 8000, onError)
    s.push(new Float32Array(4000))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    s.push(new Float32Array(4000))
    s.abort()
    await expect(s.finish(false)).rejects.toThrow('closed')
    expect(calls.map((c) => c.channel)).toEqual(['rec:begin', 'rec:chunk'])
  })

  it('nothing captured means no session at all', async () => {
    reset()
    const s = openRecStream('c', 8000, vi.fn())
    s.abort()
    await expect(openRecStream('c', 8000, vi.fn()).finish(false)).rejects.toThrow('Nothing was recorded')
    expect(calls).toEqual([])
  })
})
