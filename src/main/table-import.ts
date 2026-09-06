import { promises as fs } from 'fs'
import path from 'path'
import { parseCsv } from '@shared/csv'
import {
  applyTable,
  detectMapping,
  tableDelimiter,
  type MatchRule,
  type TableMapping,
} from '@shared/import-table'
import type { Project } from '@shared/domain'
import type { TableImportResult } from '@shared/ipc'
import type { ChangeSet } from '@shared/project-commands'

const MAX_BYTES = 64 * 1024 * 1024

export async function importTable(
  project: Project,
  file: string,
  rule: MatchRule,
  mapping: TableMapping | undefined,
  replaceTranslations: boolean
): Promise<{ result: TableImportResult; changes: ChangeSet }> {
  const stat = await fs.stat(file)
  if (!stat.isFile()) throw new Error(`Not a file: ${file}`)
  if (stat.size > MAX_BYTES) throw new Error(`Table is larger than ${MAX_BYTES / 1024 / 1024} MB`)
  const raw = await fs.readFile(file, 'utf-8')
  const delimiter = tableDelimiter(file, raw.slice(0, raw.search(/\r?\n/) + 1 || undefined))
  const csv = parseCsv(raw, delimiter)
  if (csv.headers.length === 0) throw new Error('Table has no header row')

  const resolved = mapping ?? detectMapping(csv.headers)
  const applied = applyTable(project, csv.rows, resolved, rule, replaceTranslations)

  return {
    result: {
      path: file,
      name: path.basename(file),
      headers: csv.headers,
      mapping: resolved,
      rows: csv.rows.length,
      matched: applied.matched,
      unmatched: applied.unmatched.length,
    },
    changes: {
      cues: structuredClone(applied.changed),
      ...(applied.createdCharacters.length > 0
        ? { characters: structuredClone(project.characters), charactersReplace: true }
        : {}),
    },
  }
}
