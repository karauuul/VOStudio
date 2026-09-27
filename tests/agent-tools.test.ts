import { describe, expect, it, vi } from 'vitest'
import { SerialProjectRepository } from '../src/main/project-repository'
import { agentTools, AGENT_INSTRUCTIONS, type AgentDeps } from '../src/main/agent/tools'
import type { VoiceProvider } from '../src/main/providers/voice-provider'
import { projectDirSchema, projectNameSchema } from '../src/main/schemas'
import { emptyEdits, type Cue, type Project, type ProjectAsset } from '../src/shared/domain'
import type { AssetContent } from '../src/main/assets'
import { createSession, handleMessage, type McpServer, type RpcMessage } from '../src/shared/mcp'
import type { CommandResult } from '../src/shared/project-commands'
import { transcribeCues } from '../src/main/transcribe'

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

const contents: Record<string, AssetContent> = {
  srt: {
    format: 'srt',
    columns: ['index', 'start', 'end', 'speaker', 'text'],
    rows: [
      ['1', '1', '2', 'Ada', 'Hello there, friend'],
      ['2', '3', '4', 'Queen', 'Play for us'],
      ['3', '5', '6', '', 'x'.repeat(600)],
    ],
  },
  csv: { format: 'csv', columns: ['cueId', 'sourceText', 'translation'], rows: [['l1', 'Hello there', 'Привіт'], ['L6', 'Sixth', ''], ['ZZ', 'none', '']] },
  txt: { format: 'txt', lines: ['one', 'two', 'three'] },
  wav: { format: 'audio', duration: 1.5 },
}

const binAssets = (): ProjectAsset[] => [
  { id: 'srt', name: 'subs/demo.srt', kind: 'subtitles', file: { fileId: 'demo.srt', relPath: '/root/Demo.vostudio/assets/demo.srt' }, size: 10, addedAt: 'now', rows: 3 },
  { id: 'csv', name: 'keys.csv', kind: 'table', file: { fileId: 'keys.csv', relPath: '/root/Demo.vostudio/assets/keys.csv' }, size: 10, addedAt: 'now', rows: 3 },
  { id: 'txt', name: 'notes.locres', kind: 'other', file: { fileId: 'notes.locres', relPath: '/root/Demo.vostudio/assets/notes.locres' }, size: 10, addedAt: 'now' },
  { id: 'wav', name: 'vo/a/hit.wav', kind: 'audio', file: { fileId: 'hit.wav', relPath: '/data/vo/a/hit.wav' }, size: 10, addedAt: 'now', duration: 1.5 },
]

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
    importAudio: vi.fn(async () => ({ added: 2, updated: 0, files: 3, duplicates: ['vo/b/hit.wav'] })),
    previewTable: vi.fn(async (req) => ({
      path: req.path, name: 'subs.csv', script: false, headers: ['text', 'translation'], rows: [['Hello', 'Привіт']], total: 1,
      mapping: { text: 0, translation: 1 }, summary: { added: 0, updated: 1, suggested: 0, unchanged: 0, skipped: 0 },
      textMatch: { matched: [{ index: 0, cueId: 'c1', key: 'L1', score: 0.9 }], ambiguous: [{ index: 1, candidates: ['DUP'] }], unmatched: [2] },
    })),
    importTable: vi.fn(async (req) => ({
      path: req.path, name: 'subs.csv', mapping: { text: 0 }, rows: 3, summary: { added: 0, updated: 1, suggested: 0, unchanged: 0, skipped: 2 },
      undo: { ids: [], fields: [], characters: [] },
    })),
    reimportTemplate: vi.fn(async () => ({ added: 0, updated: 5, untouched: 0, orphaned: 0, warnings: [] })),
    transcribe: (req) =>
      transcribeCues(repo!, req.cueIds, req.overwrite === true, async (ref) => {
        if (ref.relPath.includes('broken')) throw new Error('Provider refused the audio.')
        return ref.relPath.includes('silent') ? '' : `heard ${ref.fileId}`
      }, (result) => emitted.push(result)),
    addAssets: vi.fn(async (paths: string[]) => {
      const added = paths.map((p, i) => ({ id: `new${i}`, name: p.split('/').pop() as string, kind: 'other' as const, file: { fileId: 'f', relPath: p }, size: 1, addedAt: 'now' }))
      const current = repo!.projectForMain()
      current.assets = [...(current.assets ?? []), ...added]
      return { added, skipped: [{ name: 'dup.csv', reason: 'already in the bin' }] }
    }),
    loadAsset: vi.fn(async (asset: ProjectAsset) => {
      const content = contents[asset.id]
      if (!content) throw new Error('unreadable')
      return content
    }),
    buildAudioLines: vi.fn(async (ids: string[]) => ({ added: ids.length, updated: 0, files: ids.length, skipped: [] })),
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
      'status', 'projects', 'project_open', 'project_close', 'lines', 'line', 'lines_edit', 'characters', 'character_set', 'voices', 'versions', 'command',
      'import', 'asset_add', 'assets', 'asset_read', 'lines_build', 'link', 'characters_assign', 'proposals', 'transcribe', 'translate_context', 'translations_suggest', 'glossary', 'glossary_check', 'rules', 'diagnostics', 'screenshot',
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

const withAudio = (repo: SerialProjectRepository, cueId: string, relPath: string, sourceText = ''): void => {
  const target = repo.projectForMain().cues.find((c) => c.id === cueId)!
  target.referenceAudio = { fileId: cueId, relPath, format: 'wav' }
  target.sourceText = sourceText
}

describe('import', () => {
  it('imports audio with the default rule and reports duplicates', async () => {
    const { call, deps, repo } = setup()
    const { data } = await call('import', { audio: { paths: ['/data/vo'] } })
    expect(deps.importAudio).toHaveBeenCalledWith({ paths: ['/data/vo'], rule: 'id' }, repo)
    expect(data).toEqual({ added: 2, updated: 0, files: 3, duplicates: ['vo/b/hit.wav'] })
    expect(deps.flushUi).toHaveBeenCalled()
  })

  it('previews a table by default and applies only with preview false', async () => {
    const { call, deps, repo } = setup()
    const { data } = await call('import', { table: { path: '/data/subs.csv', matchBy: 'text' } })
    expect(deps.previewTable).toHaveBeenCalledWith({ path: '/data/subs.csv', rule: 'id', matchBy: 'text' }, repo)
    expect(deps.importTable).not.toHaveBeenCalled()
    expect(data).toMatchObject({
      preview: true,
      total: 1,
      textMatch: { matched: 1, ambiguous: 1, unmatched: 1, pairs: [{ row: 1, line: 'L1', score: 0.9 }], ambiguousRows: [{ row: 2, candidates: ['DUP'] }], unmatchedRows: [3] },
    })
    const applied = await call('import', { table: { path: '/data/subs.csv', preview: false, keepOriginal: true, mapping: { text: 0 } } })
    expect(deps.importTable).toHaveBeenCalledWith({ path: '/data/subs.csv', rule: 'id', mapping: { text: 0 }, keepOriginal: true }, repo)
    expect(applied.data).toEqual({ applied: true, rows: 3, mapping: { text: 0 }, summary: { added: 0, updated: 1, suggested: 0, unchanged: 0, skipped: 2 } })
  })

  it('reimports a template and needs exactly one absolute source', async () => {
    const { call, deps, repo } = setup()
    expect((await call('import', { templateReimport: '/data/demo.vostudio-src' })).data).toMatchObject({ updated: 5 })
    expect(deps.reimportTemplate).toHaveBeenCalledWith('/data/demo.vostudio-src', repo)
    expect((await call('import', {})).error).toBe('Invalid arguments: pass exactly one of audio, table or templateReimport.')
    expect((await call('import', { audio: { paths: ['rel/x.wav'] } })).error).toBe('Invalid arguments at "audio.paths.0": must be an absolute path.')
    expect((await setup(false).call('import', { templateReimport: '/x' })).error).toBe('No project is open; call project_open first.')
  })
})

describe('transcribe', () => {
  it('transcribes line by line and reports skipped and failed lines with reasons', async () => {
    const { call, repo, emitted } = setup()
    withAudio(repo!, 'c1', '/p/a.wav')
    withAudio(repo!, 'c2', '/p/broken.wav')
    withAudio(repo!, 'c3', '/p/silent.wav')
    withAudio(repo!, 'c4', '/p/d.wav', 'kept')
    const { data } = await call('transcribe', { lines: ['L1', 'L2', 'L3', 'c4', 'L6'] })
    expect(data).toEqual({
      updated: ['L1'],
      skipped: [
        { line: 'L3', reason: 'the transcript came back empty' },
        { line: 'DUP', reason: 'already has original text; pass overwrite' },
        { line: 'L6', reason: 'no original audio' },
      ],
      failed: [{ line: 'L2', reason: 'Provider refused the audio' }],
    })
    expect(repo!.projectForMain().cues[0].sourceText).toBe('heard c1')
    expect(emitted).toHaveLength(1)
    const again = await call('transcribe', { lines: ['c4'], overwrite: true })
    expect(again.data).toMatchObject({ updated: ['DUP'] })
  })

  it('sends each explicitly listed line once and stops when the project switches mid-batch', async () => {
    const { call, repo, deps } = setup()
    withAudio(repo!, 'c1', '/p/a.wav')
    withAudio(repo!, 'c3', '/p/c.wav')
    const seen: string[] = []
    const real = deps.transcribe
    deps.transcribe = async (req, expected) => {
      seen.push(...req.cueIds)
      const result = await real(req, expected)
      await repo!.detach()
      return result
    }
    const { error } = await call('transcribe', { lines: ['L1', 'c1', 'L3'], overwrite: true })
    expect(seen).toEqual(['c1'])
    expect(error).toBe('The project was closed or switched during this call; call status, then retry.')
  })

  it('selects by filter, only works on lines with audio and continues with a stable cursor', async () => {
    const { call, repo } = setup()
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) withAudio(repo!, id, `/p/${id}.wav`)
    for (let i = 0; i < 500; i++) {
      repo!.projectForMain().cues.push({ ...repo!.projectForMain().cues[0], id: `x${i}`, key: `X${i}`, referenceAudio: { fileId: `x${i}`, relPath: `/p/x${i}.wav`, format: 'wav' } })
    }
    const first = await call('transcribe', { filter: 'all' })
    expect((first.data.updated as string[]).length).toBe(500)
    expect(first.data.nextCursor).toBe('500')
    const second = await call('transcribe', { filter: 'all', cursor: '500' })
    expect(second.data.updated).toEqual(['X494', 'X495', 'X496', 'X497', 'X498', 'X499'])
    expect(second.data.nextCursor).toBeUndefined()
    expect((await call('transcribe', { lines: ['L1'], filter: 'all' })).error).toBe('Invalid arguments: pass lines or filter, not both.')
  })
})

describe('transcribe cursor', () => {
  it('resumes by project order when transcribing removes lines from the filter', async () => {
    const { call, repo, deps } = setup()
    const cues = repo!.projectForMain().cues
    for (let i = 0; i < 504; i++) {
      cues.push({ ...cues[0], id: `x${i}`, key: `X${i}`, sourceText: '', referenceAudio: { fileId: `x${i}`, relPath: `/p/x${i}.wav`, format: 'wav' } })
    }
    deps.transcribe = async (req) => {
      for (const cue of repo!.projectForMain().cues) if (req.cueIds.includes(cue.id)) cue.status = 'excluded'
      return { updated: req.cueIds.length, skipped: 0 }
    }
    const first = await call('transcribe', { filter: 'work', overwrite: true })
    expect((first.data.updated as string[]).length).toBe(500)
    const second = await call('transcribe', { filter: 'work', overwrite: true, cursor: first.data.nextCursor as string })
    expect(second.data.updated).toEqual(['X500', 'X501', 'X502', 'X503'])
  })
})

describe('translation tools', () => {
  it('builds translation context with neighbours, budget, terms and memory', async () => {
    const { call, repo } = setup()
    const p = repo!.projectForMain()
    p.cues[0].sourceText = 'Welcome back, pioneer.'
    p.cues[5].sourceText = 'Welcome back pioneer!'
    p.cues[5].referenceDuration = 2
    p.terms = [{ term: 'pioneer', translation: 'піонер' }]
    p.languages = { source: 'en', target: 'uk' }
    const { data } = await call('translate_context', { lines: ['L6'] })
    expect(data).toMatchObject({ total: 1, languages: { source: 'en', target: 'uk' }, pronunciationRules: '' })
    const [line] = data.lines as Record<string, unknown>[]
    expect(line).toMatchObject({
      key: 'L6', character: 'Ada', duration: 2, charsPerSecond: 14, budget: 28,
      terms: [{ term: 'pioneer', translation: 'піонер' }],
      memory: [{ key: 'L1', sourceText: 'Welcome back, pioneer.', text: 'Hello there', score: 1 }],
    })
    expect((line.neighbours as { key: string }[]).map((n) => n.key)).toEqual(['DUP', 'DUP'])
    const paged = await call('translate_context', { filter: 'all', limit: 4 })
    expect((paged.data.lines as unknown[]).length).toBe(4)
    expect(paged.data.nextCursor).toBe('4')
  })

  it('stores suggestions in one step and applies text only to empty lines', async () => {
    const { call, repo, emitted } = setup()
    const { data } = await call('translations_suggest', {
      items: [{ line: 'L1', text: 'Hi' }, { line: 'L6', text: 'Fresh' }, { line: 'L1', text: 'Again' }, { line: 'nope', text: 'x' }, { line: 'L3', text: 'Voiced line' }],
      apply: true,
    })
    expect(data.outcomes).toEqual([
      { line: 'L1', outcome: 'suggested' },
      { line: 'L6', outcome: 'applied' },
      { line: 'L1', outcome: 'error', reason: 'this line appears twice in items' },
      { line: 'nope', outcome: 'error', reason: 'No line has key or id "nope"; call lines to list them' },
      { line: 'L3', outcome: 'unchanged' },
    ])
    const cues = repo!.projectForMain().cues
    expect(cues[0]).toMatchObject({ text: 'Hello there', suggestedText: 'Hi' })
    expect(cues[5]).toMatchObject({ text: 'Fresh', status: 'translated' })
    expect(cues[5].suggestedText).toBeUndefined()
    expect(emitted).toHaveLength(2)
    await call('translations_suggest', { items: [{ line: 'L6', text: 'Other' }], apply: true })
    expect(repo!.projectForMain().cues[5]).toMatchObject({ text: 'Fresh', suggestedText: 'Other' })
  })
})

describe('glossary and rules', () => {
  it('upserts, lists and removes terms through terms.set', async () => {
    const { call, repo, emitted } = setup()
    await call('glossary', { upsert: [{ term: 'Pioneer', translation: 'піонер' }, { term: 'node', translation: 'вузол' }] })
    const { data } = await call('glossary', { upsert: [{ term: ' pioneer ', translation: 'першопрохідець', note: 'rank' }] })
    expect(data.terms).toEqual([{ term: 'pioneer', translation: 'першопрохідець', note: 'rank' }, { term: 'node', translation: 'вузол' }])
    expect(emitted[1].changes.terms).toEqual(data.terms)
    expect((await call('glossary', { list: true })).data.terms).toEqual(data.terms)
    await call('glossary', { remove: ['PIONEER', 'node'] })
    expect(repo!.projectForMain().terms).toBeUndefined()
    expect((await call('glossary', { list: true, remove: ['x'] })).error).toBe('Invalid arguments: pass exactly one of list, upsert or remove.')
  })

  it('checks translated lines for missing glossary translations', async () => {
    const { call, repo } = setup()
    const cues = repo!.projectForMain().cues
    cues[0].sourceText = 'The pioneers arrive'
    cues[1].sourceText = 'A pioneer'
    cues[1].text = 'Піонер тут'
    cues[5].sourceText = 'pioneer'
    repo!.projectForMain().terms = [{ term: 'pioneer', translation: 'піонер' }]
    const { data } = await call('glossary_check', {})
    expect(data).toEqual({
      total: 1,
      issues: [{ line: 'L1', sourceText: 'The pioneers arrive', text: 'Hello there', missing: [{ term: 'pioneer', translation: 'піонер' }] }],
    })
  })

  it('reads and replaces pronunciation rules', async () => {
    const { call, repo } = setup()
    expect((await call('rules', { get: true })).data).toEqual({ rules: '' })
    expect((await call('rules', { set: 'GIF = jif' })).data).toEqual({ rules: 'GIF = jif' })
    expect(repo!.projectForMain().pronunciationRules).toBe('GIF = jif')
  })
})

describe('bin tools', () => {
  const withBin = () => {
    const ctx = setup()
    ctx.repo!.projectForMain().assets = binAssets()
    return ctx
  }

  it('adds paths, lists assets with derived link counts and filters by kind and unlinked', async () => {
    const { call, deps, repo } = withBin()
    const added = await call('asset_add', { paths: ['/data/strings.locres'] })
    expect(deps.addAssets).toHaveBeenCalledWith(['/data/strings.locres'], repo)
    expect(added.data).toMatchObject({ added: 1, assets: [{ id: 'new0', name: 'strings.locres', kind: 'other', lines: 0 }], skipped: [{ name: 'dup.csv', reason: 'already in the bin' }] })
    repo!.projectForMain().cues[0].origins = [{ assetId: 'wav' }]
    repo!.projectForMain().cues[1].proposals = { link: { assetId: 'srt', row: 0, confidence: 0.9, reason: 'r' } }
    const all = await call('assets', {})
    expect(all.data.total).toBe(5)
    expect((all.data.assets as Record<string, unknown>[]).find((a) => a.id === 'srt')).toMatchObject({ lines: 0, proposedLinks: 1, rows: 3 })
    expect(((await call('assets', { kind: 'audio' })).data.assets as { id: string; lines: number }[]).map((a) => [a.id, a.lines])).toEqual([['wav', 1]])
    expect(((await call('assets', { unlinked: true, limit: 2 })).data as { nextCursor: string }).nextCursor).toBe('2')
    expect((await call('asset_add', { paths: ['rel.txt'] })).error).toBe('Invalid arguments at "paths.0": must be an absolute path.')
    expect(added.data).not.toHaveProperty('notAdded')
    deps.addAssets.mockResolvedValueOnce({ added: [], skipped: [], truncated: 42 })
    expect((await call('asset_add', { paths: ['/data/huge'] })).data).toMatchObject({
      added: 0,
      notAdded: { files: 42, reason: 'over the 20000 file limit per call; add the remaining folders separately' },
    })
  })

  it('reads tables, raw text and audio in pages and cuts long cells', async () => {
    const { call } = withBin()
    const table = await call('asset_read', { asset: 'demo.srt', from: 1, count: 1 })
    expect(table.data).toEqual({ asset: 'subs/demo.srt', kind: 'subtitles', format: 'srt', columns: ['index', 'start', 'end', 'speaker', 'text'], total: 3, from: 1, nextFrom: 2, rows: [['2', '3', '4', 'Queen', 'Play for us']] })
    const long = ((await call('asset_read', { asset: 'srt', from: 2 })).data.rows as string[][])[0][4]
    expect(long).toBe(`${'x'.repeat(500)}… [600 chars]`)
    expect((await call('asset_read', { asset: 'txt', count: 2 })).data).toMatchObject({ format: 'txt', total: 3, lines: ['one', 'two'], nextFrom: 2 })
    expect((await call('asset_read', { asset: 'hit.wav' })).data).toEqual({ asset: 'vo/a/hit.wav', kind: 'audio', format: 'audio', duration: 1.5 })
    expect((await call('asset_read', { asset: 'nope' })).error).toBe('No asset has id or name "nope"; call assets to list them.')
    expect((await call('asset_read', { asset: 'srt', count: 500 })).error).toMatch(/^Invalid arguments at "count"/)
  })

  it('builds lines from rows once, with speaker proposals, and audio lines per file', async () => {
    const { call, repo, emitted, deps } = withBin()
    const built = await call('lines_build', { asset: 'srt' })
    expect(built.data).toMatchObject({ rows: 3, mapping: { text: 'text', character: 'speaker', start: 'start', end: 'end' }, created: 3, alreadyBuilt: 0, characterProposals: 2 })
    const cues = repo!.projectForMain().cues.slice(6)
    expect(cues.map((c) => [c.sourceText.slice(0, 11), c.origins?.[0].row, c.fields.start])).toEqual([['Hello there', 0, '1'], ['Play for us', 1, '3'], ['xxxxxxxxxxx', 2, '5']])
    expect(cues[0].proposals?.character?.characterId).toBe('ada')
    expect(repo!.projectForMain().characters.map((c) => c.name)).toContain('Queen')
    expect(emitted).toHaveLength(1)
    expect((await call('lines_build', { asset: 'srt' })).data).toMatchObject({ created: 0, alreadyBuilt: 3 })
    expect((await call('lines_build', { asset: 'txt' })).error).toBe('notes.locres reads as plain txt.')
    expect((await call('lines_build', { asset: 'wav' })).error).toBe('vo/a/hit.wav is audio; build lines from it with strategy perFile.')
    expect((await call('lines_build', { strategy: 'perFile' })).data).toMatchObject({ created: 1 })
    expect(deps.buildAudioLines).toHaveBeenCalledWith(['wav'], repo)
    expect((await call('lines_build', { asset: 'srt', strategy: 'perFile' })).error).toMatch(/pass asset \(with mapping\) or strategy perFile/)
    expect((await call('lines_build', { asset: 'csv', mapping: { key: 'nope' } })).error).toBe('No column "nope"; columns are "cueId", "sourceText", "translation".')
  })

  it('reports links without writing, then applies them as proposals once', async () => {
    const { call, repo, emitted, spec } = withBin()
    const beforeWrite = vi.fn(async () => undefined)
    spec.beforeWrite = beforeWrite
    const report = await call('link', { asset: 'csv' })
    expect(report.data).toMatchObject({
      rows: 3,
      mapping: { key: 'cueId', text: 'sourceText', translation: 'translation' },
      linked: 2,
      links: [
        { row: 0, line: 'L1', confidence: 0.95, reason: 'key "l1" matches ignoring case, separators and zero padding' },
        { row: 1, line: 'L6', confidence: 1, reason: 'key "L6" equals the line key' },
      ],
      unmatched: { count: 1, rows: [2] },
    })
    expect(emitted).toHaveLength(0)
    expect(beforeWrite).not.toHaveBeenCalled()
    const applied = await call('link', { asset: 'csv', apply: true })
    expect(beforeWrite).toHaveBeenCalledTimes(1)
    expect(applied.data).toMatchObject({ applied: 2, originalTexts: 2, suggestions: 1, characterProposals: 0 })
    const [l1, , , , , l6] = repo!.projectForMain().cues
    expect([l1.sourceText, l1.suggestedText, l1.proposals?.link]).toEqual(['Hello there', 'Привіт', { assetId: 'csv', row: 0, confidence: 0.95, reason: 'key "l1" matches ignoring case, separators and zero padding' }])
    expect(l6.sourceText).toBe('Sixth')
    await call('proposals', { accept: [{ kind: 'link', line: 'L1' }, { kind: 'link', line: 'L6' }] })
    expect((await call('link', { asset: 'csv', apply: true })).data).toMatchObject({ applied: 0 })
    expect((await call('link', { asset: 'srt', strategy: 'key' })).error).toBe('Linking by key needs a key column; pass mapping.key.')
  })

  it('applies links against the project as it stands after pending edits are saved', async () => {
    const { call, repo, deps } = withBin()
    deps.flushUi = vi.fn(async () => {
      repo!.projectForMain().cues[5].key = 'Renamed'
    })
    const applied = await call('link', { asset: 'csv', apply: true })
    expect(applied.data).toMatchObject({ linked: 1, applied: 1, links: [{ row: 0, line: 'L1' }], unmatched: { count: 2, rows: [1, 2] } })
    expect(repo!.projectForMain().cues[5]).not.toHaveProperty('proposals')
  })

  it('settles terms in the project the call started in even if another opens meanwhile', async () => {
    const { call, repo, deps } = withBin()
    const other = new SerialProjectRepository(project(), vi.fn(), 60_000)
    await call('glossary', { upsert: [{ term: 'node', translation: 'вузол', proposed: true }] })
    other.projectForMain().terms = [{ term: 'node', translation: 'нода', proposed: true }]
    deps.flushUi = vi.fn(async () => {
      deps.repository = () => other
    })
    expect((await call('proposals', { accept: [{ kind: 'term', term: 'node' }] })).data).toEqual({ accepted: 1, lines: [], terms: ['node'] })
    expect(repo!.projectForMain().terms).toEqual([{ term: 'node', translation: 'вузол' }])
    expect(other.projectForMain().terms).toEqual([{ term: 'node', translation: 'нода', proposed: true }])
  })

  it('assigns characters as proposals by default, sets them on request and creates missing ones', async () => {
    const { call, repo } = withBin()
    const proposed = await call('characters_assign', {
      items: [
        { line: 'L1', character: 'Bob', confidence: 0.8, reason: 'answers Bob' },
        { line: 'L6', character: 'Ada', confidence: 0.9, reason: 'same' },
        { line: 'nope', character: 'Ada', confidence: 0.9, reason: '' },
        { line: 'L2', character: 'Zed', confidence: 0.6, reason: 'new voice' },
      ],
    })
    expect(proposed.data.outcomes).toEqual([
      { line: 'L1', outcome: 'proposed' },
      { line: 'L6', outcome: 'unchanged' },
      { line: 'nope', outcome: 'error', reason: 'No line has key or id "nope"; call lines to list them' },
      { line: 'L2', outcome: 'error', reason: 'No character "Zed"; call characters to list them' },
    ])
    const project = repo!.projectForMain()
    expect(project.cues[0]).toMatchObject({ characterId: 'ada', proposals: { character: { characterId: 'bob', confidence: 0.8, reason: 'answers Bob' } } })
    const set = await call('characters_assign', { items: [{ line: 'L1', character: 'Zed', confidence: 1, reason: 'script' }], create: true, apply: 'set' })
    expect(set.data).toEqual({ outcomes: [{ line: 'L1', outcome: 'set' }], createdCharacters: ['Zed'] })
    expect(project.characters.find((c) => c.id === project.cues[0].characterId)?.name).toBe('Zed')
    expect(project.cues[0]).not.toHaveProperty('proposals')
  })

  it('lists, accepts, rejects and bulk-accepts proposals including glossary terms', async () => {
    const { call, repo } = withBin()
    const project = repo!.projectForMain()
    project.cues[0].proposals = { character: { characterId: 'bob', confidence: 0.9, reason: 'speaker in subs/demo.srt' } }
    project.cues[1].proposals = { character: { characterId: 'bob', confidence: 0.4, reason: 'guess' }, link: { assetId: 'srt', row: 1, confidence: 0.7, reason: 'text similarity 0.7' } }
    project.cues[3].suggestedText = 'Краще'
    await call('glossary', { upsert: [{ term: 'node', translation: 'вузол', proposed: true }, { term: 'pioneer', translation: 'піонер' }] })
    const listed = await call('proposals', { list: {} })
    expect(listed.data.total).toBe(5)
    expect(listed.data.items).toEqual([
      { kind: 'character', line: 'L1', id: 'c1', proposed: 'Bob', current: 'Ada', confidence: 0.9, reason: 'speaker in subs/demo.srt' },
      { kind: 'character', line: 'L2', id: 'c2', proposed: 'Bob', current: 'Ada', confidence: 0.4, reason: 'guess' },
      { kind: 'link', line: 'L2', id: 'c2', asset: 'subs/demo.srt', row: 1, sourceText: 'src c2', confidence: 0.7, reason: 'text similarity 0.7' },
      { kind: 'text', line: 'DUP', id: 'c4', proposed: 'Краще', current: 'one' },
      { kind: 'term', term: 'node', translation: 'вузол' },
    ])
    expect((await call('proposals', { list: { kind: 'character', minConfidence: 0.5 } })).data.total).toBe(1)
    const bulk = await call('proposals', { acceptAll: { kind: 'character', minConfidence: 0.5 } })
    expect(bulk.data).toEqual({ accepted: 1, lines: ['L1'] })
    expect(project.cues[0].characterId).toBe('bob')
    const rejected = await call('proposals', { reject: [{ kind: 'link', line: 'L2' }, { kind: 'text', line: 'L1' }, { kind: 'term', term: 'NODE' }] })
    expect(rejected.data).toEqual({ rejected: 2, lines: ['L2'], terms: ['node'], errors: [{ line: 'L1', reason: 'no pending text proposal' }] })
    expect(project.terms).toEqual([{ term: 'pioneer', translation: 'піонер' }])
    expect((await call('proposals', { accept: [{ kind: 'text', line: 'c4' }] })).data).toEqual({ accepted: 1, lines: ['DUP'] })
    expect(project.cues[3].text).toBe('Краще')
    expect((await call('proposals', { list: {}, acceptAll: { kind: 'text' } })).error).toBe('Invalid arguments: pass exactly one of list, accept, reject or acceptAll.')
  })
})
