import { afterEach, describe, expect, it, vi } from 'vitest'

const destroyed = vi.fn()

vi.mock('../src/main/windows', () => ({
  hardenedWindow: () => {
    let gone = false
    return {
      on: () => undefined,
      isDestroyed: () => gone,
      destroy: () => {
        gone = true
        destroyed()
      },
      webContents: { id: 7, on: () => undefined, send: () => undefined },
    }
  },
  markWorker: () => undefined,
  loadRenderer: () => Promise.resolve(),
}))
vi.mock('../src/main/agent/diagnostics', () => ({ watchDiagnostics: () => undefined }))

const { RENDER_IDLE_MS, closeRenderWorker, withRenderWorker } = await import('../src/main/agent/render-worker')

describe('render worker idle lifecycle', () => {
  afterEach(() => {
    closeRenderWorker()
    destroyed.mockClear()
    vi.useRealTimers()
  })

  it('closes an idle worker after a caller failed before its first render request', async () => {
    vi.useFakeTimers()
    await expect(
      withRenderWorker(async (owner) => {
        expect(owner).toBe(7)
        throw new Error('Name collision: a.wav')
      })
    ).rejects.toThrow('Name collision')
    vi.advanceTimersByTime(RENDER_IDLE_MS)
    expect(destroyed).toHaveBeenCalledTimes(1)
  })

  it('keeps the worker while a caller holds it and arms the idle timer once it is done', async () => {
    vi.useFakeTimers()
    let release = (): void => undefined
    const held = withRenderWorker(() => new Promise<void>((resolve) => (release = resolve)))
    await vi.advanceTimersByTimeAsync(RENDER_IDLE_MS * 2)
    expect(destroyed).not.toHaveBeenCalled()
    release()
    await held
    vi.advanceTimersByTime(RENDER_IDLE_MS - 1)
    expect(destroyed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(destroyed).toHaveBeenCalledTimes(1)
  })
})
