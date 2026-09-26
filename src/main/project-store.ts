import { app } from 'electron'
import { promises as fs, type Dirent } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  sanitizeGenMode,
  sanitizeLanguages,
  sanitizeMatchRule,
  sanitizeProjectSources,
  sanitizeProviderSettings,
  sanitizeTargetTrack,
  sanitizeTimelineViews,
  sanitizeTerms,
  sanitizeVersions,
  type Project,
  type ProjectVersion,
  type Stem,
  type UiSessionState,
} from '@shared/domain'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import { isInsideDir, PROJECT_SUFFIX, summarizeProject, type ProjectStats, type ProjectSummary } from '@shared/project-summary'
import {
  autosaveName,
  expiredAutosaves,
  freshSummary,
  projectFile,
  summaryRecord,
  type FileStamp,
  type ProjectFile,
  type ProjectListing,
} from '@shared/project-file'
import { appSettingsSchema, projectFileSchema } from './schemas'

let current: Project | null = null
let rev = 0
let projectDir: string | null = null

const DEFAULT_UI: UiSessionState = { filter: '', search: '' }
let ui: UiSessionState = { ...DEFAULT_UI }

const appStatePath = () => path.join(app.getPath('userData'), 'app.json')

interface AppState {
  settings?: AppSettings
}

export async function readAppState(): Promise<AppState> {
  try {
    return JSON.parse(await fs.readFile(appStatePath(), 'utf-8')) as AppState
  } catch {
    return {}
  }
}

export async function writeAppState(patch: Partial<AppState>): Promise<void> {
  const next = { ...(await readAppState()), ...patch }
  await atomicWrite(appStatePath(), JSON.stringify(next, null, 2))
}

export async function getSettings(): Promise<AppSettings> {
  const s = (await readAppState()).settings
  const merged: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS, ...(s ?? {}) }
  const parsed = appSettingsSchema.safeParse(merged)
  if (parsed.success) return { ...merged, ...parsed.data }
  const defaults: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS }
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]
    if (typeof key !== 'string') continue
    if (key in defaults) merged[key] = defaults[key]
    else delete merged[key]
  }
  const repaired = appSettingsSchema.safeParse(merged)
  return repaired.success ? { ...merged, ...repaired.data } : { ...DEFAULT_APP_SETTINGS }
}

export async function setSettings(settings: AppSettings): Promise<void> {
  await writeAppState({ settings })
}

async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

export function getProject(): Project | null {
  return current
}

export function adoptProject(project: Project, dir?: string): void {
  current = project
  if (dir !== undefined) projectDir = dir
}

export function getProjectDir(): string | null {
  return projectDir
}

const uiPath = (dir: string): string => path.join(dir, 'ui.json')
const projectJsonPath = (dir: string): string => path.join(dir, 'project.json')

export async function saveUi(raw: UiSessionState): Promise<void> {
  const targetTrack = sanitizeTargetTrack(raw.targetTrack)
  const timeline = sanitizeTimelineViews(raw.timeline)
  const matchBy = sanitizeMatchRule(raw.matchBy)
  const genMode = sanitizeGenMode(raw.genMode)
  const {
    targetTrack: _drop,
    timeline: _dropTimeline,
    matchBy: _dropMatch,
    genMode: _dropMode,
    ...base
  } = raw
  const withMode = genMode ? { ...base, genMode } : base
  const withMatch = matchBy ? { ...withMode, matchBy } : withMode
  const rest = timeline ? { ...withMatch, timeline } : withMatch
  const next = targetTrack ? { ...rest, targetTrack } : rest
  ui = next
  if (current) current.ui = next
  if (!projectDir) return
  await atomicWrite(uiPath(projectDir), JSON.stringify(next, null, 2))
}

async function loadUi(dir: string, legacy: UiSessionState | undefined): Promise<UiSessionState> {
  try {
    const parsed = JSON.parse(await fs.readFile(uiPath(dir), 'utf-8')) as UiSessionState
    if (parsed && typeof parsed === 'object') return { ...DEFAULT_UI, ...parsed }
  } catch {
  }
  const migrated = { ...DEFAULT_UI, ...(legacy ?? {}) }
  try {
    await atomicWrite(uiPath(dir), JSON.stringify(migrated, null, 2))
  } catch {
  }
  return migrated
}

export function defaultProjectsRoot(): string {
  const root = process.env['VOSTUDIO_PROJECTS_ROOT']
  return root && path.isAbsolute(root) ? root : path.join(app.getPath('documents'), 'VOStudio')
}

export async function createProject(name: string, base: Omit<Project, 'id' | 'schemaVersion' | 'createdAt'>): Promise<Project> {
  const dir = path.join(defaultProjectsRoot(), `${name}.vostudio`)
  await fs.mkdir(path.join(dir, 'audio', 'takes'), { recursive: true })
  await fs.mkdir(path.join(dir, 'autosave'), { recursive: true })
  await fs.mkdir(path.join(dir, 'exports'), { recursive: true })
  const project: Project = {
    id: randomUUID(),
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...base,
  }
  const nextUi = { ...DEFAULT_UI, ...project.ui }
  project.ui = nextUi
  const file = projectFile(project)
  await atomicWrite(projectJsonPath(dir), file.json)
  await writeSummary(dir, file)
  await atomicWrite(uiPath(dir), JSON.stringify(nextUi, null, 2))
  current = project
  projectDir = dir
  ui = nextUi
  rev = 0
  return project
}

export async function saveProject(p: Project): Promise<{ rev: number }> {
  current = p
  current.ui = ui
  rev++
  await persistProjectSnapshot(current)
  return { rev }
}

export function persistProjectSnapshot(project: Project): Promise<void> {
  return persistProjectFile(projectFile(project))
}

export async function persistProjectFile(file: ProjectFile): Promise<void> {
  const dir = projectDir
  if (!dir) return
  const target = projectJsonPath(dir)
  const tmp = target + '.tmp'
  await fs.writeFile(tmp, file.json)
  await keepAutosave(dir)
  await fs.rename(tmp, target)
  await writeSummary(dir, file)
}

async function keepAutosave(dir: string): Promise<void> {
  const file = projectJsonPath(dir)
  const autosave = path.join(dir, 'autosave')
  const backup = path.join(autosave, autosaveName(new Date()))
  try {
    await fs.link(file, backup).catch(() => fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL))
    for (const old of expiredAutosaves(await fs.readdir(autosave))) {
      await fs.unlink(path.join(autosave, old))
    }
  } catch {
  }
}

const summaryPath = (dir: string): string => path.join(dir, 'summary.json')

async function writeSummary(dir: string, file: ProjectFile): Promise<void> {
  try {
    await atomicWrite(summaryPath(dir), summaryRecord(file, await fs.stat(projectJsonPath(dir))))
  } catch {
  }
}

async function readListing(dir: string, stamp: FileStamp): Promise<ProjectListing> {
  const cached = await fs
    .readFile(summaryPath(dir), 'utf-8')
    .then((raw) => freshSummary(JSON.parse(raw), stamp))
    .catch(() => null)
  if (cached) return cached
  const parsed = JSON.parse(await fs.readFile(projectJsonPath(dir), 'utf-8')) as { name?: unknown }
  return { name: typeof parsed.name === 'string' ? parsed.name : '', stats: summarizeProject(parsed) }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const root = defaultProjectsRoot()
  let entries: Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  const rows = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.toLowerCase().endsWith(PROJECT_SUFFIX) &&
          entry.name.length > PROJECT_SUFFIX.length
      )
      .map(async (entry): Promise<ProjectSummary> => {
        const dir = path.join(root, entry.name)
        const file = path.join(dir, 'project.json')
        let name = entry.name.slice(0, -PROJECT_SUFFIX.length)
        let modifiedAt = 0
        let stats: ProjectStats | null = null
        try {
          const stamp = await fs.stat(file)
          modifiedAt = stamp.mtimeMs
          const listing = await readListing(dir, stamp)
          stats = listing.stats
          if (listing.name.trim()) name = listing.name
        } catch {
        }
        return { dir, name, modifiedAt, stats }
      })
  )
  return rows.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function openProjectDir(dir: string): Promise<Project> {
  const raw = await fs.readFile(path.join(dir, 'project.json'), 'utf-8')
  const p = JSON.parse(raw) as Project
  projectFileSchema.parse(p)
  if (Array.isArray(p.terms)) {
    const terms = sanitizeTerms(p.terms)
    if (terms) p.terms = terms
    else delete p.terms
  }
  if (Array.isArray(p.sources)) {
    const sources = sanitizeProjectSources(p.sources)
    if (sources) p.sources = sources
    else delete p.sources
  }
  if (Array.isArray(p.versions)) {
    const versions = sanitizeVersions(p.versions)
    if (versions) p.versions = versions
    else delete p.versions
  }
  if (p.provider !== undefined) {
    const provider = sanitizeProviderSettings(p.provider)
    if (provider) p.provider = provider
    else delete p.provider
  }
  if (p.languages !== undefined) {
    const languages = sanitizeLanguages(p.languages)
    if (languages) p.languages = languages
    else delete p.languages
  }
  ui = await loadUi(dir, p.ui)
  p.ui = ui
  current = p
  projectDir = dir
  rev = 0
  return current
}

export function closeProject(): void {
  current = null
  projectDir = null
  ui = { ...DEFAULT_UI }
  rev = 0
}

export async function saveVersion(previous: ProjectVersion[], name?: string): Promise<ProjectVersion[]> {
  if (!projectDir) throw new Error('No project is open')
  const dir = path.join(projectDir, 'versions')
  await fs.mkdir(dir, { recursive: true })
  const n = (previous[previous.length - 1]?.n ?? 0) + 1
  await fs.copyFile(path.join(projectDir, 'project.json'), path.join(dir, `v${n}.json`))
  const trimmed = name?.trim()
  return [...previous, { n, ...(trimmed ? { name: trimmed } : {}), createdAt: new Date().toISOString() }]
}

function withoutVersions(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  delete parsed['versions']
  return JSON.stringify(parsed)
}

async function matchesVersionFile(n: number): Promise<boolean> {
  if (!projectDir) return false
  try {
    const [live, saved] = await Promise.all([
      fs.readFile(path.join(projectDir, 'project.json'), 'utf-8'),
      fs.readFile(path.join(projectDir, 'versions', `v${n}.json`), 'utf-8'),
    ])
    return withoutVersions(live) === withoutVersions(saved)
  } catch {
    return false
  }
}

export async function ensureVersion(previous: ProjectVersion[]): Promise<ProjectVersion[]> {
  if (!projectDir) throw new Error('No project is open')
  const last = previous[previous.length - 1]
  if (last && (await matchesVersionFile(last.n))) return previous
  return saveVersion(previous)
}

export function audioFilePath(root: string, kind: 'takes' | 'stems', cueId: string, fileName: string): string {
  const base = path.resolve(root, 'audio', kind)
  const dir = path.resolve(base, cueId)
  const abs = path.resolve(dir, fileName)
  if (path.dirname(dir) !== base || path.dirname(abs) !== dir || !isInsideDir(abs, base)) {
    throw new Error('Audio path is outside the project')
  }
  return abs
}

export type AudioWriter = Buffer | ((abs: string) => Promise<void>)

async function writeAudioFile(
  root: string | null,
  kind: 'takes' | 'stems',
  cueId: string,
  fileName: string,
  data: AudioWriter
): Promise<string> {
  if (!root) throw new Error('No project is open')
  const abs = audioFilePath(root, kind, cueId, fileName)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  if (typeof data !== 'function') {
    try {
      await fs.writeFile(abs, data, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await fs.rm(abs, { force: true }).catch(() => undefined)
      throw error
    }
    return abs
  }
  const part = path.join(path.dirname(abs), `.part-${randomUUID()}-${fileName}`)
  try {
    await data(part)
    await fs.link(part, abs)
  } finally {
    await fs.rm(part, { force: true }).catch(() => undefined)
  }
  return abs
}

export function writeTakeFile(root: string, cueId: string, fileName: string, data: AudioWriter): Promise<string> {
  return writeAudioFile(root, 'takes', cueId, fileName, data)
}

export function writeStemFile(cueId: string, fileName: string, data: Buffer): Promise<string> {
  return writeAudioFile(projectDir, 'stems', cueId, fileName, data)
}

export async function saveStems(cueId: string, voice: Buffer, rest: Buffer): Promise<Stem[]> {
  const suffix = randomUUID().slice(0, 8)
  const voiceName = `voice_${suffix}.wav`
  const restName = `rest_${suffix}.wav`
  const voicePath = await writeStemFile(cueId, voiceName, voice)
  const restPath = await writeStemFile(cueId, restName, rest)
  return [
    {
      id: `${cueId}-voice`,
      name: 'Voice',
      file: { fileId: `${cueId}/${voiceName}`, relPath: voicePath, format: 'wav' },
      exportMode: 'off',
    },
    {
      id: `${cueId}-rest`,
      name: 'Music & SFX',
      file: { fileId: `${cueId}/${restName}`, relPath: restPath, format: 'wav' },
      exportMode: 'on',
      duckDb: 0,
    },
  ]
}

export async function dropUnusedStems(): Promise<void> {
  if (!projectDir || !current) return
  const root = path.join(projectDir, 'audio', 'stems')
  const used = new Set(
    current.cues.flatMap((c) => (c.stems ?? []).map((stem) => path.resolve(stem.file.relPath).toLowerCase()))
  )
  const kept = new Set(current.cues.filter((c) => c.stems?.length).map((c) => c.id))
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    if (!kept.has(entry.name)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      continue
    }
    for (const file of await fs.readdir(dir).catch(() => [])) {
      const abs = path.join(dir, file)
      if (!used.has(path.resolve(abs).toLowerCase())) await fs.rm(abs, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
