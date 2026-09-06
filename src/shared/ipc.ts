import type {
  ClipEdits,
  CompTrack,
  MatchRule,
  ProjectVersion,
  Take,
  UsageInfo,
  VoiceSettings,
  UiSessionState,
} from './domain'
import type { TableMapping } from './import-table'
import type { CompPlan, ExportFormat } from './export-plan'
import type { ExportedLines } from './readiness'
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
  selectOutput?: boolean
}

export interface StsRequest {
  cueId: string
  sourceTakeId: string
  voiceSettings: VoiceSettings
  fragment?: boolean
  selectOutput?: boolean
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

export interface BatchExportRequest {
  cueIds: string[]
}

export interface BatchExportFailure {
  cueKey: string
  name: string
  error: string
}

export interface BatchExportResult {
  written: number
  failed: BatchExportFailure[]
  outDir: string
  indexPath?: string
  reportPath?: string
  version?: number
}

export interface ExportSummary {
  exported: { cueKey: string; name: string; bytes: number; sha256: string }[]
  failed: { cueKey: string; name: string; reason: string }[]
}

export interface LastExport {
  createdAt: string
  version?: number
  exported: number
  failed: number
  cueIds: string[]
  lines: ExportedLines
}

export interface ExportInfo {
  outDir: string
  writesIndex: boolean
  last: LastExport | null
}

export interface DeliverPaths {
  indexPath?: string
  reportPath: string
  version?: number
}

export interface ExportJob {
  cueId: string
  cueKey: string
  takeId: string
  name: string
  outPath: string
  srcPath: string
  format: ExportFormat
  formatArgs: string[]
  fastPath: boolean
  hasEdits: boolean
  edits: ClipEdits
  matchLoudnessRef?: string
  compPlan?: CompPlan
}

export interface ExportPlan {
  token: string
  jobs: ExportJob[]
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

export interface ReimportResult {
  added: number
  updated: number
  untouched: number
  orphaned: number
  warnings: TemplateIssue[]
}

export interface SuggestionsLoadResult {
  loaded: number
  skipped: number
}

export interface AudioImportResult {
  added: number
  updated: number
  files: number
}

export interface TableImportResult {
  path: string
  name: string
  headers: string[]
  mapping: TableMapping
  rows: number
  matched: number
  unmatched: number
}

export interface TranscribeResult {
  updated: number
  skipped: number
}

export interface ProviderVoice {
  id: string
  name: string
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
  'import:pick': (kind: 'files' | 'folder' | 'table') => Promise<string[]>
  'import:audio': (req: { paths: string[]; rule: MatchRule }) => Promise<AudioImportResult>
  'import:table': (req: {
    path: string
    rule: MatchRule
    mapping?: TableMapping
    replaceTranslations?: boolean
  }) => Promise<TableImportResult>
  'import:template': (dir: string) => Promise<ReimportResult>
  'project:command': (command: ProjectCommand) => Promise<CommandResult>
  'project:saveVersion': (req: { name?: string }) => Promise<ProjectVersion[]>
  'ui:save': (ui: UiSessionState) => Promise<void>

  'suggestions:load': () => Promise<SuggestionsLoadResult>

  'rules:get': () => Promise<string>

  'audio:readRef': (absPath: string) => Promise<ArrayBuffer>

  'shell:reveal': (absPath: string) => Promise<void>

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
  'provider:transcribe': (req: { cueIds: string[]; overwrite?: boolean }) => Promise<TranscribeResult>
  'provider:voices': () => Promise<ProviderVoice[]>
  'provider:testVoice': (characterId: string) => Promise<ArrayBuffer>
  'provider:usage': () => Promise<UsageInfo | null>
  'provider:setApiKey': (key: string) => Promise<void>
  'provider:hasApiKey': () => Promise<boolean>

  'migration:dryRun': () => Promise<MigrationReport>
  'migration:apply': () => Promise<{ adoptedNormal: number; adoptedComposite: number }>

  'csv:preview': (path: string) => Promise<CsvPreview>
  'csv:sync': () => Promise<CsvSyncResult>

  'export:planBatch': (req: BatchExportRequest) => Promise<ExportPlan>
  'export:info': () => Promise<ExportInfo>
  'export:pickDir': () => Promise<string | null>
  'export:copy': (outPath: string) => Promise<ExportResult>
  'export:encode': (outPath: string, wav: ArrayBuffer) => Promise<ExportResult>
  'export:finish': (token: string, summary: ExportSummary) => Promise<DeliverPaths>

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
