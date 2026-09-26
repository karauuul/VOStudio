import { promises as fs } from 'fs'
import path from 'path'
import {
  commitTable,
  parseTableFile,
  previewCell,
  previewTable,
  tableMapping,
  type TableFile,
  type TableOptions,
} from '@shared/import-table'
import type { Project } from '@shared/domain'
import type { TableImportResult, TablePreview, TableRequest } from '@shared/ipc'
import type { ChangeSet } from '@shared/project-commands'

const MAX_BYTES = 64 * 1024 * 1024
const PREVIEW_ROWS = 20

export interface ReadTable extends TableFile {
  path: string
}

export async function readTable(file: string): Promise<ReadTable> {
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
  if (stat.size > MAX_BYTES) throw new Error(`Table is larger than ${MAX_BYTES / 1024 / 1024} MB`)
  return { path: file, ...parseTableFile(file, await fs.readFile(file, 'utf-8')) }
}

const optionsFor = (project: Project, table: TableFile, req: TableRequest): TableOptions => ({
  mapping: tableMapping(table, project.cues, req.mapping),
  rule: req.rule,
  replaceTranslations: req.replaceTranslations === true,
  keepOriginal: req.keepOriginal === true,
})

export function previewTableFile(project: Project, table: ReadTable, req: TableRequest): TablePreview {
  const options = optionsFor(project, table, req)
  return {
    path: table.path,
    name: path.basename(table.path),
    script: table.script,
    headers: table.headers.map(previewCell),
    rows: table.rows.slice(0, PREVIEW_ROWS).map((cells) => cells.map(previewCell)),
    total: table.rows.length,
    mapping: options.mapping,
    summary: previewTable(project, table.rows, options),
  }
}

export function importTableFile(
  project: Project,
  table: ReadTable,
  req: TableRequest
): { result: TableImportResult; changes: ChangeSet | null } {
  const options = optionsFor(project, table, req)
  const committed = commitTable(project, table.rows, options)
  return {
    result: {
      path: table.path,
      name: path.basename(table.path),
      headers: table.headers,
      mapping: options.mapping,
      rows: table.rows.length,
      summary: committed.summary,
      undo: committed.undo,
    },
    changes: committed.changes,
  }
}
