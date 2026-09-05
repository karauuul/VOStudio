import { approvalState } from './approval'
import { serializeCell, serializeCsv } from './csv'
import type { Cue, Project } from './domain'

export interface DeliverExported {
  cueId: string
  exportName: string
  file: string
  bytes: number
  sha256: string
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
  scope: 'approved' | 'all-final'
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

export function buildReport(
  project: string,
  scope: DeliverReport['scope'],
  summary: DeliverSummary,
  createdAt: string = new Date().toISOString()
): DeliverReport {
  return { formatVersion: 1, project, createdAt, scope, ...summary }
}
