import { promises as fs } from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import type { MigrationEntry, MigrationReport } from '@shared/ipc'
import { emptyEdits, type Project } from '@shared/domain'
import * as store from './project-store'

export const GENERATED_DIR = process.env.VOSTUDIO_GENERATED_DIR ?? ''

async function sha256(file: string): Promise<string> {
  const buf = await fs.readFile(file)
  return createHash('sha256').update(buf).digest('hex')
}

interface Scan {
  normal: { file: string; eventName: string }[]
  manifests: { file: string; eventName: string }[]
  segments: { file: string; eventName: string; part: number }[]
}

async function scanGenerated(): Promise<Scan> {
  const scan: Scan = { normal: [], manifests: [], segments: [] }
  if (!GENERATED_DIR) return scan
  const files = await fs.readdir(GENERATED_DIR)
  for (const f of files) {
    const abs = path.join(GENERATED_DIR, f)
    if (f.endsWith('_segments.json')) {
      scan.manifests.push({ file: abs, eventName: f.slice(0, -'_segments.json'.length) })
    } else if (/_p\d+\.mp3$/.test(f)) {
      const m = /^(.*)_p(\d+)\.mp3$/.exec(f)!
      scan.segments.push({ file: abs, eventName: m[1], part: parseInt(m[2], 10) })
    } else if (f.endsWith('.mp3')) {
      scan.normal.push({ file: abs, eventName: f.slice(0, -4) })
    }
  }
  return scan
}

function cuesByEventName(project: Project): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const c of project.cues) {
    const ev = c.fields['EventName'] ?? ''
    if (!map.has(ev)) map.set(ev, [])
    map.get(ev)!.push(c.id)
  }
  return map
}

export interface PlanFile {
  file: string
  eventName: string
}
export interface PlanMatch extends PlanFile {
  cueId: string
}
export interface PlanNote extends PlanFile {
  note: string
}
export interface PlanComposite {
  eventName: string
  manifest: string
  cueId?: string
  coveredByNormal: boolean
  segments: PlanFile[]
}

export interface AdoptPlan {
  normal: PlanMatch[]
  ambiguous: PlanNote[]
  composite: PlanComposite[]
  orphans: PlanNote[]
  totalFiles: number
}

function buildPlan(project: Project, scan: Scan): AdoptPlan {
  const byEvent = cuesByEventName(project)
  const manifestEvents = new Set(scan.manifests.map((m) => m.eventName))
  const normalEvents = new Set(scan.normal.map((n) => n.eventName))

  const normal: PlanMatch[] = []
  const ambiguous: PlanNote[] = []
  for (const n of scan.normal) {
    const hits = byEvent.get(n.eventName) ?? []
    if (hits.length === 1) normal.push({ ...n, cueId: hits[0] })
    else if (hits.length > 1)
      ambiguous.push({ ...n, note: `Ambiguous EventName: ${hits.length} cues` })
    else ambiguous.push({ ...n, note: 'EventName not found in the CSV' })
  }

  const composite: PlanComposite[] = scan.manifests.map((m) => {
    const hits = byEvent.get(m.eventName) ?? []
    const entry: PlanComposite = {
      eventName: m.eventName,
      manifest: m.file,
      coveredByNormal: normalEvents.has(m.eventName),
      segments: scan.segments
        .filter((s) => s.eventName === m.eventName)
        .sort((a, b) => a.part - b.part)
        .map((s) => ({ file: s.file, eventName: s.eventName })),
    }
    if (hits.length === 1) entry.cueId = hits[0]
    return entry
  })

  const orphans: PlanNote[] = scan.segments
    .filter((s) => !manifestEvents.has(s.eventName))
    .map((s) => ({ file: s.file, eventName: s.eventName, note: 'segment without a manifest' }))

  return {
    normal,
    ambiguous,
    composite,
    orphans,
    totalFiles: scan.normal.length + scan.segments.length + scan.manifests.length,
  }
}

export async function plan(): Promise<AdoptPlan> {
  const project = store.getProject()
  if (!project) throw new Error('No project is open')
  return buildPlan(project, await scanGenerated())
}

export async function dryRun(): Promise<MigrationReport> {
  const p = await plan()
  const entry = async (
    f: PlanFile,
    kind: MigrationEntry['kind'],
    note?: string
  ): Promise<MigrationEntry> => {
    const e: MigrationEntry = {
      file: f.file,
      sha256: await sha256(f.file),
      kind,
      eventName: f.eventName,
    }
    if (note) e.note = note
    return e
  }

  return {
    normal: await Promise.all(p.normal.map((n) => entry(n, 'normal'))),
    composite: await Promise.all(
      p.composite.map(async (c) => ({
        eventName: c.eventName,
        manifest: c.manifest,
        segments: await Promise.all(c.segments.map((s) => entry(s, 'segment'))),
      }))
    ),
    orphans: await Promise.all(p.orphans.map((o) => entry(o, 'segment', o.note))),
    ambiguous: await Promise.all(p.ambiguous.map((a) => entry(a, 'normal', a.note))),
    totalFiles: p.totalFiles,
  }
}

export async function apply(): Promise<{ adoptedNormal: number; adoptedComposite: number }> {
  const project = store.getProject()
  if (!project) throw new Error('No project is open')
  const p = buildPlan(project, await scanGenerated())

  let adoptedNormal = 0
  let adoptedComposite = 0

  const adopt = (cueId: string, file: string, kind: 'imported' | 'composite'): boolean => {
    const cue = project.cues.find((c) => c.id === cueId)
    if (!cue) return false
    if (cue.takes.some((t) => t.file.relPath === file)) return false
    const take = {
      id: randomUUID(),
      kind,
      createdAt: new Date().toISOString(),
      file: { fileId: path.basename(file), relPath: file, format: 'mp3' as const },
      duration: 0,
      meta: { provider: 'legacy' },
      edits: emptyEdits(),
    }
    cue.takes.push(take)
    if (!cue.finalTakeId) cue.finalTakeId = take.id
    if (cue.status === 'translated') cue.status = 'generated'
    return true
  }

  for (const n of p.normal) {
    if (adopt(n.cueId, n.file, 'imported')) adoptedNormal++
  }

  for (const c of p.composite) {
    if (!c.cueId || c.coveredByNormal) continue
    let any = false
    for (const s of c.segments) if (adopt(c.cueId, s.file, 'composite')) any = true
    if (any) adoptedComposite++
  }

  if (adoptedNormal > 0 || adoptedComposite > 0) await store.saveProject(project)
  return { adoptedNormal, adoptedComposite }
}
