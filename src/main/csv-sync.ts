import { promises as fs } from 'fs'
import { parseCsv, serializeCsv, setCell } from '@shared/csv'
import { approvalState } from '@shared/approval'
import type { CsvSyncResult } from '@shared/ipc'
import * as store from './project-store'

export async function syncCsv(): Promise<CsvSyncResult> {
  const project = store.getProject()
  if (!project?.csvBinding) throw new Error('Project has no CSV binding')
  const { csvPath, mapping } = project.csvBinding
  const raw = await fs.readFile(csvPath, 'utf-8')
  const csv = parseCsv(raw)
  const col = (name: string) => csv.headers.indexOf(name)
  const kI = col(mapping.key)
  const tI = mapping.text ? col(mapping.text) : -1
  const aI = mapping.approvedFlag ? col(mapping.approvedFlag.column) : -1

  const byKey = new Map(project.cues.map((c) => [c.key, c]))
  let changedCells = 0
  for (let r = 0; r < csv.rows.length; r++) {
    const cue = byKey.get(csv.rows[r][kI])
    if (!cue) continue
    if (tI >= 0 && setCell(csv, r, tI, cue.text)) changedCells++
    if (aI >= 0 && mapping.approvedFlag) {
      const want = approvalState(cue) === 'approved' ? mapping.approvedFlag.value : ''
      const cur = csv.rows[r][aI] ?? ''
      if ((cur === mapping.approvedFlag.value || cur === '') && setCell(csv, r, aI, want)) changedCells++
    }
  }

  if (changedCells > 0) {
    const tmp = csvPath + '.tmp'
    await fs.writeFile(tmp, serializeCsv(csv))
    await fs.rename(tmp, csvPath)
  }
  return { changedCells, path: csvPath }
}
