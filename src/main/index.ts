import { app, BrowserWindow, dialog, Menu, protocol, session, shell } from 'electron'
import path from 'path'
import { createReadStream, promises as fs } from 'fs'
import { Readable } from 'stream'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { typedHandle } from './typed-ipc'
import {
  autoSelectsOutput,
  exportSummarySchema,
  projectCommandSchema,
  projectDirSchema,
  projectNameSchema,
  batchExportSchema,
  appSettingsSchema,
  detectSchema,
  saveVersionSchema,
  stemsSchema,
  stsSchema,
  templateDirSchema,
  ttsSchema,
} from './schemas'
import { emit } from './emit'
import * as store from './project-store'
import * as eleven from './providers/elevenlabs'
import { setApiKey, hasApiKey } from './secrets'
import { runFfmpeg } from './ffmpeg'
import { parseCsv } from '@shared/csv'
import { applyRules } from '@shared/pronunciation'
import { NO_LANGUAGE_CODE_MODEL } from '@shared/provider-models'
import { changeCueSourceText, changeTakeOutput } from '@shared/approval'
import {
  cueVoiceUnchanged,
  emptyEdits,
  singleFlight,
  MAX_STS_SECONDS,
  type Cue,
  type Stem,
  type Take,
  type UiSessionState,
} from '@shared/domain'
import type { Project } from '@shared/domain'
import type { AppSettings } from '@shared/ipc'
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
import { applyTakeDurations, pendingTakeDurations } from '@shared/library'
import { importTable } from './table-import'
import {
  abortVideoExport,
  appendVideoChunk,
  copyJob,
  encodeJob,
  finishExport,
  finishVideoExport,
  planBatchExport,
  planVideoExport,
  exportInfo,
} from './export'
import { detectLines, importSources, splitMediaPaths } from './sources'
import { applyAlienMigration } from './satisfactory-preset'
import { checkForUpdates, getUpdateStatus, initializeUpdater, restartToUpdate } from './updater'
import { SerialProjectRepository } from './project-repository'
import { setupImportedProject, setupOpenedProject } from './project-import'
import { normalizePath, PROJECT_SUFFIX } from '@shared/project-summary'

protocol.registerSchemesAsPrivileged([
  { scheme: 'vostudio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
])

const REFERENCE_DIR_ENV = process.env['VOSTUDIO_REFERENCE_DIR']
const RANGE_RE = /^bytes=(\d*)-(\d*)$/

function fileStream(abs: string, start?: number, end?: number): ReadableStream<Uint8Array> {
  const options = start === undefined ? {} : { start, ...(end === undefined ? {} : { end }) }
  return Readable.toWeb(createReadStream(abs, options)) as ReadableStream<Uint8Array>
}

function isAllowedPath(abs: string): boolean {
  const roots = [store.getProjectDir(), REFERENCE_DIR_ENV, GENERATED_DIR].filter(Boolean) as string[]
  const norm = path.resolve(abs).toLowerCase()
  if (roots.some((r) => norm.startsWith(path.resolve(r).toLowerCase() + path.sep))) return true
  const project = store.getProject()
  if (!project) return false
  if (project.sources?.some((s) => s.media !== undefined && path.resolve(s.media).toLowerCase() === norm)) {
    return true
  }
  return project.cues.some(
    (cue) =>
      (cue.referenceAudio !== undefined &&
        path.resolve(cue.referenceAudio.relPath).toLowerCase() === norm) ||
      cue.takes.some((take) => path.resolve(take.file.relPath).toLowerCase() === norm)
  )
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'VO Studio',
    backgroundColor: '#191b1e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.code === 'F12') win.webContents.toggleDevTools()
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
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

const recordingSchema = z.object({
  cueId: z.string().min(1),
  durationSec: z.number().min(0).max(3600),
  sampleRate: z.number().int().min(8000).max(384000),
  fragment: z.boolean().optional(),
})

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

async function stampVersion(): Promise<number> {
  await flushPersist()
  const before = store.getProject()?.versions?.length ?? 0
  const n = await store.ensureVersion()
  const versions = store.getProject()?.versions
  if (versions && versions.length !== before && projectRepository) {
    emit('project:changed', await projectRepository.commit({ versions }))
  }
  return n
}

const filePath = z.string().min(1).max(4096).refine((p) => path.isAbsolute(p), {
  message: 'Path must be absolute',
})

const matchRuleSchema = z.enum(['id', 'exportName', 'tableId'])

const audioImportSchema = z.object({
  paths: z.array(filePath).min(1).max(200),
  rule: matchRuleSchema,
})

const tableImportSchema = z.object({
  path: filePath,
  rule: matchRuleSchema,
  mapping: z
    .object({
      id: z.number().int().min(0).max(4096).optional(),
      text: z.number().int().min(0).max(4096).optional(),
      translation: z.number().int().min(0).max(4096).optional(),
      character: z.number().int().min(0).max(4096).optional(),
    })
    .optional(),
  replaceTranslations: z.boolean().optional(),
})

const transcribeSchema = z.object({
  cueIds: z.array(z.string().min(1).max(200)).min(1).max(500),
  overwrite: z.boolean().optional(),
})

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

let projectRepository: SerialProjectRepository | null = null
function resetRepository(project: Project): SerialProjectRepository {
  projectRepository = new SerialProjectRepository(project, store.persistProjectSnapshot)
  store.adoptProject(projectRepository.projectForMain())
  return projectRepository
}

async function detachCurrentRepository(): Promise<void> {
  const repository = projectRepository
  await repository?.detach()
  projectRepository = null
}

function abandonProject(): void {
  projectRepository = null
  store.closeProject()
}

const pickedTemplates = new Set<string>()

function pickedTemplateDir(dir: string): string {
  const target = templateDirSchema.parse(dir)
  if (!pickedTemplates.has(target)) throw new Error('Template folder was not picked in this session')
  return target
}

let lifecycle: Promise<unknown> = Promise.resolve()
function serialLifecycle<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn)
  lifecycle = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

const dirExists = (dir: string): Promise<boolean> => fs.stat(dir).then(() => true, () => false)

async function publishCue(cue: Project['cues'][number]): Promise<void> {
  if (!projectRepository) throw new Error('No project is open')
  emit('project:changed', await projectRepository.commit({ cues: [cue] }))
}

function pushUsage(): void {
  void eleven
    .usage()
    .then((u) => emit('usage:updated', u))
    .catch(() => undefined)
}

function requireProject(): Project {
  const p = store.getProject()
  if (!p) throw new Error('No project is open')
  return p
}

async function autoAdopt(): Promise<void> {
  try {
    const r = await migration.apply()
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
  const current = repository.projectForMain()
  const stillPending = new Set(pendingTakeDurations(current).map((e) => e.takeId))
  const { cues, applied } = applyTakeDurations(
    current,
    entries.filter((e) => stillPending.has(e.takeId))
  )
  if (cues.length === 0) return
  emit('project:changed', await repository.commit({ cues: structuredClone(cues) }))
  emit('takes:durations', applied)
}

async function migrateCharacters(project: Project): Promise<void> {
  if (applyAlienMigration(project)) await store.saveProject(project)
}

async function writeGuardedTake(
  cueId: string,
  characterId: string,
  voiceId: string,
  fileName: string,
  bytes: Buffer
): Promise<{ cue: Cue; abs: string }> {
  const abs = await store.writeTakeFile(cueId, fileName, bytes)
  const project = requireProject()
  const cue = project.cues.find((c) => c.id === cueId)
  if (!cue || !cueVoiceUnchanged(project, cueId, characterId, voiceId)) {
    await fs.rm(abs, { force: true }).catch(() => undefined)
    throw new Error('Discarded: cue reassigned during generation')
  }
  return { cue, abs }
}

async function consumeSuggestionsFile(
  strict: boolean,
  repository: SerialProjectRepository | null = projectRepository
): Promise<{ loaded: number; skipped: number } | null> {
  const project = requireProject()
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

  const byKey = new Map(project.cues.map((c) => [c.key, c]))
  let loaded = 0
  let skipped = 0
  const changed = [] as Project['cues']
  for (const [wemId, suggestion] of Object.entries(parsed.data)) {
    const cue = byKey.get(wemId)
    if (!cue || suggestion === cue.text) {
      skipped++
      continue
    }
    cue.suggestedText = suggestion
    changed.push(cue)
    loaded++
  }
  if (loaded > 0) {
    if (repository) emit('project:changed', await repository.commit({ cues: changed }))
    else await store.saveProject(project)
  }
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
  exportTemplate: '{EventName}__{WemId}.{ext}',
  ui: { filter: '', search: '' },
})

function registerHandlers(): void {
  typedHandle('project:list', () => store.listProjects())

  typedHandle('project:open', (dir: string) =>
    serialLifecycle(async () => {
      const target = projectDirSchema(store.defaultProjectsRoot()).parse(dir)
      const snapshot = await setupOpenedProject({
        detachCurrent: detachCurrentRepository,
        prepareProject: migrateCharacters,
        openProject: () => store.openProjectDir(target),
        resetRepository,
        abandonProject,
        finishOpen: async (repository) => {
          if (repository.projectForMain().csvBinding) await autoAdopt()
          await consumeSuggestionsFile(false, repository)
          void repairTakeDurations(repository).catch((e: unknown) =>
            console.warn('duration repair skipped:', e)
          )
        },
      })
      if (!snapshot) throw new Error('Project could not be opened')
      return snapshot
    })
  )

  typedHandle('project:create', (name: string) =>
    serialLifecycle(async () => {
      const projectName = projectNameSchema.parse(name)
      const dir = path.join(store.defaultProjectsRoot(), `${projectName}${PROJECT_SUFFIX}`)
      if (await dirExists(dir)) throw new Error(`Project "${projectName}" already exists`)
      await detachCurrentRepository()
      return resetRepository(await store.createProject(projectName, emptyProjectBase(projectName))).snapshot()
    })
  )

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

  typedHandle('project:close', () =>
    serialLifecycle(async () => {
      await detachCurrentRepository()
      await store.dropUnusedStems()
      store.closeProject()
    })
  )

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

  typedHandle('project:importTemplate', (dir: string) =>
    serialLifecycle(async () => {
      const fresh = await validateTemplate(pickedTemplateDir(dir))
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
  )

  typedHandle('import:pick', async (kind) => {
    const parsed = z.enum(['files', 'folder', 'table']).parse(kind)
    const options: Electron.OpenDialogOptions =
      kind === 'folder'
        ? { title: 'Import folder', properties: ['openDirectory'] }
        : parsed === 'table'
          ? {
              title: 'Import text table',
              properties: ['openFile'],
              filters: [{ name: 'Tables', extensions: ['csv', 'tsv', 'txt'] }],
            }
          : {
              title: 'Import audio files',
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: 'Media', extensions: ['wav', 'mp3', 'ogg', 'm4a', 'mp4', 'mov', 'mkv'] },
              ],
            }
    const win = BrowserWindow.getFocusedWindow()
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? [] : picked.filePaths
  })

  typedHandle('import:audio', (req) =>
    serialLifecycle(async () => {
      const parsed = audioImportSchema.parse(req)
      const repository = projectRepository
      const projectDir = store.getProjectDir()
      if (!repository || !projectDir) throw new Error('No project is open')
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
  )

  typedHandle('import:table', (req) =>
    serialLifecycle(async () => {
      const parsed = tableImportSchema.parse(req)
      const repository = projectRepository
      if (!repository) throw new Error('No project is open')
      const { result, changes } = await importTable(
        repository.projectForMain(),
        parsed.path,
        parsed.rule,
        parsed.mapping,
        parsed.replaceTranslations === true
      )
      emit('project:changed', await repository.commit(changes))
      return result
    })
  )

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

  typedHandle('import:template', (dir: string) =>
    serialLifecycle(async () => {
      const target = templateDirSchema.parse(dir)
      const repository = projectRepository
      const projectDir = store.getProjectDir()
      if (!repository || !projectDir) throw new Error('No project is open')
      const validation = await validateTemplate(target, true)
      const { result, changes } = await reimportTemplate(validation, repository.projectForMain(), projectDir)
      emit('project:changed', await repository.commit(changes))
      return result
    })
  )

  typedHandle('project:command', (command) => {
    if (!projectRepository) throw new Error('No project is open')
    return projectRepository.execute(projectCommandSchema.parse(command))
  })

  typedHandle('project:saveVersion', (req) =>
    serialLifecycle(async () => {
      const parsed = saveVersionSchema.parse(req)
      requireProject()
      await flushPersist()
      const versions = await store.saveVersion(parsed.name)
      if (projectRepository) emit('project:changed', await projectRepository.commit({ versions }))
      return versions
    })
  )

  typedHandle('ui:save', (ui: UiSessionState) => store.saveUi(ui))

  typedHandle('suggestions:load', async () => {
    const r = await consumeSuggestionsFile(true)
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
    if (!isAllowedPath(absPath)) throw new Error('Path is outside the allowlist')
    shell.showItemInFolder(path.resolve(absPath))
  })

  typedHandle('take:saveRecording', async (cueId, wav, durationSec, sampleRate, fragment) => {
    const parsed = recordingSchema.parse({ cueId, durationSec, sampleRate, fragment })
    const bytes = wavBytes(wav)

    const project = requireProject()
    const cue = project.cues.find((c) => c.id === parsed.cueId)
    if (!cue) throw new Error('Cue not found')

    const fileName = `t_${stamp()}_rec.wav`
    const abs = await store.writeTakeFile(cue.id, fileName, bytes)
    const take: Take = {
      id: randomUUID(),
      kind: 'recording',
      createdAt: new Date().toISOString(),
      file: {
        fileId: `${cue.id}/${fileName}`,
        relPath: abs,
        format: 'wav',
        sampleRate: parsed.sampleRate,
        channels: 1,
      },
      duration: parsed.durationSec,
      meta: cue.text ? { text: cue.text } : {},
      edits: emptyEdits(),
      ...(parsed.fragment ? { fragment: true as const } : {}),
    }
    cue.takes.push(take)
    await publishCue(cue)
    return take
  })

  typedHandle('take:setDurations', async (items) => {
    const parsed = durationsSchema.parse(items)
    const { cues, applied } = applyTakeDurations(requireProject(), parsed)
    if (cues.length > 0) {
      if (!projectRepository) throw new Error('No project is open')
      emit('project:changed', await projectRepository.commit({ cues: structuredClone(cues) }))
      emit('takes:durations', applied)
    }
    return { updated: applied.length }
  })

  typedHandle('stems:isolate', async (cueId, wav) => {
    const id = z.string().min(1).max(200).parse(cueId)
    const bytes = wavBytes(wav)
    const project = requireProject()
    const cue = project.cues.find((c) => c.id === id)
    if (!cue) throw new Error('Cue not found')
    const isolated = await eleven.audioIsolation({ audio: bytes, filename: `${id}.wav` })
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
    const voicePath = await store.writeStemFile(id, 'voice.wav', voice)
    const restPath = await store.writeStemFile(id, 'rest.wav', rest)
    const stems: Stem[] = [
      {
        id: `${id}-voice`,
        name: 'Voice',
        file: { fileId: `${id}/voice.wav`, relPath: voicePath, format: 'wav' },
        exportMode: 'off',
      },
      {
        id: `${id}-rest`,
        name: 'Music & SFX',
        file: { fileId: `${id}/rest.wav`, relPath: restPath, format: 'wav' },
        exportMode: 'on',
        duckDb: 0,
      },
    ]
    return stemsSchema.parse(stems) as Stem[]
  })

  typedHandle('provider:tts', async (req) => {
    const parsed = ttsSchema.parse(req)
    const project = requireProject()
    const cue = project.cues.find((c) => c.id === parsed.cueId)
    if (!cue) throw new Error('Cue not found')
    const character = project.characters.find((c) => c.id === cue.characterId)
    if (!character) throw new Error('Cue has no character assigned')
    if (!character.provider.voiceId) {
      throw new Error(`No voice configured for character "${character.name}"`)
    }
    const voiceId = character.provider.voiceId
    const processed = applyRules(parsed.text, project.pronunciationRules)
    const mode = project.provider?.tts
    const projectModel = mode?.model ?? character.provider.ttsModel
    const model = parsed.model ?? projectModel
    const { audio, words } = await eleven.ttsWithTimestamps({
      text: processed,
      voiceId,
      model,
      ...(mode?.language && model === projectModel && model !== NO_LANGUAGE_CODE_MODEL
        ? { language: mode.language }
        : {}),
      settings: parsed.voiceSettings,
    })
    const fileName = `t_${stamp()}_tts.mp3`
    const { cue: target, abs } = await writeGuardedTake(parsed.cueId, character.id, voiceId, fileName, audio)
    const take: Take = {
      id: randomUUID(),
      kind: 'tts',
      createdAt: new Date().toISOString(),
      file: { fileId: `${target.id}/${fileName}`, relPath: abs, format: 'mp3' },
      duration: 0,
      meta: { text: processed, voiceSettings: parsed.voiceSettings, provider: 'elevenlabs', model },
      edits: emptyEdits(),
      ...(words ? { words } : {}),
      ...(parsed.fragment ? { fragment: true as const } : {}),
    }
    target.takes.push(take)
    if (autoSelectsOutput(parsed, false)) {
      Object.assign(target, changeTakeOutput(target, take.id, project))
    }
    await publishCue(target)
    pushUsage()
    return take
  })

  typedHandle('provider:sts', async (req) => {
    const parsed = stsSchema.parse(req)
    const project = requireProject()
    const cue = project.cues.find((c) => c.id === parsed.cueId)
    if (!cue) throw new Error('Cue not found')
    const source = cue.takes.find((t) => t.id === parsed.sourceTakeId)
    if (!source) throw new Error('Source recording not found in this cue')
    if (source.kind !== 'recording') {
      throw new Error('Only a raw voice recording can be converted (take kind "recording")')
    }
    if (source.duration > MAX_STS_SECONDS) {
      throw new Error(
        `Recording is ${source.duration.toFixed(1)}s — ElevenLabs accepts at most ${MAX_STS_SECONDS / 60} min per request`
      )
    }

    const character = project.characters.find((c) => c.id === cue.characterId)
    if (!character) throw new Error('Cue has no character assigned')
    if (!character.provider.voiceId) {
      throw new Error(`No voice configured for character "${character.name}"`)
    }

    const audio = await fs.readFile(source.file.relPath)
    const model = project.provider?.sts?.model ?? character.provider.stsModel
    const voiceId = character.provider.voiceId
    const mp3 = await eleven.sts({
      audio,
      filename: path.basename(source.file.relPath),
      voiceId,
      model,
      settings: parsed.voiceSettings,
    })

    const fileName = `t_${stamp()}_sts.mp3`
    const { cue: target, abs } = await writeGuardedTake(parsed.cueId, character.id, voiceId, fileName, mp3)
    const take: Take = {
      id: randomUUID(),
      kind: 'sts',
      createdAt: new Date().toISOString(),
      file: { fileId: `${target.id}/${fileName}`, relPath: abs, format: 'mp3' },
      duration: source.duration,
      meta: {
        text: target.text,
        voiceSettings: parsed.voiceSettings,
        sourceTakeId: source.id,
        provider: 'elevenlabs',
        model,
      },
      edits: emptyEdits(),
      ...(parsed.fragment ? { fragment: true as const } : {}),
    }
    target.takes.push(take)
    if (autoSelectsOutput(parsed, target.status === 'approved')) {
      Object.assign(target, changeTakeOutput(target, take.id, project))
    }
    await publishCue(target)
    pushUsage()
    return take
  })

  typedHandle('provider:transcribe', async (req) => {
    const parsed = transcribeSchema.parse(req)
    const repository = projectRepository
    if (!repository) throw new Error('No project is open')
    const project = repository.projectForMain()
    const changed: Cue[] = []
    let skipped = 0
    for (const cueId of parsed.cueIds) {
      const cue = project.cues.find((c) => c.id === cueId)
      const ref = cue?.referenceAudio
      if (!cue || !ref || (!parsed.overwrite && cue.sourceText.trim())) {
        skipped++
        continue
      }
      const text = await eleven.stt({
        audio: await fs.readFile(ref.relPath),
        filename: path.basename(ref.relPath),
      })
      if (!text) {
        skipped++
        continue
      }
      Object.assign(cue, changeCueSourceText(cue, text, project))
      changed.push(cue)
    }
    if (changed.length > 0) {
      emit('project:changed', await repository.commit({ cues: structuredClone(changed) }))
    }
    pushUsage()
    return { updated: changed.length, skipped }
  })

  typedHandle('provider:voices', () => eleven.voices())
  typedHandle('provider:models', () => eleven.models())

  typedHandle('provider:testVoice', async (characterId: string) => {
    const id = z.string().min(1).max(200).parse(characterId)
    const project = requireProject()
    const character = project.characters.find((c) => c.id === id)
    if (!character) throw new Error('Character not found')
    if (!character.provider.voiceId) {
      throw new Error(`No voice configured for character "${character.name}"`)
    }
    return singleFlight(testVoiceInFlight, id, `Voice test already running for "${character.name}"`, async () => {
      const audio = await eleven.tts({
        text: TEST_VOICE_TEXT,
        voiceId: character.provider.voiceId,
        model: character.provider.ttsModel,
        settings: character.voiceSettings,
      })
      pushUsage()
      return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer
    })
  })

  typedHandle('provider:usage', () => eleven.usage())
  typedHandle('provider:setApiKey', (k: string) => setApiKey(k))
  typedHandle('provider:hasApiKey', () => hasApiKey())

  typedHandle('migration:dryRun', () => migration.dryRun())
  typedHandle('migration:apply', async () => {
    const result = await migration.apply()
    if ((result.adoptedNormal > 0 || result.adoptedComposite > 0) && projectRepository) {
      emit('project:changed', await projectRepository.commit({ cues: requireProject().cues }))
    }
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

  typedHandle('export:planBatch', async (req) => planBatchExport(batchExportSchema.parse(req)))
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
  typedHandle('export:finish', async (token, summary) => {
    const parsed = exportSummarySchema.parse(summary)
    const version = parsed.exported.length > 0 ? await stampVersion() : undefined
    return finishExport(z.string().uuid().parse(token), parsed, version)
  })

  typedHandle('export:videoPlan', (sourceId: string) =>
    planVideoExport(z.string().min(1).max(200).parse(sourceId))
  )
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
  })
  typedHandle('updater:getStatus', async () => getUpdateStatus())
  typedHandle('updater:check', () => checkForUpdates())
  typedHandle('updater:restart', async () => restartToUpdate())
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

void app.whenReady().then(() => {
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void flushPersist().then(
    () => app.quit(),
    () => app.quit()
  )
})

void app.whenReady().then(async () => {
  try {
    await runFfmpeg(['-version'])
  } catch (e) {
    console.error('FFMPEG BROKEN:', e)
  }
})
