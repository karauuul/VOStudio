import { describe, expect, it, vi } from 'vitest'
import { SerialProjectRepository } from '../src/main/project-repository'
import { agentTools, AGENT_INSTRUCTIONS, type AgentDeps } from '../src/main/agent/tools'
import type { VoiceProvider } from '../src/main/providers/voice-provider'
import { projectDirSchema, projectNameSchema } from '../src/main/schemas'
import { emptyEdits, type Cue, type Project } from '../src/shared/domain'
import { createSession, handleMessage, type McpServer, type RpcMessage } from '../src/shared/mcp'
import type { CommandResult } from '../src/shared/project-commands'

const voice = { stability: 0.5, similarity: 0.5, style: 0, speed: 1, boost: true }

function cue(id: string, key: string, text: string, characterId = 'ada'): Cue {
  return { id, characterId, key, fields: {}, sourceText: `src ${id}`, text, status: text ? 'translated' : 'empty', notes: '', takes: [] }
}

function project(): Project {
  const voiced = cue('c3', 'L3', 'Voiced line', 'bob')
  voiced.takes = [{ id: 't1', kind: 'tts', createdAt: 'now', file: { fileId: 't1', relPath: '/p/t1.mp3', format: 'mp3' }, duration: 2, meta: { provider: 'mock', model: 'm', text: 'Voiced line' }, edits: emptyEdits() }]
  voiced.finalTakeId = 't1'
  voiced.status = 'generated'
  return {
    id: 'p', schemaVersion: 1, createdAt: 'now', name: 'Demo', pronunciationRules: '',
    media: { referenceDir: '', referencePattern: '' }, sessions: [], exportTemplate: '{key}.{ext}',
    characters: [
      { id: 'ada', name: 'Ada', color: '#fff', provider: { providerId: 'elevenlabs', voiceId: '', ttsModel: 'm', stsModel: 's' }, voiceSettings: { ...voice } },
      { id: 'bob', name: 'Bob', color: '#000', provider: { providerId: 'elevenlabs', voiceId: 'v', ttsModel: 'm', stsModel: 's' }, voiceSettings: { ...voice } },
    ],
    cues: [cue('c1', 'L1', 'Hello there'), cue('c2', 'L2', 'x'.repeat(300)), voiced, cue('c4', 'DUP', 'one'), cue('c5', 'DUP', 'two'), cue('c6', 'L6', '')],
    ui: { filter: '', search: '', activeCueId: 'c2' },
  }
}

const provider: VoiceProvider = {
  id: 'mock',
  hasApiKey: async () => true,
  voices: async () => [{ id: 'mock-alto', name: 'Mock Alto' }],
  models: async () => [],
} as unknown as VoiceProvider

function setup(open = true) {
  const repo = open ? new SerialProjectRepository(project(), vi.fn(), 60_000) : null
  const emitted: CommandResult[] = []
  const deps: AgentDeps = {
    version: '1.2.3',
    repository: () => repo,
    projectDir: () => (repo ? '/root/Demo.vostudio' : null),
    listProjects: async () => [{ dir: '/root/Demo.vostudio', name: 'Demo', modifiedAt: 0, stats: null }],
    openProject: vi.fn(async () => null),
    createProject: vi.fn(async () => undefined),
    importTemplate: vi.fn(async () => ({ warnings: [] })),
    closeProject: vi.fn(async () => undefined),
    saveVersion: vi.fn(async () => []),
    restoreVersion: vi.fn(async () => undefined),
    flushUi: vi.fn(async () => undefined),
    checkRemovable: vi.fn(async () => undefined),
    emit: (result) => emitted.push(result),
    audioRoots: () => ['/root/Demo.vostudio'],
    provider: () => provider,
    diagnostics: () => [
      { at: '2026-01-01T00:00:00.000Z', source: 'renderer', message: 'old' },
      { at: '2026-01-02T00:00:00.000Z', source: 'crash', message: 'new' },
    ],
    screenshot: async () => null,
  }
  const spec: McpServer = { info: { name: 'vo-studio', version: '1.2.3' }, instructions: AGENT_INSTRUCTIONS, tools: agentTools(deps) }
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ data: Record<string, unknown>; error?: string }> => {
    const sent: RpcMessage[] = []
    await handleMessage(spec, createSession(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, (m) => sent.push(m))
    const result = sent[0].result as { structuredContent?: Record<string, unknown>; isError?: boolean; content: { text: string }[] }
    return result.isError ? { data: {}, error: result.content[0].text } : { data: result.structuredContent ?? {} }
  }
  return { repo, deps, emitted, call, spec }
}

describe('agent tool registry', () => {
  it('lists object schemas with all four annotations on every tool', async () => {
    const { spec } = setup()
    const sent: RpcMessage[] = []
    await handleMessage(spec, createSession(), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, (m) => sent.push(m))
    const tools = (sent[0].result as { tools: { name: string; inputSchema: { type: string }; annotations: Record<string, unknown> }[] }).tools
    expect(tools.map((t) => t.name)).toEqual([
      'status', 'projects', 'project_open', 'project_close', 'lines', 'line', 'lines_edit', 'characters', 'character_set', 'voices', 'versions', 'command', 'diagnostics', 'screenshot',
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) expect(typeof tool.annotations[hint]).toBe('boolean')
    }
  })
})

describe('status and reads', () => {
  it('summarizes the open project and the active line without exposing a key', async () => {
    const { call } = setup()
    const { data } = await call('status')
    expect(data).toMatchObject({ version: '1.2.3', mode: 'live', provider: 'mock', hasApiKey: true, activeLine: 'L2' })
    expect(data.project).toMatchObject({ name: 'Demo', dir: '/root/Demo.vostudio', lines: 6, characters: 2, statuses: { translated: 4, generated: 1, empty: 1 } })
  })

  it('reports a closed project as null and read tools ask to open one', async () => {
    const { call } = setup(false)
    expect((await call('status')).data).toMatchObject({ project: null, activeLine: null })
    expect((await call('lines')).error).toBe('No project is open; call project_open first.')
  })

  it('paginates lines with a cursor and trims text in concise mode', async () => {
    const { call } = setup()
    const first = await call('lines', { limit: 2 })
    expect(first.data.total).toBe(6)
    expect(first.data.nextCursor).toBe('2')
    const rows = first.data.rows as { key: string; text: string; character: string; readiness: string }[]
    expect(rows.map((r) => r.key)).toEqual(['L1', 'L2'])
    expect(rows[1].text).toHaveLength(120)
    expect(rows[0]).toMatchObject({ character: 'Ada', status: 'translated', takes: 0, readiness: 'no-audio' })
    const last = await call('lines', { limit: 4, cursor: '2', detail: 'full' })
    expect((last.data.rows as { key: string }[]).map((r) => r.key)).toEqual(['L3', 'DUP', 'DUP', 'L6'])
    expect(last.data.nextCursor).toBeUndefined()
    expect((last.data.rows as Record<string, unknown>[])[0]).toMatchObject({ source: 'src c3', takes: 1, duration: 2 })
    expect((await call('lines', { cursor: 'abc' })).error).toMatch(/^Invalid cursor/)
    expect((await call('lines', { limit: 500 })).error).toMatch(/^Invalid arguments at "limit"/)
  })

  it('filters by app filter, character name and search', async () => {
    const { call } = setup()
    const keys = async (args: Record<string, unknown>): Promise<string[]> =>
      ((await call('lines', args)).data.rows as { key: string }[]).map((r) => r.key)
    expect(await keys({ character: 'bob' })).toEqual(['L3'])
    expect(await keys({ filter: 'gen' })).toEqual(['L3'])
    expect(await keys({ search: 'hello' })).toEqual(['L1'])
    expect((await call('lines', { character: 'Zed' })).error).toBe('No character "Zed"; call characters to list them.')
    expect((await call('lines', { filter: 'bogus' })).error).toMatch(/^Invalid arguments at "filter"/)
  })

  it('returns one line in full and explains ambiguous keys', async () => {
    const { call } = setup()
    const { data } = await call('line', { line: 'L3' })
    expect(data).toMatchObject({ key: 'L3', id: 'c3', character: { id: 'bob', name: 'Bob' }, done: false, text: 'Voiced line', comp: null })
    expect(data.takes).toEqual([{ id: 't1', kind: 'tts', provider: 'mock', model: 'm', duration: 2, createdAt: 'now', text: 'Voiced line' }])
    expect((await call('line', { line: 'DUP' })).error).toBe('Line key "DUP" matches 2 lines (ids c4, c5); pass one of these ids instead.')
    expect((await call('line', { line: 'c5' })).data).toMatchObject({ id: 'c5', text: 'two' })
    expect((await call('line', { line: 'nope' })).error).toBe('No line has key or id "nope"; call lines to list them.')
  })

  it('lists characters, voices and filtered diagnostics', async () => {
    const { call } = setup()
    expect(((await call('characters')).data.characters as { name: string }[]).map((c) => c.name)).toEqual(['Ada', 'Bob'])
    expect((await call('voices')).data).toEqual({ provider: 'mock', voices: [{ id: 'mock-alto', name: 'Mock Alto' }], models: [] })
    expect(((await call('diagnostics', { since: '2026-01-01T12:00:00Z' })).data.entries as { message: string }[]).map((e) => e.message)).toEqual(['new'])
    expect((await call('diagnostics', { since: 'yesterday' })).error).toMatch(/^since must be an ISO/)
    expect((await call('screenshot')).error).toBe('The app has no open window to capture.')
  })
})

describe('lines_edit', () => {
  it('applies ops in order through project commands and emits each change', async () => {
    const { call, repo, emitted } = setup()
    const { data } = await call('lines_edit', {
      ops: [
        { op: 'setText', line: 'L1', text: 'Hi', ifText: 'Hello there' },
        { op: 'add', after: 'L1', text: 'Inserted', character: 'Bob' },
        { op: 'exclude', line: 'c4', excluded: true },
        { op: 'setCharacter', line: 'L6', character: 'bob' },
        { op: 'delete', line: 'c5' },
      ],
    })
    const applied = data.applied as { op: string; line: string; id: string }[]
    expect(applied.map((a) => a.op)).toEqual(['setText', 'add', 'exclude', 'setCharacter', 'delete'])
    const cues = repo!.projectForMain().cues
    expect(cues.map((c) => c.key)).toEqual(['L1', applied[1].line, 'L2', 'L3', 'DUP', 'L6'])
    expect(cues[0].text).toBe('Hi')
    expect(cues[1]).toMatchObject({ id: applied[1].id, text: 'Inserted', characterId: 'bob' })
    expect(cues[4].status).toBe('excluded')
    expect(cues[5].characterId).toBe('bob')
    expect(emitted.map((r) => r.revision)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('stops at the first failing op and says how many applied', async () => {
    const { call, repo } = setup()
    const { error } = await call('lines_edit', {
      ops: [
        { op: 'setText', line: 'L1', text: 'Changed' },
        { op: 'setText', line: 'L2', text: 'Nope', ifText: 'stale' },
        { op: 'delete', line: 'L6' },
      ],
    })
    expect(error).toBe('Op 2 (setText) failed after 1 applied: Line L2 no longer has the ifText you passed; read it again with line and retry.')
    expect(repo!.projectForMain().cues.map((c) => c.key)).toContain('L6')
    expect(repo!.projectForMain().cues[0].text).toBe('Changed')
  })

  it('keeps a multi-op edit on the project it started on', async () => {
    const { call, repo, deps } = setup()
    const other = new SerialProjectRepository(project(), vi.fn(), 60_000)
    deps.checkRemovable = vi.fn(async () => {
      await repo!.detach()
      deps.repository = () => other
    })
    const { error } = await call('lines_edit', {
      ops: [
        { op: 'delete', line: 'L6' },
        { op: 'setText', line: 'L1', text: 'Moved on' },
      ],
    })
    expect(error).toBe('Op 1 (delete) failed after 0 applied: The project was closed or switched during this call; call status, then retry.')
    expect(other.projectForMain().cues.find((c) => c.key === 'L1')!.text).not.toBe('Moved on')
    expect(other.projectForMain().cues.map((c) => c.key)).toContain('L6')
  })

  it('asks the UI before deleting lines and stops when a line is busy', async () => {
    const { call, repo, deps } = setup()
    deps.checkRemovable = vi.fn(async () => {
      throw new Error('Line is busy; ask the user to finish it in the app, then retry.')
    })
    expect((await call('lines_edit', { ops: [{ op: 'delete', line: 'L6' }] })).error).toBe(
      'Op 1 (delete) failed after 0 applied: Line is busy; ask the user to finish it in the app, then retry.'
    )
    const id = repo!.projectForMain().cues.find((c) => c.key === 'L6')!.id
    expect((await call('command', { command: { type: 'cue.delete', cueIds: [id] } })).error).toBe(
      'Line is busy; ask the user to finish it in the app, then retry.'
    )
    expect(deps.checkRemovable).toHaveBeenCalledWith([id])
    expect(repo!.projectForMain().cues.map((c) => c.key)).toContain('L6')
  })

  it('refuses to mark a line done without a voiced output', async () => {
    const { call } = setup()
    expect((await call('lines_edit', { ops: [{ op: 'done', line: 'L1', done: true }] })).error).toBe(
      'Op 1 (done) failed after 0 applied: Approval requires a valid voiced output.'
    )
  })
})

describe('character_set', () => {
  it('creates a character, sets its voice and clamps settings', async () => {
    const { call, repo } = setup()
    const { data } = await call('character_set', { create: 'Cy', voiceId: 'mock-alto', settings: { stability: 0.333, speed: 3 } })
    expect(data.character).toMatchObject({ name: 'Cy', voiceId: 'mock-alto', voiceSettings: { stability: 0.33, speed: 1.2, similarity: 0.51, style: 0, boost: true } })
    expect(repo!.projectForMain().characters.map((c) => c.name)).toEqual(['Ada', 'Bob', 'Cy'])
  })

  it('renames by name and keeps other settings', async () => {
    const { call } = setup()
    const { data } = await call('character_set', { character: 'ada', rename: 'Ada Prime', settings: { style: 0.4 } })
    expect(data.character).toMatchObject({ id: 'ada', name: 'Ada Prime', voiceSettings: { ...voice, style: 0.4 } })
  })

  it('requires exactly one target', async () => {
    const { call } = setup()
    expect((await call('character_set', { rename: 'X' })).error).toBe('Invalid arguments: pass exactly one of character or create.')
    expect((await call('character_set', { character: 'Ada', create: 'X' })).error).toBe('Invalid arguments: pass exactly one of character or create.')
  })
})

describe('command', () => {
  it('validates with the IPC schema, runs and emits', async () => {
    const { call, emitted, repo } = setup()
    const { data } = await call('command', { command: { type: 'cue.saveText', cueId: 'c1', text: 'Raw' } })
    expect(data).toEqual({ revision: 1, changed: ['L1'] })
    expect(emitted).toHaveLength(1)
    expect(repo!.projectForMain().cues[0].text).toBe('Raw')
  })

  it('rejects malformed commands and audio outside the project', async () => {
    const { call, emitted } = setup()
    expect((await call('command', { command: { type: 'cue.saveText', cueId: '' } })).error).toMatch(/^Invalid command at "cueId"/)
    expect((await call('command', { command: { type: 'nope' } })).error).toMatch(/^Invalid command at "type"/)
    const outside = {
      type: 'cue.restoreOriginal', cueId: 'c1', referenceAudio: { fileId: 'x', relPath: '/etc/x.wav', format: 'wav' }, referenceDuration: 1,
      status: 'translated', whenState: { status: 'translated' },
    }
    expect((await call('command', { command: outside })).error).toBe('The command references audio outside this project.')
    expect(emitted).toEqual([])
  })
})

describe('project lifecycle tools', () => {
  it('opens by name through the lifecycle function', async () => {
    const { call, deps } = setup(false)
    expect((await call('project_open', { name: 'demo' })).error).toBe('No project at /root/Demo.vostudio; call projects to list them.')
    expect(deps.flushUi).not.toHaveBeenCalled()
    expect(deps.openProject).toHaveBeenCalledWith('/root/Demo.vostudio')
    expect((await call('project_open', { name: 'Other' })).error).toBe('No project is named "Other"; call projects to list them.')
  })

  it('reports lifecycle validation failures as sentences', async () => {
    const { call, deps } = setup(false)
    deps.openProject = async (dir) => projectDirSchema('/root/projects').parse(dir)
    deps.createProject = async (name) => projectNameSchema.parse(name)
    expect((await call('project_open', { dir: '/etc/x.vostudio' })).error).toBe('Invalid arguments: Path is outside the projects root.')
    expect((await call('project_open', { create: 'a/b' })).error).toBe('Invalid arguments: Invalid project name.')
  })

  it('creates, imports templates by absolute path and needs exactly one key', async () => {
    const { call, deps } = setup(false)
    await call('project_open', { create: 'New' })
    expect(deps.createProject).toHaveBeenCalledWith('New')
    await call('project_open', { template: '/data/demo.vostudio-src' })
    expect(deps.importTemplate).toHaveBeenCalledWith('/data/demo.vostudio-src')
    expect((await call('project_open', { template: 'relative' })).error).toBe('template must be an absolute folder path.')
    expect((await call('project_open', { name: 'a', create: 'b' })).error).toBe('Invalid arguments: pass exactly one of name, dir, create or template.')
  })

  it('lists, saves after flushing the UI, and restores versions', async () => {
    const { call, deps } = setup()
    expect((await call('versions', { action: 'list' })).data).toEqual({ versions: [] })
    await call('versions', { action: 'save', name: 'Mine' })
    expect(deps.saveVersion).toHaveBeenCalledWith('Mine')
    expect((await call('versions', { action: 'restore' })).error).toBe('Invalid arguments: restore needs n, a version number from list.')
    await call('versions', { action: 'restore', n: 2 })
    expect(deps.restoreVersion).toHaveBeenCalledWith(2)
    expect(deps.flushUi).toHaveBeenCalledTimes(1)
  })
})
