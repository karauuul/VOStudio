import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { parseCsv } from '@shared/csv'
import type { Cue, Project } from '@shared/domain'
import * as store from './project-store'
import {
  SATISFACTORY_CSV,
  REFERENCE_DIR,
  REFERENCE_PATTERN,
  RULES_PATH,
  MAPPING,
  CHARACTERS,
  characterForEvent,
} from './satisfactory-preset'

export async function buildReferenceIndex(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const files = await fs.readdir(REFERENCE_DIR)
    for (const f of files) {
      const m = /__(\d+)\.wav$/i.exec(f)
      if (m) map.set(m[1], path.join(REFERENCE_DIR, f))
    }
  } catch {
  }
  return map
}

type SatisfactoryProjectBase = Omit<Project, 'id' | 'schemaVersion' | 'createdAt'>

export async function stageSatisfactoryImport(): Promise<SatisfactoryProjectBase> {
  const raw = await fs.readFile(SATISFACTORY_CSV, 'utf-8')
  const csv = parseCsv(raw)
  const col = (name: string) => csv.headers.indexOf(name)
  const kI = col(MAPPING.key)
  if (kI < 0) throw new Error(`Column ${MAPPING.key} is missing from the CSV`)
  const refIndex = await buildReferenceIndex()

  const cues: Cue[] = csv.rows
    .filter((r) => r.length > 1)
    .map((row) => {
      const fields: Record<string, string> = {}
      csv.headers.forEach((h, i) => (fields[h] = row[i] ?? ''))
      const key = fields[MAPPING.key]
      const refAbs = refIndex.get(key)
      const statusRaw = fields[MAPPING.status?.column ?? ''] ?? ''
      const approved =
        MAPPING.approvedFlag && fields[MAPPING.approvedFlag.column] === MAPPING.approvedFlag.value
      const text = fields[MAPPING.text ?? ''] ?? ''
      let status: Cue['status'] = MAPPING.status?.map[statusRaw] ?? 'empty'
      if (status !== 'excluded') {
        if (approved) status = 'approved'
        else if (!text.trim()) status = 'empty'
      }
      return {
        id: randomUUID(),
        characterId: characterForEvent(fields['EventName'] ?? ''),
        key,
        fields,
        sourceText: fields[MAPPING.sourceText ?? ''] ?? '',
        text,
        status,
        notes: '',
        referenceAudio: refAbs ? { fileId: key, relPath: refAbs, format: 'wav' as const } : undefined,
        referenceDuration: parseFloat(fields[MAPPING.duration ?? ''] || '') || undefined,
        takes: [],
      }
    })

  let rules = ''
  try {
    rules = await fs.readFile(RULES_PATH, 'utf-8')
  } catch {
    rules = '# find → replace\n'
  }

  return {
    name: 'Satisfactory ADA',
    media: { referenceDir: REFERENCE_DIR, referencePattern: REFERENCE_PATTERN },
    characters: CHARACTERS,
    cues,
    sessions: [],
    pronunciationRules: rules,
    csvBinding: {
      csvPath: SATISFACTORY_CSV,
      encoding: 'utf-8-sig',
      columnOrder: csv.headers,
      mapping: MAPPING,
    },
    exportTemplate: '{EventName}__{WemId}.{ext}',
    ui: { filter: '', search: '' },
  }
}

export async function importSatisfactory(staged: SatisfactoryProjectBase): Promise<Project> {
  return store.createProject('satisfactory', staged)
}
