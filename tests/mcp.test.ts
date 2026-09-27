import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import {
  createSession,
  defineTool,
  endSession,
  handleLine,
  handleMessage,
  MCP_PROTOCOL_VERSIONS,
  negotiateVersion,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  type McpServer,
  type McpSession,
  type RpcMessage,
} from '../src/shared/mcp'

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => (resolve = res))
  return { promise, resolve }
}

function server(extra: Partial<McpServer> = {}): { spec: McpServer; gate: ReturnType<typeof deferred>; writes: McpSession[] } {
  const gate = deferred()
  const writes: McpSession[] = []
  const spec: McpServer = {
    info: { name: 'vo-studio', version: '9.9.9' },
    instructions: 'Call status first.',
    beforeWrite: async (session) => {
      writes.push(session)
    },
    tools: [
      defineTool({
        name: 'echo',
        title: 'Echo',
        description: 'Echo a word.',
        input: z.object({ word: z.string().min(1), times: z.number().int().min(1).max(3).optional() }),
        annotations: READ,
        async run(_ctx, args) {
          return { structured: { said: args.word.repeat(args.times ?? 1) } }
        },
      }),
      defineTool({
        name: 'slow',
        title: 'Slow',
        description: 'Waits for the gate.',
        input: z.object({}),
        annotations: WRITE,
        async run(ctx) {
          ctx.progress(1, 2, 'halfway')
          await gate.promise
          if (ctx.signal.aborted) throw new Error('aborted')
          return { structured: { done: true } }
        },
      }),
      defineTool({
        name: 'boom',
        title: 'Boom',
        description: 'Always fails.',
        input: z.object({}),
        annotations: READ,
        async run() {
          throw new Error('No project is open; call project_open first.\n    at stack (file.ts:1:1)')
        },
      }),
      defineTool({
        name: 'picture',
        title: 'Picture',
        description: 'Returns an image.',
        input: z.object({}),
        annotations: READ,
        async run() {
          return { image: { data: 'iVBOR', mimeType: 'image/png' } }
        },
      }),
    ],
    ...extra,
  }
  return { spec, gate, writes }
}

async function exchange(spec: McpServer, message: unknown, session = createSession()): Promise<RpcMessage[]> {
  const sent: RpcMessage[] = []
  await handleMessage(spec, session, message, (m) => sent.push(m))
  return sent
}

const req = (id: number | string, method: string, params?: unknown): RpcMessage => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
})

describe('MCP initialize', () => {
  it('echoes a supported protocol version and describes the server', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'vo-studio', version: '9.9.9' },
        instructions: 'Call status first.',
      },
    })
  })

  it('answers the newest version when the client asks for an unknown one', () => {
    expect(negotiateVersion('2024-11-05')).toBe(MCP_PROTOCOL_VERSIONS[0])
    expect(negotiateVersion(undefined)).toBe('2025-11-25')
    for (const version of MCP_PROTOCOL_VERSIONS) expect(negotiateVersion(version)).toBe(version)
  })

  it('answers ping and ignores the initialized notification', async () => {
    const { spec } = server()
    expect(await exchange(spec, req('p', 'ping'))).toEqual([{ jsonrpc: '2.0', id: 'p', result: {} }])
    expect(await exchange(spec, { jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual([])
  })
})

describe('MCP tools/list', () => {
  it('lists every tool with an object input schema and explicit annotations', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(2, 'tools/list'))
    const tools = (reply.result as { tools: Record<string, unknown>[] }).tools
    expect(tools.map((t) => t.name)).toEqual(['echo', 'slow', 'boom', 'picture'])
    expect(tools[0]).toEqual({
      name: 'echo',
      title: 'Echo',
      description: 'Echo a word.',
      inputSchema: {
        type: 'object',
        properties: { word: { type: 'string', minLength: 1 }, times: { type: 'integer', minimum: 1, maximum: 3 } },
        required: ['word'],
      },
      annotations: { title: 'Echo', ...READ },
    })
    expect(tools[1].annotations).toEqual({ title: 'Slow', ...WRITE })
  })
})

describe('MCP tools/call', () => {
  it('returns structured content and the same JSON as text', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(3, 'tools/call', { name: 'echo', arguments: { word: 'ab', times: 2 } }))
    expect(reply.result).toEqual({
      content: [{ type: 'text', text: '{"said":"abab"}' }],
      structuredContent: { said: 'abab' },
    })
  })

  it('returns images as image content', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(3, 'tools/call', { name: 'picture' }))
    expect(reply.result).toEqual({ content: [{ type: 'image', data: 'iVBOR', mimeType: 'image/png' }] })
  })

  it('reports invalid arguments as a tool error, not a protocol error', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(4, 'tools/call', { name: 'echo', arguments: { word: '' } }))
    const result = reply.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Invalid arguments at "word": /)
  })

  it('reports a thrown error as one sentence without the stack', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(5, 'tools/call', { name: 'boom', arguments: {} }))
    expect(reply.result).toEqual({
      content: [{ type: 'text', text: 'No project is open; call project_open first.' }],
      isError: true,
    })
  })

  it('turns a thrown validation error into one sentence', async () => {
    const { spec } = server()
    const invalid = Object.assign(new Error('[\n  {"code": "custom"}\n]'), { issues: [{ path: [], message: 'Path is outside the projects root' }] })
    spec.tools.push({ ...spec.tools[2], name: 'strict', async run() { throw invalid } })
    const [reply] = await exchange(spec, req(5, 'tools/call', { name: 'strict' }))
    expect(reply.result).toEqual({ content: [{ type: 'text', text: 'Invalid arguments: Path is outside the projects root.' }], isError: true })
  })

  it('rejects an unknown tool with invalid params', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(6, 'tools/call', { name: 'nope' }))
    expect(reply.error).toEqual({ code: RPC_INVALID_PARAMS, message: 'Unknown tool: nope' })
  })

  it('runs the write hook before mutating tools only', async () => {
    const { spec, gate, writes } = server()
    const session = createSession()
    await exchange(spec, req(7, 'tools/call', { name: 'echo', arguments: { word: 'x' } }), session)
    expect(writes).toEqual([])
    gate.resolve()
    await exchange(spec, req(8, 'tools/call', { name: 'slow' }), session)
    expect(writes).toEqual([session])
  })

  it('lets a tool decide per call whether it writes', async () => {
    const { spec, writes } = server()
    spec.tools.push(
      defineTool({
        name: 'maybe',
        title: 'Maybe',
        description: 'Writes unless asked to list.',
        input: z.object({ list: z.boolean().optional() }),
        annotations: WRITE,
        writes: (args) => args.list !== true,
        async run() {
          return { structured: {} }
        },
      })
    )
    const session = createSession()
    await exchange(spec, req(11, 'tools/call', { name: 'maybe', arguments: { list: true } }), session)
    expect(writes).toEqual([])
    await exchange(spec, req(12, 'tools/call', { name: 'maybe', arguments: {} }), session)
    expect(writes).toEqual([session])
  })

  it('does not run a write that was cancelled while its guard was pending', async () => {
    const hold = deferred()
    const ran: string[] = []
    const { spec } = server({ beforeWrite: () => hold.promise })
    spec.tools.push(
      defineTool({
        name: 'mutate',
        title: 'Mutate',
        description: 'Records that it ran.',
        input: z.object({}),
        annotations: WRITE,
        async run() {
          ran.push('mutate')
          return { structured: {} }
        },
      })
    )
    const session = createSession()
    const sent: RpcMessage[] = []
    const call = handleMessage(spec, session, req(13, 'tools/call', { name: 'mutate' }), (m) => sent.push(m))
    await Promise.resolve()
    await handleMessage(spec, session, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 13 } }, (m) => sent.push(m))
    hold.resolve()
    await call
    expect(ran).toEqual([])
    expect(sent).toEqual([])
  })

  it('sends progress only when the request carries a progress token', async () => {
    const { spec, gate } = server()
    gate.resolve()
    const plain = await exchange(spec, req(9, 'tools/call', { name: 'slow' }))
    expect(plain).toHaveLength(1)
    const tracked = await exchange(spec, req(10, 'tools/call', { name: 'slow', _meta: { progressToken: 'tok' } }))
    expect(tracked[0]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok', progress: 1, total: 2, message: 'halfway' },
    })
    expect(tracked[1]).toMatchObject({ id: 10, result: { structuredContent: { done: true } } })
  })

  it('aborts a cancelled call and sends no response for it', async () => {
    const { spec, gate } = server()
    const session = createSession()
    const sent: RpcMessage[] = []
    const running = handleMessage(spec, session, req(11, 'tools/call', { name: 'slow' }), (m) => sent.push(m))
    await Promise.resolve()
    await Promise.resolve()
    expect(session.inflight.has(11)).toBe(true)
    await handleMessage(spec, session, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } }, (m) => sent.push(m))
    gate.resolve()
    await running
    expect(sent).toEqual([])
    expect(session.inflight.size).toBe(0)
  })

  it('aborts running calls when the session ends', async () => {
    const { spec, gate } = server()
    const session = createSession()
    const sent: RpcMessage[] = []
    const running = handleMessage(spec, session, req(12, 'tools/call', { name: 'slow' }), (m) => sent.push(m))
    await Promise.resolve()
    await Promise.resolve()
    endSession(session)
    gate.resolve()
    await running
    expect(sent).toEqual([])
  })
})

describe('MCP framing errors', () => {
  it('rejects unknown methods', async () => {
    const { spec } = server()
    const [reply] = await exchange(spec, req(13, 'resources/list'))
    expect(reply.error).toEqual({ code: RPC_METHOD_NOT_FOUND, message: 'Method not found: resources/list' })
  })

  it('rejects batches and malformed requests', async () => {
    const { spec } = server()
    expect((await exchange(spec, [req(1, 'ping')]))[0]).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC_INVALID_REQUEST, message: 'Batches are not supported' },
    })
    expect((await exchange(spec, { jsonrpc: '1.0', id: 3, method: 'ping' }))[0]).toMatchObject({ id: 3, error: { code: RPC_INVALID_REQUEST } })
    expect((await exchange(spec, { jsonrpc: '2.0', id: 4 }))[0]).toMatchObject({ id: 4, error: { code: RPC_INVALID_REQUEST } })
    expect((await exchange(spec, { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }))[0]).toMatchObject({ id: null, error: { code: RPC_INVALID_REQUEST } })
    expect((await exchange(spec, 42))[0]).toMatchObject({ id: null, error: { code: RPC_INVALID_REQUEST } })
  })

  it('ignores responses sent by the client', async () => {
    const { spec } = server()
    expect(await exchange(spec, { jsonrpc: '2.0', id: 1, result: {} })).toEqual([])
  })

  it('answers unparsable lines with a parse error', async () => {
    const { spec } = server()
    const sent: RpcMessage[] = []
    await handleLine(spec, createSession(), '{"jsonrpc":', (m) => sent.push(m))
    expect(sent).toEqual([{ jsonrpc: '2.0', id: null, error: { code: RPC_PARSE_ERROR, message: 'Parse error' } }])
  })
})

describe('MCP prompts', () => {
  const prompts = [
    {
      name: 'greet',
      title: 'Greet',
      description: 'Greets someone.',
      arguments: [
        { name: 'who', description: 'Who to greet', required: true },
        { name: 'tone', description: 'Tone', required: false, values: ['warm', 'dry'] },
      ],
      text: (a: Record<string, string>) => `Greet ${a.who} ${a.tone ?? 'warm'}ly.`,
    },
  ]

  it('advertises prompts only when the server has them', async () => {
    const plain = (await exchange(server().spec, req(1, 'initialize', {})))[0].result as { capabilities: unknown }
    expect(plain.capabilities).toEqual({ tools: {} })
    const withPrompts = (await exchange(server({ prompts }).spec, req(1, 'initialize', {})))[0].result as { capabilities: unknown }
    expect(withPrompts.capabilities).toEqual({ tools: {}, prompts: {} })
    expect((await exchange(server().spec, req(2, 'prompts/list')))[0]).toMatchObject({ error: { code: RPC_METHOD_NOT_FOUND } })
  })

  it('lists prompts with their arguments', async () => {
    const [reply] = await exchange(server({ prompts }).spec, req(1, 'prompts/list'))
    expect(reply.result).toEqual({
      prompts: [
        {
          name: 'greet',
          title: 'Greet',
          description: 'Greets someone.',
          arguments: [
            { name: 'who', description: 'Who to greet', required: true },
            { name: 'tone', description: 'Tone', required: false },
          ],
        },
      ],
    })
  })

  it('renders a prompt as one user message with trimmed arguments', async () => {
    const [reply] = await exchange(server({ prompts }).spec, req(1, 'prompts/get', { name: 'greet', arguments: { who: ' Ann ', tone: 'dry' } }))
    expect(reply.result).toEqual({
      description: 'Greets someone.',
      messages: [{ role: 'user', content: { type: 'text', text: 'Greet Ann dryly.' } }],
    })
    const [fallback] = await exchange(server({ prompts }).spec, req(2, 'prompts/get', { name: 'greet', arguments: { who: 'Bob', tone: '' } }))
    expect(fallback.result).toMatchObject({ messages: [{ content: { text: 'Greet Bob warmly.' } }] })
  })

  it('rejects unknown prompts and invalid arguments with invalid params', async () => {
    const { spec } = server({ prompts })
    const error = async (params: unknown) => (await exchange(spec, req(1, 'prompts/get', params)))[0].error
    expect(await error({ name: 'nope' })).toEqual({ code: RPC_INVALID_PARAMS, message: 'Unknown prompt: nope' })
    expect(await error({ name: 'greet' })).toEqual({ code: RPC_INVALID_PARAMS, message: 'Missing required argument: who' })
    expect(await error({ name: 'greet', arguments: { who: '  ' } })).toEqual({ code: RPC_INVALID_PARAMS, message: 'Missing required argument: who' })
    expect(await error({ name: 'greet', arguments: { who: 3 } })).toEqual({ code: RPC_INVALID_PARAMS, message: 'Argument who must be a string' })
    expect(await error({ name: 'greet', arguments: { who: 'Ann', tone: 'loud' } })).toEqual({
      code: RPC_INVALID_PARAMS,
      message: 'Argument tone must be one of warm, dry',
    })
  })
})
