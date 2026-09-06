import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { EventChannel, IpcApi, IpcChannel, IpcEvents } from '@shared/ipc'

const channelMap: Record<IpcChannel, true> = {
  'project:list': true,
  'project:open': true,
  'project:create': true,
  'project:delete': true,
  'project:close': true,
  'project:pickTemplate': true,
  'project:importTemplate': true,
  'import:pick': true,
  'import:audio': true,
  'import:table': true,
  'import:template': true,
  'source:detect': true,
  'project:command': true,
  'project:saveVersion': true,
  'ui:save': true,

  'suggestions:load': true,

  'rules:get': true,

  'audio:readRef': true,

  'shell:reveal': true,

  'take:saveRecording': true,
  'take:setDurations': true,

  'stems:isolate': true,
  'stems:save': true,

  'provider:tts': true,
  'provider:sts': true,
  'provider:transcribe': true,
  'provider:voices': true,
  'provider:testVoice': true,
  'provider:usage': true,
  'provider:setApiKey': true,
  'provider:hasApiKey': true,

  'migration:dryRun': true,
  'migration:apply': true,

  'csv:preview': true,
  'csv:sync': true,

  'export:planBatch': true,
  'export:info': true,
  'export:pickDir': true,
  'export:copy': true,
  'export:encode': true,
  'export:finish': true,
  'export:videoPlan': true,
  'export:videoChunk': true,
  'export:videoFinish': true,
  'export:videoAbort': true,

  'settings:get': true,
  'settings:set': true,
  'updater:getStatus': true,
  'updater:check': true,
  'updater:restart': true,
}

const channels = Object.keys(channelMap) as IpcChannel[]

const eventMap: Record<EventChannel, true> = {
  'usage:updated': true,
  'takes:durations': true,
  'project:changed': true,
  'updater:status': true,
}

const api = {} as Record<string, unknown>
for (const ch of channels) {
  api[ch] = (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)
}

function on<C extends EventChannel>(channel: C, cb: (payload: IpcEvents[C]) => void): () => void {
  if (!Object.prototype.hasOwnProperty.call(eventMap, channel)) {
    throw new Error(`Unknown event channel: ${String(channel)}`)
  }
  const listener = (_e: IpcRendererEvent, payload: IpcEvents[C]): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

api['on'] = on

function pathsFor(files: File[]): string[] {
  const out: string[] = []
  for (const file of files) {
    try {
      const p = webUtils.getPathForFile(file)
      if (p) out.push(p)
    } catch {
    }
  }
  return out
}

api['pathsFor'] = pathsFor

contextBridge.exposeInMainWorld('api', api)

export type WindowApi = { [C in IpcChannel]: IpcApi[C] } & {
  on<C extends EventChannel>(channel: C, cb: (payload: IpcEvents[C]) => void): () => void
  pathsFor(files: File[]): string[]
}
