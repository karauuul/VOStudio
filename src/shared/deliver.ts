import { approvalState } from './approval'
import { serializeCell, serializeCsv } from './csv'
import type { Cue, Project } from './domain'
import type { ExportedLines } from './readiness'

export interface DeliverExported {
  cueId: string
  exportName: string
  file: string
  bytes: number
  sha256: string
  revision?: number
  version?: number
  signature?: string
}

export interface DeliverFailed {
  cueId: string
  exportName: string
  file: string
  reason: string
}

export interface DeliverSkipped {
  cueId: string
  reason: string
}

export interface DeliverSummary {
  exported: DeliverExported[]
  failed: DeliverFailed[]
  skipped: DeliverSkipped[]
}

export interface DeliverReport extends DeliverSummary {
  formatVersion: 1
  project: string
  createdAt: string
  scope: string
  version?: number
}

function statusCell(cue: Cue): string {
  if (approvalState(cue) === 'approved') return 'approved'
  return cue.status === 'excluded' ? 'excluded' : ''
}

function cell(cue: Cue, header: string): string {
  if (header === 'translation') return cue.text
  if (header === 'status') return statusCell(cue)
  return cue.fields[header] ?? ''
}

export function indexBound(project: Project): boolean {
  const first = project.cues[0]
  return !!first && Object.keys(first.fields).includes('cueId')
}

export function buildUpdatedIndex(project: Project): string | null {
  const first = project.cues[0]
  if (!first || !indexBound(project)) return null
  const headers = Object.keys(first.fields)
  for (const required of ['translation', 'status']) {
    if (!headers.includes(required)) headers.push(required)
  }
  const rows = project.cues.map((cue) => headers.map((header) => cell(cue, header)))
  return serializeCsv({
    hadBom: false,
    newline: '\n',
    trailingNewline: true,
    headers,
    rawHeader: headers.map(serializeCell),
    rows,
    rawRows: rows.map((row) => row.map(serializeCell)),
  })
}

export const EXPORT_SCOPE = 'selected'

export function buildReport(
  project: string,
  summary: DeliverSummary,
  version?: number,
  createdAt: string = new Date().toISOString()
): DeliverReport {
  return {
    formatVersion: 1,
    project,
    createdAt,
    scope: EXPORT_SCOPE,
    ...(version === undefined ? {} : { version }),
    ...summary,
  }
}

const replacedBy = (current: DeliverExported[]): ((e: DeliverExported) => boolean) => {
  const fresh = new Set(current.map((e) => e.file.toLowerCase()))
  const cues = new Set(current.map((e) => e.cueId))
  return (e) => fresh.has(e.file.toLowerCase()) || cues.has(e.cueId)
}

export function mergeExported(
  previous: DeliverExported[],
  current: DeliverExported[]
): DeliverExported[] {
  const replaced = replacedBy(current)
  return [...previous.filter((e) => !replaced(e)), ...current]
}

function isDeliveredAudio(file: string): boolean {
  const parts = file.split('/')
  return parts.length >= 2 && parts[0] === 'audio' && parts.slice(1).every((part) => part !== '' && part !== '.' && part !== '..' && !/[\\:]/.test(part))
}

export function supersededFiles(previous: DeliverExported[], current: DeliverExported[]): string[] {
  const fresh = new Set(current.map((e) => e.file.toLowerCase()))
  const replaced = replacedBy(current)
  return previous
    .filter((e) => replaced(e) && !fresh.has(e.file.toLowerCase()))
    .map((e) => e.file)
    .filter(isDeliveredAudio)
}

export function exportedLines(report: Pick<DeliverReport, 'exported'>): ExportedLines {
  const out: ExportedLines = {}
  for (const e of report.exported ?? []) {
    if (typeof e.cueId !== 'string' || !e.cueId) continue
    out[e.cueId] = {
      revision: typeof e.revision === 'number' ? e.revision : 0,
      ...(typeof e.version === 'number' ? { version: e.version } : {}),
      ...(typeof e.signature === 'string' ? { signature: e.signature } : {}),
    }
  }
  return out
}
