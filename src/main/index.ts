import { app, BrowserWindow, dialog, Menu, protocol, session, shell, type WebContents } from 'electron'
import path from 'path'
import { createReadStream, promises as fs } from 'fs'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { typedHandle, typedHandleFrom } from './typed-ipc'
import {
  autoSelectsOutput,
  exportSummarySchema,
  filePath,
  matchRuleSchema,
  projectCommandSchema,
  tableImportSchema,
  projectDirSchema,
  projectNameSchema,
  batchExportSchema,
  appSettingsSchema,
  detectSchema,
  saveVersionSchema,
  restoreVersionSchema,
  stemsSchema,
  templateDirSchema,
  genRunSchema,
  jobIdsSchema,
  recAbortSchema,
  recBeginSchema,
  recChunkSchema,
  recFinishSchema,
  recFinishPassesSchema,
  bridgeReplySchema,
  renderReplySchema,
} from './schemas'
import { emit } from './emit'
import * as store from './project-store'
import { voiceProvider } from './providers/voice-provider'
import { setApiKey } from './secrets'
import { decodedDuration, ffmpegPcm, runFfmpeg } from './ffmpeg'
import { parseCsv } from '@shared/csv'
import { DEFAULT_EXPORT_TEMPLATE } from '@shared/export-plan'
import { ASSET_EXTENSIONS, inPlaceKind } from '@shared/asset-readers'
import {
  ASSET_ROW_MAX,
  singleFlight,
  serialQueue,
  type Cue,
  type ProjectVersion,
  type Stem,
  type Take,
  type UiSessionState,
} from '@shared/domain'
import type { Project } from '@shared/domain'
import type {
  AppSettings,
  AudioImportResult,
  GenJob,
  ReimportResult,
  TableImportResult,
  AssetAddResult,
  AssetPage,
  TablePreview,
  TableRequest,
} from '@shared/ipc'
import type { MatchRule } from '@shared/domain'
import {
  createProjectFromTemplate,
  reimportTemplate,
  toPreview,
  validateTemplate,
} from './template-import'
import * as migration from './migration'
import { GENERATED_DIR } from './migration'
import { syncCsv } from './csv-sync'
import { importAudio, probeTakeDurations } from './audio-import'
import { applyTakeDurations, pendingTakeDurations, type TakeDurationEntry } from '@shared/library'
import { importTableFile, previewTableFile, readTable } from './table-import'
import {
  abortBatchExport,
  abortVideoExport,
  appendVideoChunk,
  copyJob,
  encodeJob,
  cancelExports,
  finishExport,
  finishVideoExport,
  planBatchExport,
  planVideoExport,
  exportDir,
  exportInfo,
  exportBusy,
  agentRenderDir,
  encodeAnalysis,
  lineJob,
  measureAudio,
  releaseExports,
  type ExportStamp,
} from './export'
import { detectLines, importSources, splitMediaPaths } from './sources'
import { addAssets, assetAudioLines, assetPage, clearAssetCache, readAssetCached, type AudioLinesResult } from './assets'
import { applyAlienMigration } from './satisfactory-preset'
import { checkForUpdates, getUpdateStatus, initializeUpdater, restartToUpdate } from './updater'
import { SerialProjectRepository } from './project-repository'
import { transcribeCues } from './transcribe'
import { importTakeFile, takeBase, type TakeSession } from './take-append'
import {
  abortRecording,
  appendRecording,
  beginRecording,
  closeRecordings,
  finishPasses,
  finishRecording,
  recordingActive,
  recoverRecordings,
} from './recording-session'
import { audioWithinRoots, type ChangeSet, type CommandResult } from '@shared/project-commands'
import { setupImportedProject, setupOpenedProject } from './project-import'
import { isInsideDir, normalizePath, PROJECT_SUFFIX, uniqueProjectName } from '@shared/project-summary'
import { TAKE_FILE_EXTENSIONS } from '@shared/take-import'
import { AGENT_FLAG } from '@shared/agent-endpoint'
import { sanitizeAgentAccess } from '@shared/ipc'
import type { McpServer, McpSession } from '@shared/mcp'
import { needsGuardVersion } from '@shared/versions'
import { sha256Hex, startAgentServer, type AgentServerHandle } from './agent/server'
import { AGENT_INSTRUCTIONS, agentTools, ASSET_READ_MAX } from './agent/tools'
import { diagnostics, watchDiagnostics } from './agent/diagnostics'
import { requestUi, settleUi, uiWindow } from './agent/ui-bridge'
import { analyzeInWorker, closeRenderWorker, renderExportPlan, renderLineWav, renderProsodyImage, renderWorker, settleRender } from './agent/render-worker'
import { hardenedWindow, loadRenderer, uiWindows } from './windows'
import { renderFileName, requireRevision } from '@shared/agent-render'
import { ANALYSIS_MAX_SECONDS, ANALYSIS_RATE } from '@shared/prosody'
import type { BatchExportResult } from '@shared/ipc'
import { createGenerationQueue, type QueuedGeneration } from './gen-queue'
import { createStsTake, createTtsTake } from './generate'
import { exportRefusal, recordingRefusal, type JobOrigin } from '@shared/jobs'
import { jobChars } from '@shared/provider-models'

const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()

protocol.registerSchemesAsPrivileged([
  { scheme: 'vostudio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
])

const REFERENCE_DIR_ENV = process.env['VOSTUDIO_REFERENCE_DIR']
const RANGE_RE = /^bytes=(\d*)-(\d*)$/

function fileStream(abs: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const options = start === undefined ? {} : { start, ...(end === undefined ? {} : { end }) }
  return Readable.toWeb(createReadStream(abs, options)) as ReadableStream<Uint8Array>
}

function trustedAudioRoots(): string[] {
  return [store.getProjectDir(), REFERENCE_DIR_ENV, GENERATED_DIR].filter(Boolean) as string[]
}

function isAllowedPath(abs: string): boolean {
  const roots = trustedAudioRoots()
  const norm = path.resolve(abs).toLowerCase()
  if (roots.some((r) => norm.startsWith(path.resolve(r).toLowerCase() + path.sep))) return true
  const project = store.getProject()
  if (!project) return false
  if (project.sources?.some((s) => s.media !== undefined && path.resolve(s.media).toLowerCase() === norm)) {
    return true
  }
  if (project.assets?.some((a) => inPlaceKind(a.kind) && path.resolve(a.file.relPath).toLowerCase() === norm)) {
    return true
  }
  return project.cues.some(
    (cue) =>
      (cue.referenceAudio !== undefined &&
        path.resolve(cue.referenceAudio.relPath).toLowerCase() === norm) ||
      cue.takes.some((take) => path.resolve(take.file.relPath).toLowerCase() === norm)
  )
}

function isInsideExportDir(abs: string): boolean {
  const project = store.getProject()
  const dir = store.getProjectDir()
  return !!project && !!dir && isInsideDir(path.resolve(abs), exportDir(project, dir))
}

function createWindow(): void {
  const win = hardenedWindow({
    width: 1400,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'VO Studio',
    backgroundColor: '#191b1e',
  })

  watchDiagnostics(win.webContents)
  win.on('closed', () => closeRenderWorker())

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.code === 'F12') win.webContents.toggleDevTools()
    })
  }

  void loadRenderer(win)
}

const TEST_VOICE_TEXT = 'Voice test, one two three.'
const testVoiceInFlight = new Set<string>()

const MAX_RECORDING_BYTES = 100 * 1024 * 1024

function wavBytes(wav: unknown): Buffer {
  const bytes =
    wav instanceof ArrayBuffer
      ? Buffer.from(wav)
      : ArrayBuffer.isView(wav)
        ? Buffer.from((wav as ArrayBufferView).buffer as ArrayBuffer)
        : null
  if (!bytes || bytes.length === 0) throw new Error('Expected an ArrayBuffer with WAV data')
  if (bytes.length > MAX_RECORDING_BYTES) {
    throw new Error(`Audio is too large: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`)
  }
  return bytes
}

const durationsSchema = z
  .array(
    z.object({
      cueId: z.string().min(1),
      takeId: z.string().min(1),
      duration: z.number().min(0).max(3600),
    })
  )
  .max(500)

function flushPersist(): Promise<void> {
  return projectRepository?.flush() ?? Promise.resolve()
}

async function recordVersions(
  save: (previous: ProjectVersion[]) => Promise<ProjectVersion[]>
): Promise<ProjectVersion[]> {
  const repository = requireRepository()
  await repository.flush()
  const previous = repository.projectForMain().versions ?? []
  const versions = await save(previous)
  if (versions === previous) return versions
  await publish(repository, (project) => {
    project.versions = versions
    return { versions }
  })
  await repository.flush()
  return versions
}

async function stampVersion(): Promise<ExportStamp> {
  let previous: ProjectVersion[] = []
  const versions = await recordVersions((current) => {
    previous = current
    return store.ensureVersion(current)
  })
  return { version: versions[versions.length - 1].n, changes: versions === previous ? 0 : 1 }
}

const audioImportSchema = z.object({
  paths: z.array(filePath).min(1).max(200),
  rule: matchRuleSchema,
})

const assetAddSchema = z.object({ paths: z.array(filePath).min(1).max(200), skipMedia: z.literal(true).optional() })

const assetReadSchema = z.object({
  id: z.string().min(1).max(200),
  from: z.number().int().min(0).max(ASSET_ROW_MAX).optional(),
  count: z.number().int().min(1).max(ASSET_READ_MAX).optional(),
})

const takeImportSchema = z.object({
  cueId: z.string().min(1).max(200),
  paths: z.array(filePath).min(1).max(200),
})

const transcribeSchema = z.object({
  cueIds: z.array(z.string().min(1).max(200)).min(1).max(500),
  overwrite: z.boolean().optional(),
})

let projectRepository: SerialProjectRepository | null = null
let restoringVersion = false

const generations = createGenerationQueue({
  guard: (cueId) => ({ exporting: exportBusy(), restoring: restoringVersion, recording: recordingActive(cueId) }),
  changed: (snapshot) => emit('jobs:changed', snapshot),
})

function refuseExportWhileGenerating(): void {
  const refusal = exportRefusal(generations.owned(projectRepository))
  if (refusal) throw new Error(refusal)
}

function resetRepository(project: Project, revision = 0): SerialProjectRepository {
  cancelExports()
  projectRepository = new SerialProjectRepository(project, store.persistProjectFile, undefined, revision)
  generations.retire(projectRepository)
  store.adoptProject(projectRepository.projectForMain())
  return projectRepository
}

async function detachCurrentRepository(): Promise<void> {
  cancelExports()
  closeRenderWorker()
  generations.retire(null)
  const repository = projectRepository
  await repository?.detach()
  if (repository) await closeRecordings(repository)
  projectRepository = null
  clearAssetCache()
}

function abandonProject(): void {
  cancelExports()
  closeRenderWorker()
  generations.retire(null)
  if (projectRepository) void closeRecordings(projectRepository)
  projectRepository = null
  clearAssetCache()
  store.closeProject()
}

async function recoverOnOpen(repository: SerialProjectRepository): Promise<void> {
  const dir = store.getProjectDir()
  if (!dir) return
  try {
    const recovered = await recoverRecordings({ repository, dir })
    if (recovered > 0) emit('recordings:recovered', recovered)
  } catch (e) {
    console.warn('recording recovery skipped:', e)
  }
}

const pickedTemplates = new Set<string>()

function pickedTemplateDir(dir: string): string {
  const target = templateDirSchema.parse(dir)
  if (!pickedTemplates.has(target)) throw new Error('Template folder was not picked in this session')
  return target
}

const serialLifecycle = serialQueue()

function requireRepository(): SerialProjectRepository {
  if (!projectRepository) throw new Error('No project is open')
  return projectRepository
}

function requireSession(): TakeSession {
  const dir = store.getProjectDir()
  if (!dir) throw new Error('No project is open')
  return { repository: requireRepository(), dir }
}

const emitChange = (result: CommandResult): void => emit('project:changed', result)

async function publish(
  repository: SerialProjectRepository,
  fn: (project: Project) => ChangeSet | null
): Promise<void> {
  const result = await repository.mutate(fn)
  if (result) emit('project:changed', result)
}

function pushUsage(): void {
  void voiceProvider()
    .usage()
    .then((u) => emit('usage:updated', u))
    .catch(() => undefined)
}

function requireProject(): Project {
  const p = store.getProject()
  if (!p) throw new Error('No project is open')
  return p
}

async function autoAdopt(repository: SerialProjectRepository): Promise<void> {
  try {
    const r = await migration.apply(repository)
    if (r.adoptedNormal || r.adoptedComposite) {
      console.log(`auto-adopt: normal ${r.adoptedNormal}, composite ${r.adoptedComposite}`)
    }
  } catch (e) {
    console.warn('auto-adopt skipped:', e)
  }
}

async function repairTakeDurations(repository: SerialProjectRepository): Promise<void> {
  const entries = await probeTakeDurations(repository.projectForMain())
  if (entries.length === 0) return
  let applied: TakeDurationEntry[] = []
  await publish(repository, (current) => {
    const stillPending = new Set(pendingTakeDurations(current).map((e) => e.takeId))
    const result = applyTakeDurations(current, entries.filter((e) => stillPending.has(e.takeId)))
    applied = result.applied
    return result.cues.length > 0 ? { cues: result.cues } : null
  })
  if (applied.length > 0) emit('takes:durations', applied)
}

async function upgradeLoaded(project: Project, dir: string): Promise<boolean> {
  const migrated = applyAlienMigration(project)
  const relocated = await store.relocateMovedFiles(project, dir)
  return migrated || relocated
}

async function prepareOpened(project: Project, dir: string): Promise<void> {
  if (await upgradeLoaded(project, dir)) await store.saveProject(project)
}

async function consumeSuggestionsFile(
  strict: boolean,
  repository: SerialProjectRepository
): Promise<{ loaded: number; skipped: number } | null> {
  const dir = store.getProjectDir()
  if (!dir) return null
  const file = path.join(dir, 'suggestions.json')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    if (strict) throw new Error(`Could not read ${file}: not valid JSON`)
    console.error(`suggestions.json: invalid JSON, skipping`)
    return null
  }
  const parsed = z.record(z.string()).safeParse(data)
  if (!parsed.success) {
    if (strict) throw new Error(`Expected an object {"WemId": "new text", …} in ${file}`)
    console.error(`suggestions.json: unexpected structure, skipping`)
    return null
  }

  const changed: Cue[] = []
  await publish(repository, (project) => {
    const byKey = new Map(project.cues.map((c) => [c.key, c]))
    for (const [wemId, suggestion] of Object.entries(parsed.data)) {
      const cue = byKey.get(wemId)
      if (!cue || suggestion === cue.text) continue
      cue.suggestedText = suggestion
      changed.push(cue)
    }
    return changed.length > 0 ? { cues: changed } : null
  })
  const loaded = changed.length
  const skipped = Object.keys(parsed.data).length - loaded
  try {
    await fs.rename(file, path.join(dir, 'suggestions.imported.json'))
  } catch {
    console.error('suggestions.json: could not rename after import')
  }
  return { loaded, skipped }
}

const emptyProjectBase = (name: string): Omit<Project, 'id' | 'schemaVersion' | 'createdAt'> => ({
  name,
  media: { referenceDir: '', referencePattern: '' },
  characters: [],
  cues: [],
  sessions: [],
  pronunciationRules: '',
  exportTemplate: DEFAULT_EXPORT_TEMPLATE,
  ui: { filter: '', search: '' },
})

function announceProject(from?: WebContents): void {
  if (projectRepository) emit('project:opened', projectRepository.snapshot(), from)
  else emit('project:closed', null, from)
}

function announcedLifecycle<T>(from: WebContents | undefined, fn: () => Promise<T>): Promise<T> {
  return serialLifecycle(async () => {
    await requestUi({ kind: 'flush' }, from)
    await requestUi({ kind: 'leave' }, from)
    const before = projectRepository
    try {
      return await fn()
    } finally {
      if (projectRepository !== before) announceProject(from)
    }
  })
}

function openProject(dir: string, from?: WebContents) {
  return announcedLifecycle(from, async () => {
    const target = projectDirSchema(store.defaultProjectsRoot()).parse(dir)
    if (!(await store.exists(target))) return null
    const snapshot = await setupOpenedProject({
      detachCurrent: detachCurrentRepository,
      prepareProject: (project) => prepareOpened(project, target),
      openProject: () => store.openProjectDir(target),
      resetRepository,
      abandonProject,
      finishOpen: async (repository) => {
        await recoverOnOpen(repository)
        if (repository.projectForMain().csvBinding) await autoAdopt(repository)
        await consumeSuggestionsFile(false, repository)
        void repairTakeDurations(repository).catch((e: unknown) =>
          console.warn('duration repair skipped:', e)
        )
      },
    })
    if (!snapshot) throw new Error('Project could not be opened')
    return snapshot
  })
}

function createProject(name?: string, from?: WebContents) {
  return announcedLifecycle(from, async () => {
    const projectName = name === undefined ? uniqueProjectName(await store.projectFolderNames()) : projectNameSchema.parse(name)
    const dir = path.join(store.defaultProjectsRoot(), `${projectName}${PROJECT_SUFFIX}`)
    if (await store.exists(dir)) throw new Error(`Project "${projectName}" already exists`)
    await detachCurrentRepository()
    return resetRepository(await store.createProject(projectName, emptyProjectBase(projectName))).snapshot()
  })
}

function closeProject(from?: WebContents) {
  return announcedLifecycle(from, async () => {
    await detachCurrentRepository()
    await store.dropUnusedStems()
    store.closeProject()
  })
}

function importTemplate(dir: string, from?: WebContents) {
  return announcedLifecycle(from, async () => {
    const fresh = await validateTemplate(dir)
    const snapshot = await setupImportedProject({
      stageImport: () => Promise.resolve(fresh),
      detachCurrent: detachCurrentRepository,
      importProject: createProjectFromTemplate,
      currentProject: store.getProject,
      resetRepository,
      finishImport: async () => undefined,
    })
    return { snapshot, warnings: fresh.warnings }
  })
}

function restoreVersion(req: { n: number }, from?: WebContents) {
  return announcedLifecycle(from, async () => {
    const { n } = restoreVersionSchema.parse(req)
    const { repository, dir } = requireSession()
    restoringVersion = true
    try {
      const version = await store.readVersion(n)
      await upgradeLoaded(version, dir)
      await detachCurrentRepository()
      const current = repository.projectForMain()
      const revision = repository.currentRevision()
      let restored: Project
      try {
        restored = await store.restoreVersion(current, version, n)
      } catch (error) {
        resetRepository(current, revision)
        throw error
      }
      return resetRepository(restored, revision).snapshot()
    } finally {
      restoringVersion = false
    }
  })
}

function liveRepository(expected?: SerialProjectRepository): SerialProjectRepository {
  const repository = requireRepository()
  if (expected && expected !== repository) throw new Error('The project was closed or switched during this call; call status, then retry.')
  return repository
}

function importAudioPaths(req: { paths: string[]; rule: MatchRule }, expected?: SerialProjectRepository): Promise<AudioImportResult> {
  return serialLifecycle(async () => {
    const parsed = audioImportSchema.parse(req)
    const repository = liveRepository(expected)
    const projectDir = store.getProjectDir()
    if (!projectDir) throw new Error('No project is open')
    const { media, rest } = await splitMediaPaths(parsed.paths)
    const sources = await importSources(repository.projectForMain(), projectDir, media)
    if (sources.added.length > 0) {
      emit('project:changed', await repository.commit(sources.changes))
    }
    if (rest.length === 0) {
      return { added: 0, updated: 0, files: sources.added.length }
    }
    const { result, changes } = await importAudio(
      repository.projectForMain(),
      projectDir,
      rest,
      parsed.rule
    )
    emit('project:changed', await repository.commit(changes))
    return { ...result, files: result.files + sources.added.length }
  })
}

function addAssetPaths(req: { paths: string[]; skipMedia?: true }, expected?: SerialProjectRepository): Promise<AssetAddResult> {
  return serialLifecycle(async () => {
    const parsed = assetAddSchema.parse(req)
    const repository = liveRepository(expected)
    const projectDir = store.getProjectDir()
    if (!projectDir) throw new Error('No project is open')
    const result = await addAssets(repository.projectForMain().assets ?? [], projectDir, parsed.paths, parsed.skipMedia === true)
    if (result.added.length > 0) {
      await publish(repository, (project) => {
        project.assets = [...(project.assets ?? []), ...result.added]
        return { assets: structuredClone(project.assets) }
      })
    }
    return result
  })
}

function buildAudioLines(assetIds: string[], expected?: SerialProjectRepository): Promise<AudioLinesResult> {
  return serialLifecycle(async () => {
    const repository = liveRepository(expected)
    const projectDir = store.getProjectDir()
    if (!projectDir) throw new Error('No project is open')
    const { result, changes } = await assetAudioLines(repository.projectForMain(), projectDir, assetIds)
    emit('project:changed', await repository.commit(changes))
    return result
  })
}

async function readAssetPage(req: { id: string; from?: number; count?: number }): Promise<AssetPage> {
  const parsed = assetReadSchema.parse(req)
  const asset = requireRepository().projectForMain().assets?.find((a) => a.id === parsed.id)
  if (!asset) throw new Error('Asset not found')
  return assetPage(await readAssetCached(asset, {}), parsed.from ?? 0, parsed.count ?? ASSET_READ_MAX)
}

async function previewTableImport(req: TableRequest, expected?: SerialProjectRepository): Promise<TablePreview> {
  const parsed = tableImportSchema.parse(req)
  const table = await readTable(parsed.path)
  return previewTableFile(liveRepository(expected).projectForMain(), table, parsed)
}

function importTable(req: TableRequest, expected?: SerialProjectRepository): Promise<TableImportResult> {
  return serialLifecycle(async () => {
    const parsed = tableImportSchema.parse(req)
    const table = await readTable(parsed.path)
    let imported: ReturnType<typeof importTableFile> | undefined
    await publish(liveRepository(expected), (project) => (imported = importTableFile(project, table, parsed)).changes)
    if (!imported) throw new Error('Table import did not run')
    return imported.result
  })
}

function reimportTemplateDir(dir: string, expected?: SerialProjectRepository): Promise<ReimportResult> {
  return serialLifecycle(async () => {
    const target = templateDirSchema.parse(dir)
    const repository = liveRepository(expected)
    const projectDir = store.getProjectDir()
    if (!projectDir) throw new Error('No project is open')
    const validation = await validateTemplate(target)
    const { result, changes } = await reimportTemplate(validation, repository.projectForMain(), projectDir)
    emit('project:changed', await repository.commit(changes))
    return result
  })
}

function queueGeneration(
  req: GenJob,
  origin: JobOrigin,
  expected?: SerialProjectRepository,
  after?: (take: Take) => Promise<void>
): QueuedGeneration {
  const repository = liveRepository(expected)
  const session = requireSession()
  const chars = jobChars(req, repository.projectForMain().pronunciationRules)
  return generations.submit({
    kind: req.kind,
    cueId: req.cueId,
    origin,
    chars,
    owner: repository,
    run: async () => {
      const provider = voiceProvider()
      try {
        const take =
          req.kind === 'tts'
            ? await createTtsTake(session, req, provider, emitChange)
            : await createStsTake(session, req, provider, emitChange)
        pushUsage()
        await after?.(take)
        return take
      } catch (error) {
        throw repository.isLive() ? error : new Error('The project was closed or switched during generation.')
      }
    },
  })
}

async function measureTake(cueId: string, take: Take, expected: SerialProjectRepository, admit?: () => void): Promise<number> {
  const duration = await decodedDuration(take.file.relPath)
  if (!duration) throw new Error('The new take could not be measured.')
  const entry = { cueId, takeId: take.id, duration }
  let applied: TakeDurationEntry[] = []
  await publish(liveRepository(expected), (project) => {
    admit?.()
    const result = applyTakeDurations(project, [entry])
    applied = result.applied
    return result.cues.length > 0 ? { cues: result.cues } : null
  })
  if (applied.length > 0) emit('takes:durations', applied)
  return duration
}

function transcribe(
  req: { cueIds: string[]; overwrite?: boolean },
  expected?: SerialProjectRepository
): Promise<{ updated: number; skipped: number }> {
  return serialLifecycle(async () => {
    const parsed = transcribeSchema.parse(req)
    const repository = liveRepository(expected)
    const result = await transcribeCues(
      repository,
      parsed.cueIds,
      parsed.overwrite === true,
      async (ref) => voiceProvider().stt({ audio: await fs.readFile(ref.relPath), filename: path.basename(ref.relPath) }),
      emitChange
    )
    pushUsage()
    return result
  })
}

function registerHandlers(): void {
  typedHandle('project:list', () => store.listProjects())

  typedHandleFrom('project:open', (sender, dir) => openProject(dir, sender))

  typedHandleFrom('project:create', (sender, name) => createProject(name, sender))

  typedHandle('project:delete', (dir: string) =>
    serialLifecycle(async () => {
      const target = projectDirSchema(store.defaultProjectsRoot()).parse(dir)
      const open = store.getProjectDir()
      if (open && normalizePath(open) === normalizePath(target)) {
        throw new Error('Close the project before deleting it')
      }
      await shell.trashItem(target)
    })
  )

  typedHandleFrom('project:close', (sender) => closeProject(sender))

  typedHandle('project:pickTemplate', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Import project template',
      properties: ['openDirectory'],
    }
    const win = BrowserWindow.getFocusedWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null
    pickedTemplates.add(picked.filePaths[0])
    return toPreview(await validateTemplate(picked.filePaths[0]))
  })

  typedHandleFrom('project:importTemplate', (sender, dir) => importTemplate(pickedTemplateDir(dir), sender))

  typedHandle('import:pick', async (kind) => {
    const parsed = z.enum(['files', 'folder', 'table', 'audio']).parse(kind)
    const options: Electron.OpenDialogOptions =
      kind === 'folder'
        ? { title: 'Import folder', properties: ['openDirectory'] }
        : parsed === 'audio'
          ? {
              title: 'Add audio',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'Audio', extensions: TAKE_FILE_EXTENSIONS }],
            }
          : parsed === 'table'
            ? {
                title: 'Import text table',
                properties: ['openFile'],
                filters: [{ name: 'Tables', extensions: ['csv', 'tsv', 'txt', 'xlsx'] }],
              }
            : {
                title: 'Import files',
                properties: ['openFile', 'multiSelections'],
                filters: [
                  { name: 'Files', extensions: ASSET_EXTENSIONS },
                  { name: 'All files', extensions: ['*'] },
                ],
              }
    const win = BrowserWindow.getFocusedWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? [] : picked.filePaths
  })

  typedHandle('import:audio', (req) => importAudioPaths(req))

  typedHandle('import:tablePreview', (req) => previewTableImport(req))

  typedHandle('import:table', (req) => importTable(req))

  typedHandle('source:detect', (req) =>
    serialLifecycle(async () => {
      const parsed = detectSchema.parse(req)
      const repository = projectRepository
      if (!repository) throw new Error('No project is open')
      const { result, changes } = await detectLines(
        repository.projectForMain(),
        parsed.sourceId,
        parsed.mode
      )
      emit('project:changed', await repository.commit(changes))
      return result
    })
  )

  typedHandle('import:template', (dir) => reimportTemplateDir(dir))

  typedHandle('assets:add', (req) => addAssetPaths(req))

  typedHandle('assets:read', readAssetPage)

  typedHandle('project:command', (command) => {
    if (!projectRepository) throw new Error('No project is open')
    const parsed = projectCommandSchema.parse(command)
    if (!audioWithinRoots(parsed, trustedAudioRoots())) throw new Error('Audio is outside this project')
    return projectRepository.execute(parsed)
  })

  typedHandle('project:saveVersion', (req) =>
    serialLifecycle(async () => {
      const parsed = saveVersionSchema.parse(req)
      return recordVersions((previous) => store.saveVersion(previous, parsed.name))
    })
  )

  typedHandleFrom('project:restoreVersion', (sender, req) => restoreVersion(req, sender))

  typedHandle('ui:save', (ui: UiSessionState) => store.saveUi(ui))

  typedHandle('bridge:reply', async (reply) => settleUi(bridgeReplySchema.parse(reply)))

  typedHandleFrom('render:reply', async (sender, reply) => settleRender(sender.id, renderReplySchema.parse(reply)))

  typedHandle('suggestions:load', async () => {
    const r = await consumeSuggestionsFile(true, requireRepository())
    if (!r) {
      const dir = store.getProjectDir()
      throw new Error(`Suggestions file not found: ${path.join(dir ?? '?', 'suggestions.json')}`)
    }
    return r
  })

  typedHandle('rules:get', async () => requireProject().pronunciationRules)

  typedHandle('audio:readRef', async (absPath: string) => {
    if (!isAllowedPath(absPath)) throw new Error('Path is outside the allowlist')
    const buf = await fs.readFile(absPath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  typedHandle('shell:reveal', async (absPath: string) => {
    if (!isAllowedPath(absPath) && !isInsideExportDir(absPath)) throw new Error('Path is outside the allowlist')
    shell.showItemInFolder(path.resolve(absPath))
  })

  typedHandle('rec:begin', (req) => {
    const parsed = recBeginSchema.parse(req)
    const session = requireSession()
    const refusal = recordingRefusal(generations.check(parsed.cueId))
    if (refusal) throw new Error(refusal)
    return beginRecording(session, parsed.cueId, parsed.sampleRate, parsed.bitDepth)
  })

  typedHandle('rec:chunk', (req) => {
    const parsed = recChunkSchema.parse(req)
    const pcm = parsed.pcm
    const bytes = ArrayBuffer.isView(pcm)
      ? Buffer.from(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength)
      : Buffer.from(pcm)
    return appendRecording(parsed.session, bytes)
  })

  typedHandle('rec:finish', (req) => {
    const parsed = recFinishSchema.parse(req)
    return finishRecording(parsed.session, parsed.fragment === true, emitChange)
  })

  typedHandle('rec:finishPasses', (req) => {
    const parsed = recFinishPassesSchema.parse(req)
    return finishPasses(parsed.session, parsed.passes, emitChange)
  })

  typedHandle('rec:abort', (req) => abortRecording(recAbortSchema.parse(req).session))

  typedHandle('take:importFiles', async (cueId, paths) => {
    const parsed = takeImportSchema.parse({ cueId, paths })
    const session = requireSession()
    const takes: Take[] = []
    const failed: string[] = []
    const base = takeBase()
    for (const [i, src] of parsed.paths.entries()) {
      try {
        takes.push(await importTakeFile(session, parsed.cueId, src, `${base}_${i + 1}_imp`, emitChange))
      } catch (e) {
        failed.push(`${path.basename(src)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { takes, failed }
  })

  typedHandle('take:setDurations', async (items) => {
    const parsed = durationsSchema.parse(items)
    let applied: TakeDurationEntry[] = []
    await publish(requireRepository(), (project) => {
      const result = applyTakeDurations(project, parsed)
      applied = result.applied
      return result.cues.length > 0 ? { cues: result.cues } : null
    })
    if (applied.length > 0) emit('takes:durations', applied)
    return { updated: applied.length }
  })

  typedHandle('stems:isolate', async (cueId, wav) => {
    const id = z.string().min(1).max(200).parse(cueId)
    const bytes = wavBytes(wav)
    const project = requireProject()
    const cue = project.cues.find((c) => c.id === id)
    if (!cue) throw new Error('Cue not found')
    const isolated = await voiceProvider().audioIsolation({ audio: bytes, filename: `${id}.wav` })
    pushUsage()
    return isolated.buffer.slice(
      isolated.byteOffset,
      isolated.byteOffset + isolated.byteLength
    ) as ArrayBuffer
  })

  typedHandle('stems:save', async (cueId, voiceWav, restWav) => {
    const id = z.string().min(1).max(200).parse(cueId)
    const voice = wavBytes(voiceWav)
    const rest = wavBytes(restWav)
    const project = requireProject()
    if (!project.cues.some((c) => c.id === id)) throw new Error('Cue not found')
    const stems = await store.saveStems(id, voice, rest)
    return stemsSchema.parse(stems) as Stem[]
  })

  typedHandle('gen:run', (req) => queueGeneration(genRunSchema.parse(req), 'ui').done)
  typedHandle('gen:cancel', async (ids) => generations.cancel(jobIdsSchema.parse(ids)))
  typedHandle('gen:list', async () => generations.snapshot())

  typedHandle('provider:transcribe', (req) => transcribe(req))

  typedHandle('provider:voices', () => voiceProvider().voices())
  typedHandle('provider:models', () => voiceProvider().models())

  typedHandle('provider:testVoice', async (characterId: string) => {
    const id = z.string().min(1).max(200).parse(characterId)
    const project = requireProject()
    const character = project.characters.find((c) => c.id === id)
    if (!character) throw new Error('Character not found')
    if (!character.provider.voiceId) {
      throw new Error(`No voice configured for character "${character.name}"`)
    }
    return singleFlight(testVoiceInFlight, id, `Voice test already running for "${character.name}"`, async () => {
      const audio = await voiceProvider().tts({
        text: TEST_VOICE_TEXT,
        voiceId: character.provider.voiceId,
        model: character.provider.ttsModel,
        settings: character.voiceSettings,
      })
      pushUsage()
      return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer
    })
  })

  typedHandle('provider:usage', () => voiceProvider().usage())
  typedHandle('provider:setApiKey', (k: string) => setApiKey(k))
  typedHandle('provider:hasApiKey', () => voiceProvider().hasApiKey())

  typedHandle('migration:dryRun', () => migration.dryRun())
  typedHandle('migration:apply', async () => {
    const { published, ...result } = await migration.apply(requireRepository())
    if (published) emit('project:changed', published)
    return result
  })

  typedHandle('csv:preview', async (p: string) => {
    const src = p || store.getProject()?.csvBinding?.csvPath
    if (!src) throw new Error('No CSV path given and the project has no CSV binding')
    const raw = await fs.readFile(src, 'utf-8')
    const csv = parseCsv(raw)
    return { headers: csv.headers, rows: csv.rows.slice(0, 5) }
  })

  typedHandle('csv:sync', () => syncCsv())

  typedHandleFrom('export:planBatch', async (sender, req) => {
    const parsed = batchExportSchema.parse(req)
    refuseExportWhileGenerating()
    return planBatchExport(parsed, sender.id)
  })
  typedHandle('export:info', () => exportInfo())
  typedHandle('export:pickDir', async () => {
    const options: Electron.OpenDialogOptions = {
      title: 'Export folder',
      properties: ['openDirectory', 'createDirectory'],
    }
    const win = BrowserWindow.getFocusedWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]
  })
  typedHandle('export:copy', (outPath: string) => copyJob(z.string().min(1).parse(outPath)))
  typedHandle('export:encode', (outPath, wav) => encodeJob(z.string().min(1).parse(outPath), wav))
  typedHandle('export:abort', async (token: string) => abortBatchExport(z.string().uuid().parse(token)))
  typedHandle('export:finish', (token, summary) => {
    const parsed = exportSummarySchema.parse(summary)
    const planToken = z.string().uuid().parse(token)
    return serialLifecycle(() =>
      finishExport(
        planToken,
        parsed,
        () => (parsed.exported.length > 0 ? stampVersion() : Promise.resolve(undefined)),
        () => projectRepository?.currentRevision(),
        (publish) => (projectRepository ? projectRepository.exclusive(publish) : publish())
      )
    )
  })

  typedHandle('export:videoPlan', (sourceId: string) => {
    const parsed = z.string().min(1).max(200).parse(sourceId)
    refuseExportWhileGenerating()
    return planVideoExport(parsed)
  })
  typedHandle('export:videoChunk', (token, pcm, sampleRate, channels) =>
    appendVideoChunk(
      z.string().uuid().parse(token),
      pcm,
      z.number().int().min(8000).max(384000).parse(sampleRate),
      z.number().int().min(1).max(8).parse(channels)
    )
  )
  typedHandle('export:videoFinish', (token: string) =>
    finishVideoExport(z.string().uuid().parse(token))
  )
  typedHandle('export:videoAbort', (token: string) =>
    abortVideoExport(z.string().uuid().parse(token))
  )

  typedHandle('settings:get', () => store.getSettings())
  typedHandle('settings:set', async (s: AppSettings) => {
    await store.setSettings(appSettingsSchema.parse(s))
    void syncAgentServer()
  })
  typedHandle('updater:getStatus', async () => getUpdateStatus())
  typedHandle('updater:check', () => checkForUpdates())
  typedHandle('updater:restart', async () => restartToUpdate())
}

async function renderForAgent(cueId: string, source: 'output' | 'original', expected?: SerialProjectRepository) {
  const repository = liveRepository(expected)
  const dir = store.getProjectDir()
  if (!dir) throw new Error('No project is open')
  const project = repository.projectForMain()
  const cue = project.cues.find((c) => c.id === cueId)
  if (!cue) throw new Error('The line was removed meanwhile; call lines, then retry.')
  const revision = repository.currentRevision()
  const outPath = path.join(await agentRenderDir(dir), renderFileName(cue.key, cue.id, sha256Hex, source === 'original' ? '.original' : ''))
  const job = lineJob(project, cue, outPath, source)
  if (!job) return null
  const wav = await renderLineWav(job)
  requireRevision(revision, liveRepository(expected).currentRevision())
  await encodeAnalysis(job, wav)
  const metrics = await measureAudio(outPath)
  requireRevision(revision, liveRepository(expected).currentRevision())
  return { path: outPath, name: job.name, metrics }
}

const serialAgentExport = serialQueue()

function requireExportIdle(expected?: SerialProjectRepository): void {
  liveRepository(expected)
  if (exportBusy()) throw new Error('The app is exporting; wait for that export to finish, then retry.')
  refuseExportWhileGenerating()
}

function exportForAgent(cueIds: string[], expected?: SerialProjectRepository): Promise<BatchExportResult> {
  return serialAgentExport(async () => {
    requireExportIdle(expected)
    const owner = await renderWorker()
    requireExportIdle(expected)
    const plan = await planBatchExport(batchExportSchema.parse({ cueIds }), owner, liveRepository(expected).currentRevision())
    try {
      return await renderExportPlan(plan)
    } finally {
      releaseExports(owner, plan.token)
    }
  })
}

async function transcribeFile(file: string): Promise<string> {
  const text = await voiceProvider().stt({ audio: await fs.readFile(file), filename: path.basename(file) })
  pushUsage()
  return text
}

const guardedSessions = new WeakMap<McpSession, string>()

async function guardAgentWrite(session: McpSession): Promise<void> {
  await requestUi({ kind: 'flush' })
  const dir = store.getProjectDir()
  if (!projectRepository || !dir || guardedSessions.get(session) === dir) return
  await serialLifecycle(async () => {
    if (!needsGuardVersion(requireRepository().projectForMain().versions ?? [], Date.now())) return
    await recordVersions((previous) => store.saveVersion(previous, 'Before agent'))
  })
  guardedSessions.set(session, dir)
}

function agentServerSpec(): McpServer {
  return {
    info: { name: 'vo-studio', version: app.getVersion() },
    instructions: AGENT_INSTRUCTIONS,
    beforeWrite: guardAgentWrite,
    tools: agentTools({
      version: app.getVersion(),
      repository: () => projectRepository,
      projectDir: store.getProjectDir,
      listProjects: store.listProjects,
      openProject: (dir) => openProject(dir),
      createProject: (name) => createProject(name),
      importTemplate: (dir) => importTemplate(templateDirSchema.parse(dir)),
      closeProject: () => closeProject(),
      saveVersion: (name) => serialLifecycle(() => recordVersions((previous) => store.saveVersion(previous, name))),
      restoreVersion: (n) => restoreVersion({ n }),
      flushUi: () => requestUi({ kind: 'flush' }),
      checkRemovable: (cueIds) => requestUi({ kind: 'removable', cueIds }),
      emit: emitChange,
      audioRoots: trustedAudioRoots,
      importAudio: importAudioPaths,
      previewTable: previewTableImport,
      importTable,
      reimportTemplate: reimportTemplateDir,
      addAssets: (paths, expected) => addAssetPaths({ paths }, expected),
      loadAsset: readAssetCached,
      buildAudioLines,
      transcribe,
      renderLine: renderForAgent,
      exportInfo,
      exportLines: exportForAgent,
      transcribeFile,
      decodeAudio: (file) => ffmpegPcm(file, ANALYSIS_RATE, ANALYSIS_MAX_SECONDS),
      analyzeAudio: analyzeInWorker,
      drawFigure: renderProsodyImage,
      provider: voiceProvider,
      generation: generations,
      queueGeneration: (req, expected, after) => queueGeneration(req, 'agent', expected, after),
      measureTake,
      settings: store.getSettings,
      diagnostics,
      screenshot: async () => {
        const win = uiWindow()
        return win ? (await win.webContents.capturePage()).toPNG() : null
      },
    }),
  }
}

let agentForced = process.argv.includes(AGENT_FLAG)
let agentServer: AgentServerHandle | null = null
let agentSync: Promise<void> = Promise.resolve()

function syncAgentServer(): Promise<void> {
  agentSync = agentSync.then(async () => {
    const wanted = agentForced || sanitizeAgentAccess((await store.getSettings()).agentAccess) === true
    if (wanted && !agentServer) agentServer = await startAgentServer(app.getPath('userData'), agentServerSpec())
    else if (!wanted && agentServer) {
      await agentServer.stop()
      agentServer = null
    }
  }).catch((e: unknown) => console.error('agent server:', e))
  return agentSync
}

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}

if (primaryInstance) void app.whenReady().then(() => {
  protocol.handle('vostudio', async (req) => {
    const url = new URL(req.url)
    if (url.host !== 'audio') return new Response('Not found', { status: 404 })
    let abs: string
    try {
      abs = Buffer.from(decodeURIComponent(url.pathname.slice(1)), 'base64').toString('utf-8')
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (!isAllowedPath(abs)) return new Response('Forbidden', { status: 403 })

    const type = AUDIO_MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream'
    let size: number
    try {
      size = (await fs.stat(abs)).size
    } catch {
      return new Response('Not found', { status: 404 })
    }

    const m = RANGE_RE.exec(req.headers.get('Range')?.trim() ?? '')
    if (!m) {
      return new Response(fileStream(abs), {
        headers: {
          'Content-Type': type,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
        },
      })
    }

    const [, from, to] = m
    let start: number
    let end: number
    if (from === '') {
      start = Math.max(0, size - (parseInt(to || '0', 10) || 0))
      end = size - 1
    } else {
      start = parseInt(from, 10)
      end = to === '' ? size - 1 : Math.min(size - 1, parseInt(to, 10))
    }
    if (!Number.isFinite(start) || start < 0 || start >= size || end < start) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
      })
    }

    return new Response(fileStream(abs, start, end), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'speaker-selection' || permission === 'clipboard-sanitized-write')
  })

  Menu.setApplicationMenu(null)
  registerHandlers()
  createWindow()
  initializeUpdater((next) => emit('updater:status', next))
  void syncAgentServer()

  app.on('activate', () => {
    if (uiWindows().length === 0) createWindow()
  })

  app.on('second-instance', (_event, argv) => {
    if (argv.includes(AGENT_FLAG) && !agentForced) {
      agentForced = true
      void syncAgentServer()
    }
    const win = uiWindows()[0]
    if (!win) return createWindow()
    if (win.isMinimized()) win.restore()
    win.focus()
  })
})

app.on('web-contents-created', (_event, contents) => {
  const id = contents.id
  contents.on('render-process-gone', () => releaseExports(id))
  contents.once('destroyed', () => releaseExports(id))
})

app.on('will-quit', () => {
  void agentServer?.stop()
})

function quitIfNoWindows(): void {
  if (BrowserWindow.getAllWindows().length === 0) app.quit()
}

app.on('window-all-closed', () => {
  void flushPersist().then(quitIfNoWindows, quitIfNoWindows)
})

if (primaryInstance) void app.whenReady().then(async () => {
  try {
    await runFfmpeg(['-version'])
  } catch (e) {
    console.error('FFMPEG BROKEN:', e)
  }
})
