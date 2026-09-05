import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron'
import path from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { typedHandle } from './typed-ipc'
import {
  autoSelectsOutput,
  exportSummarySchema,
  projectCommandSchema,
  projectDirSchema,
  projectNameSchema,
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
import { changeTakeOutput } from '@shared/approval'
import {
  cueVoiceUnchanged,
  emptyEdits,
  singleFlight,
  liveTakes,
  MAX_STS_SECONDS,
  type Cue,
  type Take,
  type UiSessionState,
} from '@shared/domain'
import type { Project } from '@shared/domain'
import type { AppSettings, TakeDurationUpdate } from '@shared/ipc'
import {
  createProjectFromTemplate,
  reimportBlockers,
  reimportTemplate,
  summarizeDiff,
  toPreview,
  validateTemplate,
} from './template-import'
import { diffTemplate } from '@shared/template-reimport'
import * as migration from './migration'
import { GENERATED_DIR } from './migration'
import { syncCsv } from './csv-sync'
import {
  copyJob,
  encodeJob,
  finishExport,
  planBatchExport,
  planCueExport,
  preflightExport,
} from './export'
import { applyAlienMigration } from './satisfactory-preset'
import { checkForUpdates, getUpdateStatus, initializeUpdater, restartToUpdate } from './updater'
import { SerialProjectRepository } from './project-repository'
import { setupImportedProject, setupOpenedProject } from './project-import'
import { normalizePath, PROJECT_SUFFIX } from '@shared/project-summary'

protocol.registerSchemesAsPrivileged([
  { scheme: 'vostudio', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
])

const REFERENCE_DIR_ENV = process.env['VOSTUDIO_REFERENCE_DIR']

function isAllowedPath(abs: string): boolean {
  const roots = [store.getProjectDir(), REFERENCE_DIR_ENV, GENERATED_DIR].filter(Boolean) as string[]
  const norm = path.resolve(abs)
  return roots.some((r) => norm.toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'VO Studio',
    backgroundColor: '#141416',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const TEST_VOICE_TEXT = 'Voice test, one two three.'
const testVoiceInFlight = new Set<string>()

const MAX_RECORDING_BYTES = 100 * 1024 * 1024

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

const batchExportSchema = z.object({
  scope: z.enum(['approved', 'all-final']),
  collisionStrategy: z.record(z.enum(['suffix-wemid', 'skip', 'reuse'])).optional(),
})

const settingsSchema = z.object({
  micDeviceId: z.string().max(500).optional(),
  countIn: z.boolean(),
  autoReference: z.boolean(),
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

  typedHandle('project:previewReimport', async (dir: string) => {
    const target = pickedTemplateDir(dir)
    const project = requireProject()
    const validation = await validateTemplate(target, true)
    return {
      preview: { ...toPreview(validation), fatalErrors: reimportBlockers(validation, project) },
      diff: summarizeDiff(diffTemplate(project, validation.rows)),
    }
  })

  typedHandle('project:applyReimport', (dir: string) =>
    serialLifecycle(async () => {
      const target = pickedTemplateDir(dir)
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

  typedHandle('rules:preview', async (text: string) => {
    const project = store.getProject()
    return applyRules(text, project?.pronunciationRules ?? '')
  })

  typedHandle('audio:readRef', async (absPath: string) => {
    if (!isAllowedPath(absPath)) throw new Error('Path is outside the allowlist')
    const buf = await fs.readFile(absPath)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  })

  typedHandle('take:saveRecording', async (cueId, wav, durationSec, sampleRate, fragment) => {
    const parsed = recordingSchema.parse({ cueId, durationSec, sampleRate, fragment })
    const bytes =
      wav instanceof ArrayBuffer
        ? Buffer.from(wav)
        : ArrayBuffer.isView(wav)
          ? Buffer.from((wav as ArrayBufferView).buffer as ArrayBuffer)
          : null
    if (!bytes) throw new Error('Expected an ArrayBuffer with WAV data')
    if (bytes.length === 0) throw new Error('Empty recording')
    if (bytes.length > MAX_RECORDING_BYTES) {
      throw new Error(`Recording is too large: ${(bytes.length / 1024 / 1024).toFixed(1)} MB`)
    }

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
      meta: {},
      edits: emptyEdits(),
      ...(parsed.fragment ? { fragment: true as const } : {}),
    }
    cue.takes.push(take)
    await publishCue(cue)
    return take
  })

  typedHandle('take:setDurations', async (items) => {
    const parsed = durationsSchema.parse(items)
    const project = requireProject()
    const byCue = new Map(project.cues.map((c) => [c.id, c]))
    const applied: TakeDurationUpdate[] = []
    for (const it of parsed) {
      if (!(it.duration > 0)) continue
      const take = byCue.get(it.cueId)?.takes.find((t) => t.id === it.takeId)
      if (!take || Math.abs(take.duration - it.duration) < 0.005) continue
      take.duration = it.duration
      applied.push(it)
    }
    if (applied.length > 0) {
      if (!projectRepository) throw new Error('No project is open')
      emit('project:changed', await projectRepository.commit({ cues: [...new Set(applied.map((item) => item.cueId))].map((id) => byCue.get(id)!) }))
      emit('takes:durations', applied)
    }
    return { updated: applied.length }
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
    const audio = await eleven.tts({
      text: processed,
      voiceId,
      model: character.provider.ttsModel,
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
      meta: { text: processed, voiceSettings: parsed.voiceSettings, provider: 'elevenlabs' },
      edits: emptyEdits(),
      ...(parsed.fragment ? { fragment: true as const } : {}),
    }
    target.takes.push(take)
    if (autoSelectsOutput(parsed, false)) {
      Object.assign(target, changeTakeOutput(target, take.id))
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
    const model = character.provider.stsModel
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
      Object.assign(target, changeTakeOutput(target, take.id))
    }
    await publishCue(target)
    pushUsage()
    return take
  })

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

  typedHandle('export:planCue', async (cueId: string) => planCueExport(z.string().min(1).parse(cueId)))
  typedHandle('export:planBatch', async (req) => planBatchExport(batchExportSchema.parse(req)))
  typedHandle('export:preflight', async (req) => preflightExport(batchExportSchema.parse(req)))
  typedHandle('export:copy', (outPath: string) => copyJob(z.string().min(1).parse(outPath)))
  typedHandle('export:encode', (outPath, wav) => encodeJob(z.string().min(1).parse(outPath), wav))
  typedHandle('export:finish', (token, summary) =>
    finishExport(z.string().uuid().parse(token), exportSummarySchema.parse(summary))
  )

  typedHandle('settings:get', () => store.getSettings())
  typedHandle('settings:set', async (s: AppSettings) => {
    await store.setSettings(settingsSchema.parse(s))
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

    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range')?.trim() ?? '')
    if (!m) {
      const body = await fs.readFile(abs)
      return new Response(new Uint8Array(body), {
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

    const fh = await fs.open(abs, 'r')
    try {
      const buf = Buffer.allocUnsafe(end - start + 1)
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      return new Response(new Uint8Array(buf.subarray(0, bytesRead)), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(bytesRead),
          'Content-Range': `bytes ${start}-${start + bytesRead - 1}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    } finally {
      await fh.close()
    }
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media')
  })

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
