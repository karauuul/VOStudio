import { describe, expect, it, vi } from 'vitest'

interface FakeWindow {
  isDestroyed: () => boolean
  once: (event: string, cb: () => void) => void
  webContents: { id: number; send: ReturnType<typeof vi.fn> }
}

const windows: FakeWindow[] = []
const fake = (id: number): FakeWindow => ({ isDestroyed: () => false, once: () => undefined, webContents: { id, send: vi.fn() } })

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => windows } }))

const { markWorker, uiWindows } = await import('../src/main/windows')
const { requestUi, settleUi, uiWindow } = await import('../src/main/agent/ui-bridge')
const { emit } = await import('../src/main/emit')

describe('the render worker is invisible to UI targeting', () => {
  const worker = fake(2)
  const ui = fake(1)
  windows.push(worker, ui)
  markWorker(worker as never)

  it('uiWindow, screenshots and bridge requests skip the worker', async () => {
    expect(uiWindows()).toEqual([ui])
    expect(uiWindow()).toBe(ui)
    ui.webContents.send.mockImplementation((channel: string, request: { id: string }) => {
      if (channel === 'bridge:request') settleUi({ id: request.id, ok: true })
    })
    await requestUi({ kind: 'flush' })
    expect(ui.webContents.send).toHaveBeenCalledWith('bridge:request', expect.objectContaining({ kind: 'flush' }))
    expect(worker.webContents.send).not.toHaveBeenCalled()
  })

  it('lifecycle events never reach the worker', () => {
    emit('project:closed', null)
    expect(ui.webContents.send).toHaveBeenCalledWith('project:closed', null)
    expect(worker.webContents.send).not.toHaveBeenCalled()
  })
})
