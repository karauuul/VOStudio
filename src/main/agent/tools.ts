import { randomUUID } from 'crypto'
import path from 'path'
import { z } from 'zod/v4'
import type { ProjectVersion } from '@shared/domain'
import { resolveVoiceSettings } from '@shared/domain'
import { clampVoiceSettings } from '@shared/generation'
import { LINE_TEXT_MAX } from '@shared/lines'
import { defineTool, issueText, type McpTool, type ToolAnnotations, type ToolOutput } from '@shared/mcp'
import { audioWithinRoots, type CommandResult, type ProjectCommand } from '@shared/project-commands'
import type { ProjectSummary } from '@shared/project-summary'
import type { TemplateIssue } from '@shared/ipc'
import {
  findCharacter,
  findLine,
  LINE_FILTERS,
  LINES_PAGE_MAX,
  lineDetail,
  listLines,
  projectOverview,
} from '@shared/agent-lines'
import type { SerialProjectRepository } from '../project-repository'
import type { VoiceProvider } from '../providers/voice-provider'
import { projectCommandSchema } from '../schemas'
import type { DiagnosticEntry } from './diagnostics'

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
  emit: (result: CommandResult) => void
  audioRoots: () => string[]
  provider: () => VoiceProvider
  diagnostics: () => DiagnosticEntry[]
  screenshot: () => Promise<Buffer | null>
}

export const AGENT_INSTRUCTIONS = [
  'VO Studio is a live desktop app; the user may be working in it while you do.',
  'Call status first to see the open project and the line the user is on.',
  'Address lines by key, or by id when a key is ambiguous; lines paginates, so follow nextCursor.',
  'Nothing here deletes audio: takes stay on disk and a version named "Before agent" is saved before your first change to a project.',
  'Voice generation costs money and is not available through these tools yet.',
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

const structured = (value: Record<string, unknown>): ToolOutput => ({ structured: value })

function requireRepository(deps: AgentDeps): SerialProjectRepository {
  const repository = deps.repository()
  if (!repository) throw new Error('No project is open; call project_open first.')
  return repository
}

async function execute(deps: AgentDeps, command: ProjectCommand): Promise<CommandResult> {
  const result = await requireRepository(deps).execute(command)
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
        const applied: { op: string; line: string; id: string }[] = []
        for (const [i, op] of args.ops.entries()) {
          if (ctx.signal.aborted) break
          try {
            applied.push(await applyEdit(deps, op))
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
        let id: string
        if (args.create !== undefined) {
          id = randomUUID()
          await execute(deps, { type: 'character.create', id, name: args.create })
        } else id = findCharacter(requireRepository(deps).projectForMain(), args.character ?? '').id
        if (args.rename !== undefined) await execute(deps, { type: 'character.rename', characterId: id, name: args.rename })
        if (args.voiceId !== undefined || args.ttsModel !== undefined || args.stsModel !== undefined) {
          await execute(deps, {
            type: 'character.setProvider',
            characterId: id,
            ...(args.voiceId === undefined ? {} : { voiceId: args.voiceId }),
            ...(args.ttsModel === undefined ? {} : { ttsModel: args.ttsModel }),
            ...(args.stsModel === undefined ? {} : { stsModel: args.stsModel }),
          })
        }
        if (args.settings !== undefined) {
          const current = findCharacter(requireRepository(deps).projectForMain(), id)
          const settings = clampVoiceSettings(resolveVoiceSettings(current, { voiceSettingsOverride: args.settings }))
          await execute(deps, { type: 'character.setVoiceSettings', characterId: id, settings })
        }
        return structured({ character: characterView(findCharacter(requireRepository(deps).projectForMain(), id)) })
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
