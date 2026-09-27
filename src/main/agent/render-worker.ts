import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { z } from 'zod'
import type { WordTiming } from '@shared/domain'
import type { BatchExportResult, ExportJob, ExportPlan, RenderImageRequest, RenderLineRequest, RenderPlanRequest, RenderProsodyRequest } from '@shared/ipc'
import type { Prosody, ProsodyFigure } from '@shared/prosody'
import { planTimeoutMs } from '@shared/agent-render'
import { errorText } from '@shared/mcp'
import type { renderReplySchema } from '../schemas'
import { hardenedWindow, loadRenderer, markWorker } from '../windows'
import { watchDiagnostics } from './diagnostics'

type RenderReply = z.infer<typeof renderReplySchema>

export const RENDER_IDLE_MS = 60_000
export const LINE_TIMEOUT_MS = 120_000
export const IMAGE_TIMEOUT_MS = 30_000
export const ANALYSIS_TIMEOUT_MS = 30_000

const CLOSED = 'The render window closed before it finished; retry.'
const CRASHED = 'The render window crashed; it restarts on the next call, retry.'

interface Worker {
  win: BrowserWindow
  ready: Promise<void>
}

let worker: Worker | null = null
let idle: NodeJS.Timeout | null = null
const pending = new Map<string, { resolve: (reply: RenderReply) => void; reject: (error: Error) => void }>()

function stopIdle(): void {
  if (idle) clearTimeout(idle)
  idle = null
}

export function closeRenderWorker(reason = CLOSED): void {
  const current = worker
  worker = null
  stopIdle()
  for (const request of pending.values()) request.reject(new Error(reason))
  pending.clear()
  if (current && !current.win.isDestroyed()) current.win.destroy()
}

function spawn(): Worker {
  const win = hardenedWindow({ show: false, width: 480, height: 320, title: 'VO Studio render', webPreferences: { backgroundThrottling: false } })
  markWorker(win)
  watchDiagnostics(win.webContents)
  win.webContents.on('render-process-gone', () => {
    if (worker?.win === win) closeRenderWorker(CRASHED)
  })
  win.on('closed', () => {
    if (worker?.win === win) closeRenderWorker()
  })
  const current = { win, ready: loadRenderer(win, 'render') }
  worker = current
  return current
}

export async function renderWorker(): Promise<number> {
  stopIdle()
  const current = worker ?? spawn()
  try {
    await current.ready
  } catch (error) {
    if (worker === current) closeRenderWorker()
    throw new Error(`The render window could not load (${errorText(error).replace(/\.$/, '')}); retry.`)
  }
  if (worker !== current || current.win.isDestroyed()) throw new Error(CLOSED)
  return current.win.webContents.id
}

function armIdle(): void {
  if (pending.size === 0 && worker && !idle) idle = setTimeout(() => closeRenderWorker(), RENDER_IDLE_MS)
}

async function request(send: (win: BrowserWindow, id: string) => void, timeoutMs: number): Promise<RenderReply> {
  await renderWorker()
  stopIdle()
  const current = worker
  if (!current) throw new Error(CLOSED)
  const id = randomUUID()
  try {
    return await new Promise<RenderReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Rendering did not finish within ${Math.round(timeoutMs / 1000)} s; the render window was restarted, retry with fewer lines.`))
        closeRenderWorker()
      }, timeoutMs)
      pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer)
          resolve(reply)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      send(current.win, id)
    })
  } finally {
    armIdle()
  }
}

export function settleRender(senderId: number, reply: RenderReply): void {
  if (!worker || worker.win.isDestroyed() || worker.win.webContents.id !== senderId) return
  const request = pending.get(reply.id)
  pending.delete(reply.id)
  request?.resolve(reply)
}

const failed = (what: string, reply: RenderReply, missing: string): Error =>
  new Error(`${what} failed: ${(reply.error ?? missing).replace(/\.$/, '')}.`)

export async function renderLineWav(job: ExportJob): Promise<ArrayBuffer | Uint8Array> {
  const reply = await request((win, id) => win.webContents.send('render:line', { id, job } satisfies RenderLineRequest), LINE_TIMEOUT_MS)
  if (!reply.ok || !reply.wav) throw failed('Rendering', reply, 'no audio came back')
  return reply.wav
}

export async function renderExportPlan(plan: ExportPlan): Promise<BatchExportResult> {
  const reply = await request((win, id) => win.webContents.send('render:plan', { id, plan } satisfies RenderPlanRequest), planTimeoutMs(plan.jobs.length))
  if (!reply.ok || !reply.result) throw failed('Export', reply, 'no result came back')
  return reply.result
}

export async function renderProsodyImage(figure: ProsodyFigure): Promise<Buffer> {
  const reply = await request((win, id) => win.webContents.send('render:image', { id, figure } satisfies RenderImageRequest), IMAGE_TIMEOUT_MS)
  if (!reply.ok || !reply.png) throw failed('Drawing', reply, 'no image came back')
  return Buffer.from(reply.png instanceof Uint8Array ? reply.png : new Uint8Array(reply.png))
}

export async function analyzeInWorker(pcm: Float32Array, rate: number, words: WordTiming[], duration: number): Promise<Prosody> {
  const reply = await request((win, id) => win.webContents.send('render:prosody', { id, pcm, rate, words, duration } satisfies RenderProsodyRequest), ANALYSIS_TIMEOUT_MS)
  if (!reply.ok || !reply.prosody) throw failed('Analysis', reply, 'no analysis came back')
  return reply.prosody
}
