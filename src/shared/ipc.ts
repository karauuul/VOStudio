import type {
  ClipEdits,
  Take,
  UsageInfo,
  VoiceSettings,
  UiSessionState,
} from './domain'
import type { ExportFormat } from './export-plan'
import type { UpdateStatus } from './updater'
import type { CommandResult, ProjectCommand, ProjectSnapshot } from './project-commands'
import type { ProjectSummary } from './project-summary'

export interface CsvPreview {
  headers: string[]
  rows: string[][]
}

export interface TtsRequest {
  cueId: string
  text: string
  voiceSettings: VoiceSettings
  fragment?: boolean
}

export interface StsRequest {
  cueId: string
  sourceTakeId: string
  voiceSettings: VoiceSettings
  fragment?: boolean
}

export interface AppSettings {
  micDeviceId?: string
  countIn: boolean
  autoReference: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  countIn: true,
  autoReference: false,
}

export interface ExportResult {
  outPath: string
  bytes: number
  parityHash: string
}

export interface MigrationEntry {
  file: string
  sha256: string
  kind: 'normal' | 'segment' | 'manifest'
  cueKey?: string
  eventName?: string
  note?: string
}

export interface MigrationReport {
  normal: MigrationEntry[]
  composite: { eventName: string; manifest: string; segments: MigrationEntry[] }[]
  orphans: MigrationEntry[]
  ambiguous: MigrationEntry[]
  totalFiles: number
}

export interface CsvSyncResult {
  changedCells: number
  path: string
}

export interface BatchExportCollision {
  name: string
  cueKeys: string[]
}

export interface BatchExportRequest {
  scope: 'approved' | 'all-final'
  collisionStrategy?: Record<string, 'suffix-wemid' | 'skip' | 'reuse'>
  outDir?: string
}

export interface BatchExportFailure {
  cueKey: string
  name: string
  error: string
}

export interface BatchExportResult {
  written: number
  skipped: number
  failed: BatchExportFailure[]
  collisions: BatchExportCollision[]
  outDir: string
  indexPath?: string
  reportPath?: string
}

export interface ExportSummary {
  exported: { cueKey: string; name: string; bytes: number; sha256: string }[]
  failed: { cueKey: string; name: string; reason: string }[]
}

export interface DeliverPaths {
  indexPath?: string
  reportPath: string
}

export interface ExportCompClip {
  srcPath: string
  srcIn: number
  srcOut: number
  start: number
  edits: ClipEdits
  crossfade?: number
}

export interface ExportJob {
  cueId: string
  cueKey: string
  takeId: string
  name: string
  outPath: string
  srcPath: string
  format: ExportFormat
  fastPath: boolean
  hasEdits: boolean
  edits: ClipEdits
  comp?: ExportCompClip[]
  compRegion?: { in: number; out: number }
}

export interface ExportPlan {
  jobs: ExportJob[]
  collisions: BatchExportCollision[]
  skipped: number
  outDir: string
}

export interface TemplateMeta {
  formatVersion: number
  name: string
  sourceLang: string
  targetLang: string
}

export interface TemplateIssue {
  row: number | null
  reason: string
}

export interface TemplatePreviewRow {
  cueId: string
  character: string
  sourceText: string
  translation: string
  refAudio: string
  exportName: string
  status: string
  missingAudio: boolean
}

export interface TemplatePreview {
  dir: string
  meta: TemplateMeta | null
  firstRows: TemplatePreviewRow[]
  totalCues: number
  characters: string[]
  terms: number
  warnings: TemplateIssue[]
  fatalErrors: TemplateIssue[]
}

export interface TemplateImportResult {
  snapshot: ProjectSnapshot
  warnings: TemplateIssue[]
}

export interface SuggestionsLoadResult {
  loaded: number
  skipped: number
}

export interface TakeDurationUpdate {
  cueId: string
  takeId: string
  duration: number
}

export interface IpcApi {
  'project:list': () => Promise<ProjectSummary[]>
  'project:open': (dir: string) => Promise<ProjectSnapshot>
  'project:create': (name: string) => Promise<ProjectSnapshot>
  'project:delete': (dir: string) => Promise<void>
  'project:close': () => Promise<void>
  'project:pickTemplate': () => Promise<TemplatePreview | null>
  'project:importTemplate': (dir: string) => Promise<TemplateImportResult>
  'project:command': (command: ProjectCommand) => Promise<CommandResult>
  'ui:save': (ui: UiSessionState) => Promise<void>

  'suggestions:load': () => Promise<SuggestionsLoadResult>

  'rules:get': () => Promise<string>
  'rules:preview': (text: string) => Promise<string>

  'audio:readRef': (absPath: string) => Promise<ArrayBuffer>

  'take:saveRecording': (
    cueId: string,
    wav: ArrayBuffer,
    durationSec: number,
    sampleRate: number,
    fragment?: boolean
  ) => Promise<Take>

  'take:setDurations': (items: TakeDurationUpdate[]) => Promise<{ updated: number }>

  'provider:tts': (req: TtsRequest) => Promise<Take>
  'provider:sts': (req: StsRequest) => Promise<Take>
  'provider:testVoice': (characterId: string) => Promise<ArrayBuffer>
  'provider:usage': () => Promise<UsageInfo | null>
  'provider:setApiKey': (key: string) => Promise<void>
  'provider:hasApiKey': () => Promise<boolean>

  'migration:dryRun': () => Promise<MigrationReport>
  'migration:apply': () => Promise<{ adoptedNormal: number; adoptedComposite: number }>

  'csv:preview': (path: string) => Promise<CsvPreview>
  'csv:sync': () => Promise<CsvSyncResult>

  'export:planCue': (cueId: string) => Promise<ExportPlan>
  'export:planBatch': (req: BatchExportRequest) => Promise<ExportPlan>
  'export:copy': (outPath: string) => Promise<ExportResult>
  'export:encode': (outPath: string, wav: ArrayBuffer) => Promise<ExportResult>
  'export:finish': (outDir: string, summary: ExportSummary) => Promise<DeliverPaths>

  'settings:get': () => Promise<AppSettings>
  'settings:set': (settings: AppSettings) => Promise<void>
  'updater:getStatus': () => Promise<UpdateStatus>
  'updater:check': () => Promise<UpdateStatus>
  'updater:restart': () => Promise<void>
}

export type IpcChannel = keyof IpcApi

export interface IpcEvents {
  'usage:updated': UsageInfo | null
  'takes:durations': TakeDurationUpdate[]
  'project:changed': CommandResult
  'updater:status': UpdateStatus
}

export type EventChannel = keyof IpcEvents
