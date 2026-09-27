import type { WebContents } from 'electron'
import { errorText } from '@shared/mcp'

export interface DiagnosticEntry {
  at: string
  source: 'renderer' | 'crash' | 'main'
  message: string
}

const LIMIT = 200
const CONSOLE_ERROR = 3
const entries: DiagnosticEntry[] = []

function record(source: DiagnosticEntry['source'], message: string): void {
  entries.push({ at: new Date().toISOString(), source, message })
  if (entries.length > LIMIT) entries.shift()
}

export const diagnostics = (): DiagnosticEntry[] => [...entries]

export function watchDiagnostics(contents: WebContents): void {
  contents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level === CONSOLE_ERROR) record('renderer', sourceId ? `${message} (${sourceId}:${line})` : message)
  })
  contents.on('render-process-gone', (_event, details) =>
    record('crash', `Renderer process gone: ${details.reason} (exit code ${details.exitCode})`)
  )
}

process.on('uncaughtExceptionMonitor', (error) => record('main', errorText(error)))
