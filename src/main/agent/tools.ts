import { randomUUID } from 'crypto'
import path from 'path'
import { z } from 'zod/v4'
import type { Cue, ProjectAsset, ProjectVersion, Term } from '@shared/domain'
import { ASSET_KINDS, PROPOSAL_REASON_MAX, resolveVoiceSettings, speakerCharacters, TERM_TEXT_MAX, TERMS_MAX } from '@shared/domain'
import { clampVoiceSettings } from '@shared/generation'
import { LINE_TEXT_MAX } from '@shared/lines'
import { defineTool, errorText, issueText, type McpTool, type ToolAnnotations, type ToolOutput } from '@shared/mcp'
import {
  audioWithinRoots,
  type CommandResult,
  type FieldStep,
  type ProjectCommand,
  type ProposalItem,
  type ProposalRef,
} from '@shared/project-commands'
import type { ProjectSummary } from '@shared/project-summary'
import type {
  AssetAddResult,
  AudioImportResult,
  BatchExportResult,
  ExportInfo,
  ReimportResult,
  TableImportResult,
  TablePreview,
  TableRequest,
  TemplateIssue,
} from '@shared/ipc'
import type { MatchRule } from '@shared/domain'
import { DEFAULT_MATCH_RULE, TABLE_COLUMNS_MAX } from '@shared/import-table'
import { ALL_CHARACTERS, filterCues } from '@shared/cue-filter'
import { requireRevision, transcriptMatch } from '@shared/agent-render'
import type { AudioMetrics } from '@shared/audio-metrics'
import { findCollisions, originalLength, planBatch } from '@shared/export-plan'
import { readinessRows, statusWords, summarize } from '@shared/readiness'
import { glossaryIssues, removeTerms, TEXT_MATCH_MIN, translationContext, upsertTerms, type TextMatchReport } from '@shared/agent-text'
import {
  assetLinks,
  buildRowLines,
  linkPlan,
  linkRows,
  listProposals,
  rowColumns,
  type ProposalEntry,
  type RowColumns,
  type RowMapping,
} from '@shared/linking'
import { MAX_PICKED_FILES, type AssetTable } from '@shared/asset-readers'
import {
  cursorOffset,
  findAsset,
  findCharacter,
  findLine,
  LINE_FILTERS,
  LINES_PAGE_MAX,
  lineDetail,
  listLines,
  offsetPage,
  projectOverview,
  stablePage,
} from '@shared/agent-lines'
import type { SerialProjectRepository } from '../project-repository'
import { isTable, type AssetContent, type AssetReadOptions, type AudioLinesResult } from '../assets'
import type { VoiceProvider } from '../providers/voice-provider'
import { projectCommandSchema } from '../schemas'
import type { DiagnosticEntry } from './diagnostics'

export type RenderSource = 'output' | 'original'

export interface LineRender {
  path: string
  name: string
  metrics: AudioMetrics
}

export interface AgentDeps {
  version: string
  repository: () => SerialProjectRepository | null
  projectDir: () => string | null
  listProjects: () => Promise<ProjectSummary[]>
  openProject: (dir: string) => Promise<unknown>
  createProject: (name: string) => Promise<unknown>
  importTemplate: (dir: string) => Promise<{ warnings: TemplateIssue[] }>
  closeProject: () => Promise<unknown>
  saveVersion: (name?: string) => Promise<ProjectVersion[]>
  restoreVersion: (n: number) => Promise<unknown>
  flushUi: () => Promise<void>
  checkRemovable: (cueIds: string[]) => Promise<void>
  emit: (result: CommandResult) => void
  audioRoots: () => string[]
  importAudio: (req: { paths: string[]; rule: MatchRule }, expected?: SerialProjectRepository) => Promise<AudioImportResult>
  previewTable: (req: TableRequest, expected?: SerialProjectRepository) => Promise<TablePreview>
  importTable: (req: TableRequest, expected?: SerialProjectRepository) => Promise<TableImportResult>
  reimportTemplate: (dir: string, expected?: SerialProjectRepository) => Promise<ReimportResult>
  transcribe: (req: { cueIds: string[]; overwrite?: boolean }, expected?: SerialProjectRepository) => Promise<{ updated: number; skipped: number }>
  renderLine: (cueId: string, source: RenderSource, expected?: SerialProjectRepository) => Promise<LineRender | null>
  exportInfo: () => Promise<ExportInfo>
  exportLines: (cueIds: string[], expected?: SerialProjectRepository) => Promise<BatchExportResult>
  transcribeFile: (file: string) => Promise<string>
  addAssets: (paths: string[], expected?: SerialProjectRepository) => Promise<AssetAddResult>
  loadAsset: (asset: ProjectAsset, options: AssetReadOptions) => Promise<AssetContent>
  buildAudioLines: (assetIds: string[], expected?: SerialProjectRepository) => Promise<AudioLinesResult>
  provider: () => VoiceProvider
  diagnostics: () => DiagnosticEntry[]
  screenshot: () => Promise<Buffer | null>
}

export const AGENT_INSTRUCTIONS = [
  'VO Studio is a live desktop app; the user may be working in it while you do.',
  'Call status first to see the open project and the line the user is on.',
  'Address lines by key, or by id when a key is ambiguous; lines paginates, so follow nextCursor.',
  'Nothing here deletes audio: takes stay on disk and a version named "Before agent" is saved before your first change to a project.',
  'Recommended flow for raw files: asset_add (files or folders land in the bin as they are), assets and asset_read to learn each format, lines_build (perFile for audio, a column mapping for tables, subtitles, text and JSON) or link to attach text to existing lines, transcribe when there are no subtitles, characters_assign, proposals to review, then translate_context, translations_suggest and glossary.',
  'File names are hints, never truth: anything inferred is stored as a proposal with confidence and reason for the user to accept or reject; asset rows are numbered from 0.',
  'An older path still works: import (audio folder, subtitle table, template).',
  'Voice generation costs money and is not available through these tools yet.',
  'Check lines with render (exact export audio and its metrics) or verify (speech-to-text against the line text, costs money) before export; call export with dryRun first to see readiness and file names.',
  'Use screenshot and diagnostics to check what the user sees.',
].join(' ')

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const DESTRUCTIVE: ToolAnnotations = { ...WRITE, destructiveHint: true }

const lineRef = z.string().min(1).max(200)
const characterRef = z.string().min(1).max(200)
const lineText = z.string().max(LINE_TEXT_MAX)
const characterName = z.string().min(1).max(120)
const modelId = z.string().min(1).max(120)
const unit = z.number().min(0).max(1)

const absolutePath = z.string().min(1).max(4096).refine((p) => path.isAbsolute(p), { message: 'must be an absolute path' })
const columnIndex = z.number().int().min(0).max(TABLE_COLUMNS_MAX - 1)
const pageCursor = z.string().max(20)
const lineSelection = {
  lines: z.array(lineRef).min(1).max(500).optional(),
  filter: z.enum(LINE_FILTERS).optional(),
}
const oneSelection = (a: { lines?: unknown; filter?: unknown }): boolean => a.lines === undefined || a.filter === undefined
const oneSelectionMessage = { message: 'pass lines or filter, not both' }
const termRow = z.object({
  term: z.string().min(1).max(TERM_TEXT_MAX),
  translation: z.string().min(1).max(TERM_TEXT_MAX),
  note: z.string().max(TERM_TEXT_MAX).optional(),
  proposed: z.literal(true).optional(),
})
const assetRef = z.string().min(1).max(4096)
const columnRef = z.union([columnIndex, z.string().min(1).max(1000)])
const rowMapping = z
  .object({ key: columnRef, text: columnRef, translation: columnRef, character: columnRef, start: columnRef, end: columnRef })
  .partial()
const assetShape = {
  jsonPath: z.string().min(1).max(1000).optional(),
  fields: z.array(z.string().max(1000)).min(1).max(200).optional(),
}
const confidence = z.number().min(0).max(1)
const reasonText = z.string().max(PROPOSAL_REASON_MAX)
const cueProposalKind = z.enum(['character', 'link', 'text'])
const proposalKind = z.enum(['character', 'link', 'text', 'term'])
const proposalItem = z.union([
  z.object({ kind: cueProposalKind, line: lineRef }),
  z.object({ kind: z.literal('term'), term: z.string().min(1).max(TERM_TEXT_MAX) }),
])

export const TRANSCRIBE_PAGE_MAX = 500
export const CONTEXT_PAGE_MAX = 50
export const REPORT_LIST_MAX = 100
export const EXPORT_PAGE_MAX = 200
export const ASSET_READ_MAX = 200
export const ASSETS_PAGE_MAX = 500
export const PROPOSALS_PAGE_MAX = 200
export const CELL_MAX = 500
export const ASSIGN_MAX = 2000

const PROJECT_SWITCHED = 'The project was closed or switched during this call; call status, then retry.'

const exactlyOne = (values: unknown[]): boolean => values.filter((v) => v !== undefined).length === 1

const structured = (value: Record<string, unknown>): ToolOutput => ({ structured: value })

function selectLines(deps: AgentDeps, args: { lines?: string[]; filter?: string }): Cue[] {
  const project = requireRepository(deps).projectForMain()
  if (args.lines) return [...new Map(args.lines.map((ref) => findLine(project, ref)).map((cue) => [cue.id, cue])).values()]
  return filterCues(project.cues, args.filter ?? 'all', '', ALL_CHARACTERS)
}

function textMatchView(report: TextMatchReport | undefined): Record<string, unknown> {
  if (!report) return {}
  return {
    textMatch: {
      matched: report.matched.length,
      ambiguous: report.ambiguous.length,
      unmatched: report.unmatched.length,
      pairs: report.matched.slice(0, REPORT_LIST_MAX).map((m) => ({ row: m.index + 1, line: m.key, score: m.score })),
      ambiguousRows: report.ambiguous.slice(0, REPORT_LIST_MAX).map((a) => ({ row: a.index + 1, candidates: a.candidates })),
      unmatchedRows: report.unmatched.slice(0, REPORT_LIST_MAX).map((i) => i + 1),
    },
  }
}

const reason = (error: unknown): string => errorText(error).replace(/\.$/, '')

const round3 = (n: number): number => Math.round(n * 1000) / 1000

async function liveCall<T>(repository: SerialProjectRepository, call: () => Promise<T>): Promise<T> {
  try {
    const result = await call()
    if (!repository.isLive()) throw new Error(PROJECT_SWITCHED)
    return result
  } catch (error) {
    throw repository.isLive() ? error : new Error(PROJECT_SWITCHED)
  }
}

interface RenderedLine {
  source: RenderSource
  render: LineRender
  view: Record<string, unknown>
  revision: number
}

async function renderCue(deps: AgentDeps, cue: Cue, withOriginal: boolean): Promise<RenderedLine> {
  const repository = requireRepository(deps)
  const revision = repository.currentRevision()
  const render = (source: RenderSource): Promise<LineRender | null> => liveCall(repository, () => deps.renderLine(cue.id, source, repository))
  const output = await render('output')
  const rendered = output ?? (await render('original'))
  if (!rendered) throw new Error(`Line ${cue.key} has no voiced output and no original audio to render.`)
  const source: RenderSource = output ? 'output' : 'original'
  const original = withOriginal && output ? await render('original') : null
  requireRevision(revision, repository.currentRevision())
  const reference = originalLength(cue) ?? null
  return {
    source,
    revision,
    render: rendered,
    view: {
      line: cue.key,
      source,
      path: rendered.path,
      ...(output ? { exportName: rendered.name } : {}),
      metrics: rendered.metrics,
      referenceDuration: reference,
      durationDiff: reference === null ? null : round3(rendered.metrics.duration - reference),
      ...(original ? { original: { path: original.path, metrics: original.metrics } } : {}),
    },
  }
}

const clip = (text: string, max = CELL_MAX): string => (text.length > max ? `${text.slice(0, max)}… [${text.length} chars]` : text)

async function assetTable(deps: AgentDeps, asset: ProjectAsset, options: AssetReadOptions): Promise<AssetTable> {
  if (asset.kind === 'audio' || asset.kind === 'video') throw new Error(`${asset.name} is ${asset.kind}; build lines from it with strategy perFile.`)
  const content = await deps.loadAsset(asset, options)
  if (isTable(content)) return content
  throw new Error(`${asset.name} reads as plain ${content.format}${asset.kind === 'data' ? '; pass jsonPath to read records' : ''}.`)
}

const columnNames = (table: AssetTable, columns: RowColumns): Record<string, string> =>
  Object.fromEntries(Object.entries(columns).map(([field, at]) => [field, table.columns[at as number]]))

function assetView(asset: ProjectAsset, counts: ReturnType<typeof assetLinks>): Record<string, unknown> {
  const linked = counts.get(asset.id)
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    size: asset.size,
    ...(asset.duration === undefined ? {} : { duration: asset.duration }),
    ...(asset.rows === undefined ? {} : { rows: asset.rows }),
    lines: linked?.lines ?? 0,
    ...(linked?.proposed ? { proposedLinks: linked.proposed } : {}),
  }
}

function proposalView(project: ReturnType<SerialProjectRepository['projectForMain']>, entry: ProposalEntry): Record<string, unknown> {
  if (entry.term) return { kind: 'term', term: entry.term.term, translation: entry.term.translation, ...(entry.term.note ? { note: entry.term.note } : {}) }
  const cue = entry.cue as Cue
  const name = (id: string): string | null => project.characters.find((c) => c.id === id)?.name ?? null
  const base = { kind: entry.kind, line: cue.key, id: cue.id }
  if (entry.kind === 'text') return { ...base, proposed: clip(cue.suggestedText ?? ''), current: clip(cue.text) }
  const scored = { confidence: entry.confidence, reason: entry.reason }
  if (entry.kind === 'character') return { ...base, proposed: name(cue.proposals?.character?.characterId ?? ''), current: name(cue.characterId), ...scored }
  const link = cue.proposals?.link
  const asset = project.assets?.find((a) => a.id === link?.assetId)
  return { ...base, asset: asset?.name ?? link?.assetId, row: link?.row, sourceText: clip(cue.sourceText), ...scored }
}

async function settleTerms(deps: AgentDeps, names: string[], accept: boolean): Promise<string[]> {
  const current = requireRepository(deps).projectForMain().terms ?? []
  const wanted = new Set(names.map((n) => n.trim().toLowerCase()))
  const hit = current.filter((t) => t.proposed && wanted.has(t.term.toLowerCase()))
  if (hit.length === 0) return []
  const chosen = new Set(hit)
  const terms: Term[] = accept
    ? current.map((t) => (chosen.has(t) ? { term: t.term, translation: t.translation, ...(t.note ? { note: t.note } : {}) } : t))
    : current.filter((t) => !chosen.has(t))
  await execute(deps, { type: 'terms.set', terms })
  return hit.map((t) => t.term)
}

function requireRepository(deps: AgentDeps): SerialProjectRepository {
  const repository = deps.repository()
  if (!repository) throw new Error('No project is open; call project_open first.')
  return repository
}

const removedCueIds = (command: ProjectCommand): string[] =>
  command.type === 'cue.delete' ? command.cueIds : command.type === 'table.step' ? command.remove : []

const pin = (deps: AgentDeps): AgentDeps => {
  const repository = requireRepository(deps)
  return { ...deps, repository: () => repository }
}

async function execute(deps: AgentDeps, command: ProjectCommand): Promise<CommandResult> {
  const repository = requireRepository(deps)
  const removed = removedCueIds(command)
  if (removed.length > 0) await deps.checkRemovable(removed)
  const result = await repository.execute(command).catch((error: unknown) => {
    throw repository.isLive() ? error : new Error(PROJECT_SWITCHED)
  })
  deps.emit(result)
  return result
}

const characterView = (c: ReturnType<typeof findCharacter>): Record<string, unknown> => ({
  id: c.id,
  name: c.name,
  providerId: c.provider.providerId,
  voiceId: c.provider.voiceId,
  ttsModel: c.provider.ttsModel,
  stsModel: c.provider.stsModel,
  voiceSettings: c.voiceSettings,
})

function currentOverview(deps: AgentDeps): Record<string, unknown> | null {
  const repository = deps.repository()
  return repository ? projectOverview(repository.projectForMain(), deps.projectDir()) : null
}

async function projectDirByName(deps: AgentDeps, name: string): Promise<string> {
  const wanted = name.trim().toLowerCase()
  const matches = (await deps.listProjects()).filter(
    (p) => p.name.trim().toLowerCase() === wanted || path.basename(p.dir).toLowerCase() === `${wanted}.vostudio`
  )
  if (matches.length === 1) return matches[0].dir
  if (matches.length > 1) throw new Error(`Several projects are named "${name}"; pass dir instead (${matches.map((p) => p.dir).join(', ')}).`)
  throw new Error(`No project is named "${name}"; call projects to list them.`)
}

const editOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), after: lineRef.optional(), text: lineText, character: characterRef.optional() }),
  z.object({ op: z.literal('delete'), line: lineRef }),
  z.object({ op: z.literal('setText'), line: lineRef, text: lineText, ifText: lineText.optional() }),
  z.object({ op: z.literal('setCharacter'), line: lineRef, character: characterRef }),
  z.object({ op: z.literal('exclude'), line: lineRef, excluded: z.boolean() }),
  z.object({ op: z.literal('done'), line: lineRef, done: z.boolean() }),
])

type EditOp = z.output<typeof editOp>

async function applyEdit(deps: AgentDeps, op: EditOp): Promise<{ op: string; line: string; id: string }> {
  const project = requireRepository(deps).projectForMain()
  if (op.op === 'add') {
    const afterCueId = op.after === undefined ? null : findLine(project, op.after).id
    const characterId = op.character === undefined ? undefined : findCharacter(project, op.character).id
    const id = randomUUID()
    const created = await execute(deps, { type: 'cue.create', afterCueId, lines: [{ id, text: op.text }] })
    if (characterId !== undefined) await execute(deps, { type: 'cue.setCharacter', cueId: id, characterId })
    return { op: op.op, line: created.changes.cues?.[0]?.key ?? id, id }
  }
  const cue = findLine(project, op.line)
  const done = { op: op.op, line: cue.key, id: cue.id }
  if (op.op === 'delete') await execute(deps, { type: 'cue.delete', cueIds: [cue.id] })
  else if (op.op === 'setCharacter') {
    await execute(deps, { type: 'cue.setCharacter', cueId: cue.id, characterId: findCharacter(project, op.character).id })
  } else if (op.op === 'exclude') await execute(deps, { type: 'cue.setExcluded', cueId: cue.id, excluded: op.excluded })
  else if (op.op === 'done') await execute(deps, { type: 'cue.approve', cueId: cue.id, approved: op.done })
  else {
    const result = await execute(deps, {
      type: 'cue.saveText',
      cueId: cue.id,
      text: op.text,
      ...(op.ifText === undefined ? {} : { ifText: op.ifText }),
    })
    if (result.changes.cues?.find((c) => c.id === cue.id)?.text !== op.text) {
      throw new Error(`Line ${cue.key} no longer has the ifText you passed; read it again with line and retry`)
    }
  }
  return done
}

export function agentTools(deps: AgentDeps): McpTool[] {
  const tools = [
    defineTool({
      name: 'status',
      title: 'Status',
      description: 'App version, voice provider, whether an API key is stored, the open project summary and the line the user has selected.',
      input: z.object({}),
      annotations: READ,
      async run() {
        const provider = deps.provider()
        const project = deps.repository()?.projectForMain()
        const active = project?.cues.find((c) => c.id === project.ui.activeCueId)
        return structured({
          version: deps.version,
          mode: 'live',
          provider: provider.id,
          hasApiKey: await provider.hasApiKey(),
          project: currentOverview(deps),
          activeLine: active ? active.key : null,
        })
      },
    }),
    defineTool({
      name: 'projects',
      title: 'Projects',
      description: 'Projects in the projects folder, most recently modified first.',
      input: z.object({}),
      annotations: READ,
      async run() {
        const open = deps.projectDir()
        const projects = (await deps.listProjects()).map((p) => ({
          name: p.name,
          dir: p.dir,
          modifiedAt: p.modifiedAt ? new Date(p.modifiedAt).toISOString() : null,
          stats: p.stats,
          open: p.dir === open,
        }))
        return structured({ projects })
      },
    }),
    defineTool({
      name: 'project_open',
      title: 'Open project',
      description: 'Open a project by name or dir, create an empty one, or import a template folder; the app window switches to it. Pass exactly one key.',
      input: z
        .object({
          name: z.string().min(1).max(200).optional(),
          dir: z.string().min(1).max(4096).optional(),
          create: z.string().min(1).max(80).optional(),
          template: z.string().min(1).max(4096).optional(),
        })
        .refine((a) => [a.name, a.dir, a.create, a.template].filter((v) => v !== undefined).length === 1, {
          message: 'pass exactly one of name, dir, create or template',
        }),
      annotations: WRITE,
      async run(_ctx, args) {
        let warnings: TemplateIssue[] = []
        if (args.create !== undefined) await deps.createProject(args.create)
        else if (args.template !== undefined) {
          if (!path.isAbsolute(args.template)) throw new Error('template must be an absolute folder path.')
          warnings = (await deps.importTemplate(args.template)).warnings
        } else {
          const dir = args.dir ?? (await projectDirByName(deps, args.name ?? ''))
          if ((await deps.openProject(dir)) === null) throw new Error(`No project at ${dir}; call projects to list them.`)
        }
        return structured({ project: currentOverview(deps), ...(warnings.length > 0 ? { warnings } : {}) })
      },
    }),
    defineTool({
      name: 'project_close',
      title: 'Close project',
      description: 'Save and close the open project; the app returns to its home screen.',
      input: z.object({}),
      annotations: { ...WRITE, idempotentHint: true },
      async run() {
        await deps.closeProject()
        return structured({ closed: true })
      },
    }),
    defineTool({
      name: 'lines',
      title: 'Lines',
      description: `List lines of the open project, one page at a time (at most ${LINES_PAGE_MAX}). Filters match the app's line filters; character takes a name or id; search matches key, text and source.`,
      input: z.object({
        filter: z.enum(LINE_FILTERS).optional(),
        character: characterRef.optional(),
        search: z.string().max(200).optional(),
        cursor: z.string().max(20).optional(),
        limit: z.number().int().min(1).max(LINES_PAGE_MAX).optional(),
        detail: z.enum(['concise', 'full']).optional(),
      }),
      annotations: READ,
      async run(_ctx, args) {
        return structured(listLines(requireRepository(deps).projectForMain(), args))
      },
    }),
    defineTool({
      name: 'line',
      title: 'Line',
      description: 'One line in full: texts, character, status, takes, timeline clips, output and export readiness.',
      input: z.object({ line: lineRef }),
      annotations: READ,
      async run(_ctx, args) {
        const project = requireRepository(deps).projectForMain()
        return structured(lineDetail(project, findLine(project, args.line)))
      },
    }),
    defineTool({
      name: 'lines_edit',
      title: 'Edit lines',
      description: 'Apply line edits in order: add, delete, setText (optional ifText guard), setCharacter, exclude, done. Stops at the first failing op.',
      input: z.object({ ops: z.array(editOp).min(1).max(500) }),
      annotations: DESTRUCTIVE,
      async run(ctx, args) {
        const pinned = pin(deps)
        const applied: { op: string; line: string; id: string }[] = []
        for (const [i, op] of args.ops.entries()) {
          if (ctx.signal.aborted) break
          try {
            applied.push(await applyEdit(pinned, op))
          } catch (error) {
            const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')
            throw new Error(`Op ${i + 1} (${op.op}) failed after ${applied.length} applied: ${reason}.`)
          }
          ctx.progress(i + 1, args.ops.length)
        }
        return structured({ applied })
      },
    }),
    defineTool({
      name: 'characters',
      title: 'Characters',
      description: 'Characters of the open project with their voice and model settings.',
      input: z.object({}),
      annotations: READ,
      async run() {
        return structured({ characters: requireRepository(deps).projectForMain().characters.map(characterView) })
      },
    }),
    defineTool({
      name: 'character_set',
      title: 'Set character',
      description: 'Change a character (by name or id) or create one: rename, voiceId, ttsModel, stsModel, and voice settings (values are clamped). A new voice invalidates that character\'s voiced outputs.',
      input: z
        .object({
          character: characterRef.optional(),
          create: characterName.optional(),
          rename: characterName.optional(),
          voiceId: z.string().max(200).optional(),
          ttsModel: modelId.optional(),
          stsModel: modelId.optional(),
          settings: z
            .object({ stability: unit, similarity: unit, style: unit, speed: z.number(), boost: z.boolean() })
            .partial()
            .optional(),
        })
        .refine((a) => (a.character === undefined) !== (a.create === undefined), {
          message: 'pass exactly one of character or create',
        }),
      annotations: DESTRUCTIVE,
      async run(_ctx, args) {
        const pinned = pin(deps)
        let id: string
        if (args.create !== undefined) {
          id = randomUUID()
          await execute(pinned, { type: 'character.create', id, name: args.create })
        } else id = findCharacter(requireRepository(pinned).projectForMain(), args.character ?? '').id
        if (args.rename !== undefined) await execute(pinned, { type: 'character.rename', characterId: id, name: args.rename })
        if (args.voiceId !== undefined || args.ttsModel !== undefined || args.stsModel !== undefined) {
          await execute(pinned, {
            type: 'character.setProvider',
            characterId: id,
            ...(args.voiceId === undefined ? {} : { voiceId: args.voiceId }),
            ...(args.ttsModel === undefined ? {} : { ttsModel: args.ttsModel }),
            ...(args.stsModel === undefined ? {} : { stsModel: args.stsModel }),
          })
        }
        if (args.settings !== undefined) {
          const current = findCharacter(requireRepository(pinned).projectForMain(), id)
          const settings = clampVoiceSettings(resolveVoiceSettings(current, { voiceSettingsOverride: args.settings }))
          await execute(pinned, { type: 'character.setVoiceSettings', characterId: id, settings })
        }
        return structured({ character: characterView(findCharacter(requireRepository(pinned).projectForMain(), id)) })
      },
    }),
    defineTool({
      name: 'voices',
      title: 'Voices',
      description: 'Voices and models offered by the active voice provider.',
      input: z.object({}),
      annotations: { ...READ, openWorldHint: true },
      async run() {
        const provider = deps.provider()
        const [voices, models] = await Promise.all([provider.voices(), provider.models()])
        return structured({ provider: provider.id, voices, models })
      },
    }),
    defineTool({
      name: 'versions',
      title: 'Versions',
      description: 'List, save or restore saved versions of the open project. Restore first saves the current state as a version.',
      input: z
        .object({
          action: z.enum(['list', 'save', 'restore']),
          name: z.string().max(200).optional(),
          n: z.number().int().min(1).max(1_000_000).optional(),
        })
        .refine((a) => a.action !== 'restore' || a.n !== undefined, { message: 'restore needs n, a version number from list' }),
      annotations: DESTRUCTIVE,
      writes: (args) => args.action !== 'list',
      async run(_ctx, args) {
        const repository = requireRepository(deps)
        if (args.action === 'save') {
          await deps.flushUi()
          return structured({ versions: await deps.saveVersion(args.name) })
        }
        if (args.action === 'restore') {
          await deps.restoreVersion(args.n ?? 0)
          return structured({ restored: args.n, project: currentOverview(deps) })
        }
        return structured({ versions: repository.projectForMain().versions ?? [] })
      },
    }),
    defineTool({
      name: 'command',
      title: 'Project command',
      description: `Run one raw project command, the same the app sends for every edit. Types: ${projectCommandSchema.options.map((o) => o.shape.type.value).join(', ')}.`,
      input: z.object({ command: z.record(z.string(), z.unknown()) }),
      annotations: DESTRUCTIVE,
      async run(_ctx, args) {
        const parsed = projectCommandSchema.safeParse(args.command)
        if (!parsed.success) throw new Error(issueText(parsed.error.issues).replace('Invalid arguments', 'Invalid command'))
        if (!audioWithinRoots(parsed.data, deps.audioRoots())) throw new Error('The command references audio outside this project.')
        const result = await execute(deps, parsed.data)
        return structured({
          revision: result.revision,
          changed: (result.changes.cues ?? []).map((c) => c.key),
          ...(result.changes.removedCueIds ? { removed: result.changes.removedCueIds } : {}),
        })
      },
    }),
    defineTool({
      name: 'import',
      title: 'Import',
      description:
        'Pass exactly one key. audio: files or folders (nested folders keep their relative folder in the line field "path", used by the {Path} export name token). table: CSV/TSV/XLSX; preview (default true) shows headers, detected mapping and the outcome without changes; matchBy "text" matches rows to existing lines by similarity of the mapped original text column instead of the key and never creates lines. templateReimport: a template folder.',
      input: z
        .object({
          audio: z.object({ paths: z.array(absolutePath).min(1).max(200), rule: z.enum(['id', 'exportName', 'tableId']).optional() }).optional(),
          table: z
            .object({
              path: absolutePath,
              rule: z.enum(['id', 'exportName', 'tableId']).optional(),
              mapping: z
                .object({ id: columnIndex, text: columnIndex, translation: columnIndex, character: columnIndex })
                .partial()
                .optional(),
              matchBy: z.enum(['key', 'text']).optional(),
              replaceTranslations: z.boolean().optional(),
              keepOriginal: z.boolean().optional(),
              preview: z.boolean().optional(),
            })
            .optional(),
          templateReimport: absolutePath.optional(),
        })
        .refine((a) => exactlyOne([a.audio, a.table, a.templateReimport]), {
          message: 'pass exactly one of audio, table or templateReimport',
        }),
      annotations: DESTRUCTIVE,
      writes: (args) => !args.table || args.table.preview === false,
      async run(_ctx, args) {
        const repository = requireRepository(deps)
        await deps.flushUi()
        if (args.audio) {
          return structured({ ...(await deps.importAudio({ paths: args.audio.paths, rule: args.audio.rule ?? DEFAULT_MATCH_RULE }, repository)) })
        }
        if (args.templateReimport !== undefined) return structured({ ...(await deps.reimportTemplate(args.templateReimport, repository)) })
        const table = args.table
        if (!table) throw new Error('pass exactly one of audio, table or templateReimport.')
        const req: TableRequest = {
          path: table.path,
          rule: table.rule ?? DEFAULT_MATCH_RULE,
          ...(table.mapping ? { mapping: table.mapping } : {}),
          ...(table.matchBy ? { matchBy: table.matchBy } : {}),
          ...(table.replaceTranslations === undefined ? {} : { replaceTranslations: table.replaceTranslations }),
          ...(table.keepOriginal === undefined ? {} : { keepOriginal: table.keepOriginal }),
        }
        if (table.preview === false) {
          const done = await deps.importTable(req, repository)
          return structured({ applied: true, rows: done.rows, mapping: done.mapping, summary: done.summary, ...textMatchView(done.textMatch) })
        }
        const preview = await deps.previewTable(req, repository)
        return structured({
          preview: true,
          total: preview.total,
          headers: preview.headers,
          mapping: preview.mapping,
          firstRows: preview.rows.slice(0, 5),
          summary: preview.summary,
          ...textMatchView(preview.textMatch),
        })
      },
    }),
    defineTool({
      name: 'asset_add',
      title: 'Add assets',
      description:
        'Add files or folders (recursive) to the project bin as raw assets without interpreting them. Audio and video stay where they are; other files are copied into the project. Files already in the bin are skipped.',
      input: z.object({ paths: z.array(absolutePath).min(1).max(200) }),
      annotations: WRITE,
      async run(_ctx, args) {
        const result = await deps.addAssets(args.paths, requireRepository(deps))
        const counts = assetLinks(requireRepository(deps).projectForMain().cues)
        return structured({
          added: result.added.length,
          assets: result.added.slice(0, REPORT_LIST_MAX).map((a) => assetView(a, counts)),
          skipped: result.skipped.slice(0, REPORT_LIST_MAX),
          ...(result.skipped.length > REPORT_LIST_MAX ? { skippedTotal: result.skipped.length } : {}),
          ...(result.truncated
            ? { notAdded: { files: result.truncated, reason: `over the ${MAX_PICKED_FILES} file limit per call; add the remaining folders separately` } }
            : {}),
        })
      },
    }),
    defineTool({
      name: 'assets',
      title: 'Assets',
      description: `Assets in the project bin, one page at a time (at most ${ASSETS_PAGE_MAX}), with how many lines were built from or linked to each and how many link proposals are pending. unlinked keeps assets no line comes from yet.`,
      input: z.object({
        kind: z.enum(ASSET_KINDS as [string, ...string[]]).optional(),
        unlinked: z.boolean().optional(),
        cursor: pageCursor.optional(),
        limit: z.number().int().min(1).max(ASSETS_PAGE_MAX).optional(),
      }),
      annotations: READ,
      async run(_ctx, args) {
        const project = requireRepository(deps).projectForMain()
        const counts = assetLinks(project.cues)
        const matched = (project.assets ?? []).filter(
          (a) => (args.kind === undefined || a.kind === args.kind) && (args.unlinked !== true || !(counts.get(a.id)?.lines ?? 0))
        )
        const start = cursorOffset(args.cursor, matched.length)
        const next = start + (args.limit ?? 100)
        return structured({
          total: matched.length,
          assets: matched.slice(start, next).map((a) => assetView(a, counts)),
          ...(next < matched.length ? { nextCursor: String(next) } : {}),
        })
      },
    }),
    defineTool({
      name: 'asset_read',
      title: 'Read asset',
      description: `Read an asset (id or name) as the app parses it: tables, subtitles (index, start, end, speaker, text), text (paragraphs; a markdown table as rows) and JSON records selected by jsonPath such as "$.lines[*]" with optional fields paths per column. Anything else, and JSON without jsonPath, comes back as raw text lines. from is the first row or line (from 0), count at most ${ASSET_READ_MAX}; long cells are cut.`,
      input: z.object({
        asset: assetRef,
        from: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(ASSET_READ_MAX).optional(),
        ...assetShape,
      }),
      annotations: READ,
      async run(_ctx, args) {
        const asset = findAsset(requireRepository(deps).projectForMain(), args.asset)
        const content = await deps.loadAsset(asset, { ...(args.jsonPath ? { jsonPath: args.jsonPath } : {}), ...(args.fields ? { fields: args.fields } : {}) })
        const from = args.from ?? 0
        const end = from + (args.count ?? 50)
        const head = { asset: asset.name, kind: asset.kind, format: content.format }
        if ('duration' in content) return structured({ ...head, duration: content.duration })
        const items = isTable(content) ? content.rows : content.lines
        const page = {
          total: items.length,
          from,
          ...(end < items.length ? { nextFrom: end } : {}),
        }
        if (isTable(content)) {
          return structured({ ...head, columns: content.columns, ...page, rows: content.rows.slice(from, end).map((cells) => cells.map((c) => clip(c))) })
        }
        return structured({ ...head, ...page, lines: content.lines.slice(from, end).map((line) => clip(line)) })
      },
    }),
    defineTool({
      name: 'lines_build',
      title: 'Build lines',
      description:
        'Create lines from assets. assets with strategy perFile: one line per audio file (no assets = every audio asset no line comes from yet; nested folders keep their relative folder in the line field "path"). asset with mapping: one line per row of a table, subtitle, text or JSON asset (jsonPath, fields); mapping names columns by header or index for key, text (original), translation, character, start and end, and is detected when omitted. A key matching an existing line updates it; rows built before are skipped; speakers become character proposals.',
      input: z
        .object({
          assets: z.array(assetRef).min(1).max(20_000).optional(),
          strategy: z.literal('perFile').optional(),
          asset: assetRef.optional(),
          mapping: rowMapping.optional(),
          ...assetShape,
        })
        .refine((a) => a.asset === undefined || (a.assets === undefined && a.strategy === undefined), {
          message: 'pass asset (with mapping) or strategy perFile (with assets), not both',
        })
        .refine((a) => a.asset !== undefined || a.strategy === 'perFile', { message: 'pass asset, or strategy perFile' }),
      annotations: WRITE,
      async run(_ctx, args) {
        const repository = requireRepository(deps)
        await deps.flushUi()
        const project = repository.projectForMain()
        if (args.asset === undefined) {
          const counts = assetLinks(project.cues)
          const ids = args.assets
            ? args.assets.map((ref) => findAsset(project, ref).id)
            : (project.assets ?? []).filter((a) => a.kind === 'audio' && !counts.get(a.id)?.lines).map((a) => a.id)
          if (ids.length === 0) throw new Error('Every audio asset already has lines; call assets to check.')
          const done = await deps.buildAudioLines(ids, repository)
          return structured({
            created: done.added,
            updated: done.updated,
            ...(done.unmatched ? { skippedUnmatched: done.unmatched } : {}),
            ...(done.duplicates ? { duplicates: done.duplicates.slice(0, REPORT_LIST_MAX) } : {}),
            skipped: done.skipped.slice(0, REPORT_LIST_MAX),
          })
        }
        const asset = findAsset(project, args.asset)
        const table = await assetTable(deps, asset, { ...(args.jsonPath ? { jsonPath: args.jsonPath } : {}), ...(args.fields ? { fields: args.fields } : {}) })
        const columns = rowColumns(asset.kind, table.columns, args.mapping as RowMapping | undefined)
        let summary: ReturnType<typeof buildRowLines>['summary'] | undefined
        const result = await repository.mutate((current) => {
          const built = buildRowLines(current, table.rows, columns, findAsset(current, asset.id))
          summary = built.summary
          return built.changes
        })
        if (result) deps.emit(result)
        return structured({ rows: table.rows.length, mapping: columnNames(table, columns), ...summary })
      },
    }),
    defineTool({
      name: 'link',
      title: 'Link asset rows to lines',
      description: `Link rows of a table, subtitle, text or JSON asset to existing lines. key: the row key matches a line key or field after normalizing case, separators, zero padding and a prefix or suffix shared by all keys. text: similarity of the row text to the line original text (lines without it need transcribe first). auto: key, then text for the rest. Without apply only reports. apply writes the row text into the original text and a translation column into a pending suggestion for links with confidence at least ${TEXT_MATCH_MIN}, and stores each link, plus speakers, as proposals.`,
      input: z.object({
        asset: assetRef,
        strategy: z.enum(['key', 'text', 'auto']).optional(),
        apply: z.boolean().optional(),
        mapping: rowMapping.optional(),
        ...assetShape,
      }),
      annotations: DESTRUCTIVE,
      writes: (args) => args.apply === true,
      async run(_ctx, args) {
        const pinned = pin(deps)
        if (args.apply === true) await deps.flushUi()
        const project = requireRepository(pinned).projectForMain()
        const asset = findAsset(project, args.asset)
        const table = await assetTable(deps, asset, { ...(args.jsonPath ? { jsonPath: args.jsonPath } : {}), ...(args.fields ? { fields: args.fields } : {}) })
        const columns = rowColumns(asset.kind, table.columns, args.mapping as RowMapping | undefined)
        const report = linkRows(project.cues, table.rows, columns, args.strategy ?? 'auto')
        const view = {
          rows: table.rows.length,
          mapping: columnNames(table, columns),
          linked: report.links.length,
          coverage: {
            rows: table.rows.length ? Math.round((report.links.length / table.rows.length) * 1000) / 1000 : 0,
            lines: project.cues.length ? Math.round((report.links.length / project.cues.length) * 1000) / 1000 : 0,
          },
          links: report.links.slice(0, REPORT_LIST_MAX).map((l) => ({ row: l.row, line: l.key, confidence: l.confidence, reason: l.reason })),
          ambiguous: report.ambiguous.slice(0, REPORT_LIST_MAX),
          unmatched: { count: report.unmatched.length, rows: report.unmatched.slice(0, REPORT_LIST_MAX) },
          ...(report.needsTranscribe.length > 0
            ? { needsTranscribe: { count: report.needsTranscribe.length, lines: report.needsTranscribe.slice(0, REPORT_LIST_MAX) } }
            : {}),
        }
        if (args.apply !== true) return structured(view)
        const byId = new Map(project.cues.map((c) => [c.id, c]))
        const chosen = report.links.filter((l) => {
          const origins = byId.get(l.cueId)?.origins ?? []
          return l.confidence >= TEXT_MATCH_MIN && !origins.some((o) => o.assetId === asset.id && o.row === l.row)
        })
        const plan = linkPlan(project, chosen, table.rows, columns, asset)
        if (plan.fields.length > 0 || plan.addCharacters.length > 0) {
          await execute(pinned, { type: 'table.step', remove: [], restore: [], fields: plan.fields, addCharacters: plan.addCharacters, dropCharacters: [] })
        }
        if (plan.proposals.length > 0) await execute(pinned, { type: 'cue.propose', items: plan.proposals })
        return structured({
          ...view,
          applied: plan.proposals.length,
          originalTexts: plan.fields.filter((f) => f.to.sourceText !== undefined).length,
          suggestions: plan.fields.filter((f) => f.to.suggestedText !== undefined).length,
          characterProposals: plan.proposals.filter((p) => p.character).length,
          ...(plan.addCharacters.length > 0 ? { createdCharacters: plan.addCharacters.map((c) => c.name) } : {}),
          ...(plan.skipped.length > 0 ? { skipped: { count: plan.skipped.length, rows: plan.skipped.slice(0, REPORT_LIST_MAX) } } : {}),
        })
      },
    }),
    defineTool({
      name: 'characters_assign',
      title: 'Assign characters',
      description: `Assign characters (name or id) to lines with a confidence and a reason, as proposals the user reviews (default) or set directly. create adds characters that do not exist yet. At most ${ASSIGN_MAX} items.`,
      input: z.object({
        items: z
          .array(z.object({ line: lineRef, character: characterRef, confidence, reason: reasonText }))
          .min(1)
          .max(ASSIGN_MAX),
        create: z.boolean().optional(),
        apply: z.enum(['propose', 'set']).optional(),
      }),
      annotations: DESTRUCTIVE,
      async run(_ctx, args) {
        const pinned = pin(deps)
        await deps.flushUi()
        const project = requireRepository(pinned).projectForMain()
        const known = (ref: string): boolean => {
          try {
            findCharacter(project, ref)
            return true
          } catch {
            return false
          }
        }
        const missing = args.items.map((item) => item.character).filter((ref) => !known(ref))
        const created = args.create === true ? speakerCharacters(project.characters, missing) : []
        if (created.length > 0) {
          await execute(pinned, { type: 'table.step', remove: [], restore: [], fields: [], addCharacters: created, dropCharacters: [] })
        }
        const now = requireRepository(pinned).projectForMain()
        const outcomes: { line: string; outcome: string; reason?: string }[] = []
        const proposals: ProposalItem[] = []
        const steps: FieldStep[] = []
        const seen = new Set<string>()
        for (const item of args.items) {
          let cue: Cue
          let characterId: string
          try {
            cue = findLine(now, item.line)
            characterId = findCharacter(now, item.character).id
          } catch (error) {
            outcomes.push({ line: item.line, outcome: 'error', reason: reason(error) })
            continue
          }
          if (seen.has(cue.id)) {
            outcomes.push({ line: cue.key, outcome: 'error', reason: 'this line appears twice in items' })
            continue
          }
          seen.add(cue.id)
          if (args.apply === 'set') {
            if (cue.characterId !== characterId) steps.push({ cueId: cue.id, from: { characterId: cue.characterId }, to: { characterId } })
            if (cue.proposals?.character) proposals.push({ cueId: cue.id, character: null })
            outcomes.push({ line: cue.key, outcome: cue.characterId === characterId ? 'unchanged' : 'set' })
          } else if (cue.characterId === characterId) {
            outcomes.push({ line: cue.key, outcome: 'unchanged' })
          } else {
            proposals.push({ cueId: cue.id, character: { characterId, confidence: item.confidence, reason: item.reason } })
            outcomes.push({ line: cue.key, outcome: 'proposed' })
          }
        }
        if (steps.length > 0) {
          await execute(pinned, { type: 'table.step', remove: [], restore: [], fields: steps, addCharacters: [], dropCharacters: [] })
        }
        if (proposals.length > 0) await execute(pinned, { type: 'cue.propose', items: proposals })
        return structured({ outcomes, ...(created.length > 0 ? { createdCharacters: created.map((c) => c.name) } : {}) })
      },
    }),
    defineTool({
      name: 'proposals',
      title: 'Proposals',
      description: `Review what was inferred rather than known: character and link proposals (with confidence and reason), pending text suggestions (no confidence) and proposed glossary terms. Pass exactly one key: list (at most ${PROPOSALS_PAGE_MAX} per page), accept, reject, or acceptAll by kind and minimum confidence. Accepting a character sets it, a link keeps the line tied to its asset row, a text replaces the line text, a term joins the glossary.`,
      input: z
        .object({
          list: z
            .object({
              kind: proposalKind.optional(),
              minConfidence: confidence.optional(),
              cursor: pageCursor.optional(),
              limit: z.number().int().min(1).max(PROPOSALS_PAGE_MAX).optional(),
            })
            .optional(),
          accept: z.array(proposalItem).min(1).max(TERMS_MAX).optional(),
          reject: z.array(proposalItem).min(1).max(TERMS_MAX).optional(),
          acceptAll: z.object({ kind: proposalKind, minConfidence: confidence.optional() }).optional(),
        })
        .refine((a) => exactlyOne([a.list, a.accept, a.reject, a.acceptAll]), {
          message: 'pass exactly one of list, accept, reject or acceptAll',
        }),
      annotations: DESTRUCTIVE,
      writes: (args) => args.list === undefined,
      async run(_ctx, args) {
        const pinned = pin(deps)
        if (args.list === undefined) await deps.flushUi()
        const project = requireRepository(pinned).projectForMain()
        if (args.list) {
          const entries = listProposals(project, args.list.kind, args.list.minConfidence)
          const start = cursorOffset(args.list.cursor, entries.length)
          const next = start + (args.list.limit ?? 50)
          return structured({
            total: entries.length,
            items: entries.slice(start, next).map((e) => proposalView(project, e)),
            ...(next < entries.length ? { nextCursor: String(next) } : {}),
          })
        }
        const accept = args.reject === undefined
        const items = args.acceptAll
          ? listProposals(project, args.acceptAll.kind, args.acceptAll.minConfidence).map((e) =>
              e.term ? { kind: 'term' as const, term: e.term.term } : { kind: e.kind as ProposalRef['kind'], line: (e.cue as Cue).id }
            )
          : (args.accept ?? args.reject ?? [])
        const refs: ProposalRef[] = []
        const lines: string[] = []
        const errors: { line: string; reason: string }[] = []
        const has = (cue: Cue, kind: ProposalRef['kind']): boolean =>
          kind === 'text' ? cue.suggestedText !== undefined : cue.proposals?.[kind] !== undefined
        for (const item of items) {
          if (!('line' in item)) continue
          try {
            const cue = findLine(project, item.line)
            if (!has(cue, item.kind)) errors.push({ line: cue.key, reason: `no pending ${item.kind} proposal` })
            else if (!refs.some((r) => r.cueId === cue.id && r.kind === item.kind)) {
              refs.push({ cueId: cue.id, kind: item.kind })
              if (!lines.includes(cue.key)) lines.push(cue.key)
            }
          } catch (error) {
            errors.push({ line: item.line, reason: reason(error) })
          }
        }
        if (refs.length > 0) await execute(pinned, { type: accept ? 'proposal.accept' : 'proposal.reject', items: refs })
        const terms = await settleTerms(pinned, items.flatMap((item) => ('term' in item ? [item.term] : [])), accept)
        return structured({
          [accept ? 'accepted' : 'rejected']: refs.length + terms.length,
          lines: lines.slice(0, REPORT_LIST_MAX),
          ...(terms.length > 0 ? { terms } : {}),
          ...(errors.length > 0 ? { errors: errors.slice(0, REPORT_LIST_MAX) } : {}),
        })
      },
    }),
    defineTool({
      name: 'transcribe',
      title: 'Transcribe',
      description: `Speech-to-text of each line's original audio into its original text, one line at a time, at most ${TRANSCRIBE_PAGE_MAX} per call; follow nextCursor. Lines that already have original text are left alone unless overwrite. Uses the voice provider and may cost money.`,
      input: z
        .object({ ...lineSelection, overwrite: z.boolean().optional(), cursor: pageCursor.optional() })
        .refine(oneSelection, oneSelectionMessage),
      annotations: { ...DESTRUCTIVE, openWorldHint: true },
      async run(ctx, args) {
        const repository = requireRepository(deps)
        const selected = selectLines(deps, args)
        const overwrite = args.overwrite === true
        const explicit = args.lines !== undefined
        const updated: string[] = []
        const skipped: { line: string; reason: string }[] = []
        const failed: { line: string; reason: string }[] = []
        const positions = new Map(repository.projectForMain().cues.map((cue, i) => [cue.id, i]))
        const place = (cue: Cue, i: number): number => (explicit ? i : (positions.get(cue.id) ?? i))
        const resume = cursorOffset(args.cursor, explicit ? selected.length : positions.size)
        let at = selected.findIndex((cue, i) => place(cue, i) >= resume)
        if (at < 0) at = selected.length
        let work = 0
        for (; at < selected.length && work < TRANSCRIBE_PAGE_MAX; at++) {
          if (ctx.signal.aborted) break
          if (!repository.isLive()) throw new Error(PROJECT_SWITCHED)
          const cue = selected[at]
          const why = !cue.referenceAudio ? 'no original audio' : !overwrite && cue.sourceText.trim() ? 'already has original text; pass overwrite' : null
          if (why) {
            if (explicit) skipped.push({ line: cue.key, reason: why })
            continue
          }
          work++
          try {
            const done = await deps.transcribe({ cueIds: [cue.id], overwrite }, repository)
            if (done.updated > 0) updated.push(cue.key)
            else skipped.push({ line: cue.key, reason: 'the transcript came back empty' })
          } catch (error) {
            if (!repository.isLive()) throw new Error(PROJECT_SWITCHED)
            failed.push({ line: cue.key, reason: reason(error) })
          }
          ctx.progress(work, undefined, cue.key)
        }
        return structured({ updated, skipped, failed, ...(at < selected.length ? { nextCursor: String(place(selected[at], at)) } : {}) })
      },
    }),
    defineTool({
      name: 'translate_context',
      title: 'Translation context',
      description: `Everything needed to translate lines, at most ${CONTEXT_PAGE_MAX} per page: character, original and current text, pending suggestion, two neighbours each side, original duration, speaking rate and length budget in characters, matching glossary terms and the most similar already translated lines. Also project languages and pronunciation rules.`,
      input: z
        .object({ ...lineSelection, cursor: pageCursor.optional(), limit: z.number().int().min(1).max(CONTEXT_PAGE_MAX).optional() })
        .refine(oneSelection, oneSelectionMessage),
      annotations: READ,
      async run(_ctx, args) {
        const project = requireRepository(deps).projectForMain()
        const selected = selectLines(deps, args)
        const { page, nextCursor } = args.lines
          ? offsetPage(selected, args.cursor, args.limit ?? 20)
          : stablePage(selected, (cue) => cue, project.cues, args.cursor, args.limit ?? 20)
        return structured({
          total: selected.length,
          languages: project.languages ?? null,
          pronunciationRules: project.pronunciationRules,
          lines: translationContext(project, page),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        })
      },
    }),
    defineTool({
      name: 'translations_suggest',
      title: 'Suggest translations',
      description:
        'Store translations as pending suggestions the user accepts or rejects in the app. With apply, lines whose text is empty get the translation as their text directly; lines with text always get a suggestion.',
      input: z.object({
        items: z.array(z.object({ line: lineRef, text: lineText.min(1) })).min(1).max(500),
        apply: z.boolean().optional(),
      }),
      annotations: WRITE,
      async run(_ctx, args) {
        const pinned = pin(deps)
        const project = requireRepository(pinned).projectForMain()
        const outcomes: { line: string; outcome: string; reason?: string }[] = []
        const steps: FieldStep[] = []
        const texts: { cue: Cue; text: string; was: string; pending: string | null; outcome: { outcome: string; reason?: string } }[] = []
        const seen = new Set<string>()
        for (const item of args.items) {
          let cue: Cue
          try {
            cue = findLine(project, item.line)
          } catch (error) {
            outcomes.push({ line: item.line, outcome: 'error', reason: reason(error) })
            continue
          }
          if (seen.has(cue.id)) {
            outcomes.push({ line: cue.key, outcome: 'error', reason: 'this line appears twice in items' })
            continue
          }
          seen.add(cue.id)
          const pending = cue.suggestedText ?? null
          if (args.apply === true && !cue.text.trim()) {
            const outcome = { line: cue.key, outcome: 'applied' }
            texts.push({ cue, text: item.text, was: cue.text, pending, outcome })
            outcomes.push(outcome)
          } else if (item.text === cue.text || item.text === pending) {
            outcomes.push({ line: cue.key, outcome: 'unchanged' })
          } else {
            steps.push({ cueId: cue.id, from: { suggestedText: pending }, to: { suggestedText: item.text } })
            outcomes.push({ line: cue.key, outcome: 'suggested' })
          }
        }
        if (steps.length > 0) {
          await execute(pinned, { type: 'table.step', remove: [], restore: [], fields: steps, addCharacters: [], dropCharacters: [] })
        }
        const cleared: FieldStep[] = []
        for (const { cue, text, was, pending, outcome } of texts) {
          const result = await execute(pinned, { type: 'cue.saveText', cueId: cue.id, text, ifText: was })
          if (result.changes.cues?.find((c) => c.id === cue.id)?.text !== text) {
            Object.assign(outcome, { outcome: 'error', reason: 'the line text changed meanwhile; read it again and retry' })
          } else if (pending !== null) cleared.push({ cueId: cue.id, from: { suggestedText: pending }, to: { suggestedText: null } })
        }
        if (cleared.length > 0) {
          await execute(pinned, { type: 'table.step', remove: [], restore: [], fields: cleared, addCharacters: [], dropCharacters: [] })
        }
        return structured({ outcomes })
      },
    }),
    defineTool({
      name: 'glossary',
      title: 'Glossary',
      description: 'List, add or replace (matched by term, case-insensitive), or remove project glossary terms. Terms you infer should carry proposed: true so the user reviews them in proposals. Pass exactly one key.',
      input: z
        .object({
          list: z.literal(true).optional(),
          upsert: z.array(termRow).min(1).max(TERMS_MAX).optional(),
          remove: z.array(z.string().min(1).max(TERM_TEXT_MAX)).min(1).max(TERMS_MAX).optional(),
        })
        .refine((a) => exactlyOne([a.list, a.upsert, a.remove]), { message: 'pass exactly one of list, upsert or remove' }),
      annotations: DESTRUCTIVE,
      writes: (args) => args.list !== true,
      async run(_ctx, args) {
        const current = requireRepository(deps).projectForMain().terms ?? []
        if (args.list) return structured({ terms: current })
        const terms = args.upsert ? upsertTerms(current, args.upsert) : removeTerms(current, args.remove ?? [])
        if (terms.length > TERMS_MAX) throw new Error(`The glossary would exceed ${TERMS_MAX} terms; remove some first.`)
        await execute(deps, { type: 'terms.set', terms })
        return structured({ terms: requireRepository(deps).projectForMain().terms ?? [] })
      },
    }),
    defineTool({
      name: 'glossary_check',
      title: 'Glossary check',
      description: 'Translated lines whose original text contains a glossary term while the text lacks its translation. Lines with empty text are not checked.',
      input: z.object({
        filter: z.enum(LINE_FILTERS).optional(),
        cursor: pageCursor.optional(),
        limit: z.number().int().min(1).max(LINES_PAGE_MAX).optional(),
      }),
      annotations: READ,
      async run(_ctx, args) {
        const project = requireRepository(deps).projectForMain()
        const issues = glossaryIssues(project.terms ?? [], filterCues(project.cues, args.filter ?? 'all', '', ALL_CHARACTERS))
        const { page, nextCursor } = stablePage(issues, (issue) => issue.cue, project.cues, args.cursor, args.limit ?? 50)
        return structured({
          total: issues.length,
          issues: page.map(({ cue, missing }) => ({
            line: cue.key,
            sourceText: cue.sourceText,
            text: cue.text,
            missing: missing.map((t) => ({ term: t.term, translation: t.translation })),
          })),
          ...(nextCursor === undefined ? {} : { nextCursor }),
        })
      },
    }),
    defineTool({
      name: 'rules',
      title: 'Pronunciation rules',
      description: 'Read or replace the project pronunciation rules text applied before voice generation. Pass exactly one key.',
      input: z
        .object({ get: z.literal(true).optional(), set: z.string().max(100_000).optional() })
        .refine((a) => exactlyOne([a.get, a.set]), { message: 'pass exactly one of get or set' }),
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
      writes: (args) => args.set !== undefined,
      async run(_ctx, args) {
        if (args.set !== undefined) await execute(deps, { type: 'rules.set', text: args.set })
        return structured({ rules: requireRepository(deps).projectForMain().pronunciationRules })
      },
    }),
    defineTool({
      name: 'render',
      title: 'Render line',
      description:
        'Render one line exactly as export would (same audio graph, loudness and sample rate; always 32-bit float WAV) into agent/renders in the project folder, overwriting the previous render, and measure it: duration, integrated LUFS, true peak, sample peak, RMS, leading and trailing silence, clipping. A line without exportable voiced output renders its original. withOriginal also renders and measures the original next to it.',
      input: z.object({ line: lineRef, withOriginal: z.boolean().optional() }),
      annotations: { ...WRITE, idempotentHint: true },
      writes: () => false,
      async run(_ctx, args) {
        const pinned = pin(deps)
        const cue = findLine(requireRepository(pinned).projectForMain(), args.line)
        return structured((await renderCue(pinned, cue, args.withOriginal === true)).view)
      },
    }),
    defineTool({
      name: 'verify',
      title: 'Verify line',
      description:
        'Render one line like render does, transcribe the render with the voice provider and compare it word by word with the line text (the original text when the original was rendered): similarity 0 to 1, missing and extra words, plus the render metrics. Speech-to-text may cost money.',
      input: z.object({ line: lineRef }),
      annotations: { ...WRITE, idempotentHint: true, openWorldHint: true },
      writes: () => false,
      async run(_ctx, args) {
        const pinned = pin(deps)
        const repository = requireRepository(pinned)
        const cue = findLine(repository.projectForMain(), args.line)
        const rendered = await renderCue(pinned, cue, false)
        const expected = rendered.source === 'output' ? cue.text : cue.sourceText
        if (!expected.trim()) {
          throw new Error(`Line ${cue.key} has no ${rendered.source === 'output' ? 'text' : 'original text'} to compare the audio with.`)
        }
        let heard: string
        try {
          heard = await liveCall(repository, () => deps.transcribeFile(rendered.render.path))
        } catch (error) {
          if (!repository.isLive()) throw error
          throw new Error(`Transcription is unavailable for this audio (${reason(error)}); render gives the metrics without it.`)
        }
        requireRevision(rendered.revision, repository.currentRevision())
        return structured({ ...rendered.view, expected, heard, ...transcriptMatch(expected, heard) })
      },
    }),
    defineTool({
      name: 'export',
      title: 'Export',
      description: `Export ready lines to the project export folder exactly like the Export room: all ready lines, or only lines, a line filter, or changed (ready lines changed since the last export). Lines that are not ready are skipped with the reason. dryRun writes nothing and returns readiness counts, planned file names (at most ${EXPORT_PAGE_MAX} per page; follow nextCursor), skipped lines, name collisions and the output folder.`,
      input: z
        .object({
          ...lineSelection,
          changed: z.literal(true).optional(),
          dryRun: z.boolean().optional(),
          cursor: pageCursor.optional(),
          limit: z.number().int().min(1).max(EXPORT_PAGE_MAX).optional(),
        })
        .refine((a) => [a.lines, a.filter, a.changed].filter((v) => v !== undefined).length <= 1, {
          message: 'pass at most one of lines, filter or changed',
        }),
      annotations: WRITE,
      writes: (args) => args.dryRun !== true,
      async run(_ctx, args) {
        const pinned = pin(deps)
        const repository = requireRepository(pinned)
        const info = await deps.exportInfo()
        const project = repository.projectForMain()
        const rows = readinessRows(project, info.last?.lines ?? {})
        const chosen = args.lines || args.filter ? new Set(selectLines(pinned, args).map((c) => c.id)) : null
        const scope = rows.filter((r) => (chosen ? chosen.has(r.cueId) : true) && (args.changed ? r.changed : true))
        const ready = scope.filter((r) => r.status === 'ready')
        const notReady = scope.filter((r) => r.status !== 'ready')
        const skipped = {
          skippedTotal: notReady.length,
          skipped: notReady.slice(0, REPORT_LIST_MAX).map((r) => ({ line: r.cueKey, reason: statusWords(r) })),
        }
        if (args.dryRun) {
          const byId = new Map(project.cues.map((c) => [c.id, c]))
          const { page, nextCursor } = stablePage(ready, (r) => byId.get(r.cueId) as Cue, project.cues, args.cursor, args.limit ?? 100)
          return structured({
            dryRun: true,
            outDir: info.outDir,
            summary: summarize(project, rows),
            ready: ready.length,
            files: page.map((r) => ({ line: r.cueKey, name: r.name, changed: r.changed, duration: r.outputLength ?? null })),
            ...skipped,
            collisions: findCollisions(planBatch(project)).slice(0, REPORT_LIST_MAX).map((c) => ({ name: c.name, lines: c.cueKeys })),
            ...(nextCursor === undefined ? {} : { nextCursor }),
          })
        }
        if (ready.length === 0) throw new Error('None of the selected lines is ready to export; call export with dryRun to see why.')
        const result = await liveCall(repository, () => deps.exportLines(ready.map((r) => r.cueId), repository))
        return structured({
          written: result.written,
          failed: result.failed.slice(0, REPORT_LIST_MAX).map((f) => ({ line: f.cueKey, name: f.name, reason: f.error })),
          outDir: result.outDir,
          reportPath: result.reportPath ?? null,
          ...(result.indexPath ? { indexPath: result.indexPath } : {}),
          ...(result.version === undefined ? {} : { version: result.version }),
          ...skipped,
        })
      },
    }),
    defineTool({
      name: 'diagnostics',
      title: 'Diagnostics',
      description: 'Recent renderer console errors, renderer crashes and main-process errors, oldest first; since takes an ISO time.',
      input: z.object({ since: z.string().max(40).optional() }),
      annotations: READ,
      async run(_ctx, args) {
        const since = args.since === undefined ? -Infinity : Date.parse(args.since)
        if (Number.isNaN(since)) throw new Error('since must be an ISO date-time such as 2026-01-01T12:00:00Z.')
        return structured({ entries: deps.diagnostics().filter((e) => Date.parse(e.at) > since) })
      },
    }),
    defineTool({
      name: 'screenshot',
      title: 'Screenshot',
      description: 'PNG screenshot of the app window as the user sees it.',
      input: z.object({}),
      annotations: READ,
      async run() {
        const png = await deps.screenshot()
        if (!png) throw new Error('The app has no open window to capture.')
        return { image: { data: png.toString('base64'), mimeType: 'image/png' } }
      },
    }),
  ]
  return tools as McpTool[]
}
