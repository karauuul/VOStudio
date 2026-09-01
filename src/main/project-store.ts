import { app } from 'electron'
import { promises as fs, type Dirent } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { sanitizeTerms, type Project, type UiSessionState } from '@shared/domain'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/ipc'
import { PROJECT_SUFFIX, summarizeProject, type ProjectStats, type ProjectSummary } from '@shared/project-summary'
import { projectFileSchema } from './schemas'

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
  return { ...DEFAULT_APP_SETTINGS, ...(s ?? {}) }
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

export async function saveUi(next: UiSessionState): Promise<void> {
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
  const { ui: _ui, ...persistedProject } = project
  await atomicWrite(path.join(dir, 'project.json'), JSON.stringify(persistedProject, null, 2))
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

export async function persistProjectSnapshot(project: Project): Promise<void> {
  if (!projectDir) return
  const file = path.join(projectDir, 'project.json')
  try {
    const prev = await fs.readFile(file)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await fs.writeFile(path.join(projectDir, 'autosave', `project-${stamp}.json`), prev)
    const saves = (await fs.readdir(path.join(projectDir, 'autosave'))).sort()
    for (const old of saves.slice(0, Math.max(0, saves.length - 10))) {
      await fs.unlink(path.join(projectDir, 'autosave', old))
    }
  } catch {
  }
  const { ui: _ui, ...rest } = project
  await atomicWrite(file, JSON.stringify(rest, null, 2))
}

async function persist(): Promise<void> {
  if (!current) return
  await persistProjectSnapshot(current)
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
          modifiedAt = (await fs.stat(file)).mtimeMs
          const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as { name?: unknown }
          stats = summarizeProject(parsed)
          if (typeof parsed.name === 'string' && parsed.name.trim()) name = parsed.name
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

export async function writeTakeFile(cueId: string, fileName: string, data: Buffer): Promise<string> {
  if (!projectDir) throw new Error('No project is open')
  const dir = path.join(projectDir, 'audio', 'takes', cueId)
  await fs.mkdir(dir, { recursive: true })
  const abs = path.join(dir, fileName)
  await fs.writeFile(abs, data)
  return abs
}
