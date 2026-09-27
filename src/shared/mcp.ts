import { z } from 'zod/v4'

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26']

export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603

export type RpcId = string | number
export type RpcMessage = Record<string, unknown>

export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface McpSession {
  inflight: Map<RpcId, AbortController>
}

export interface ToolContext {
  session: McpSession
  signal: AbortSignal
  progress: (progress: number, total?: number, message?: string) => void
}

export interface ToolImage {
  data: string
  mimeType: string
}

export type ToolOutput = { structured: Record<string, unknown>; image?: ToolImage } | { image: ToolImage }

export interface McpTool<I extends z.ZodType = z.ZodType> {
  name: string
  title: string
  description: string
  input: I
  annotations: ToolAnnotations
  writes?: (args: z.output<I>) => boolean
  run(ctx: ToolContext, args: z.output<I>): Promise<ToolOutput>
}

export interface McpPromptArgument {
  name: string
  description: string
  required: boolean
  values?: readonly string[]
}

export interface McpPrompt {
  name: string
  title: string
  description: string
  arguments: McpPromptArgument[]
  text(args: Record<string, string>): string
}

export interface McpServer {
  info: { name: string; version: string }
  instructions: string
  tools: McpTool[]
  prompts?: McpPrompt[]
  beforeWrite?: (session: McpSession) => Promise<void>
}

type Send = (message: RpcMessage) => void

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

export const defineTool = <I extends z.ZodType>(tool: McpTool<I>): McpTool<I> => tool

export const createSession = (): McpSession => ({ inflight: new Map() })

export function endSession(session: McpSession): void {
  for (const controller of session.inflight.values()) controller.abort()
  session.inflight.clear()
}

const isId = (value: unknown): value is RpcId =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const failure = (id: RpcId | null, code: number, message: string): RpcMessage => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
})

export const negotiateVersion = (requested: unknown): string =>
  typeof requested === 'string' && MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0]

export function errorText(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues
  if (Array.isArray(issues)) return issueText(issues)
  const text = (error instanceof Error ? error.message : String(error)).split('\n')[0].trim()
  return text || 'The tool failed without a message.'
}

export function issueText(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  const issue = issues[0]
  if (!issue) return 'Invalid arguments.'
  const where = issue.path.map(String).join('.')
  return `Invalid arguments${where ? ` at "${where}"` : ''}: ${issue.message}.`
}

export function listedTool(tool: McpTool): RpcMessage {
  const { $schema: _dropped, ...inputSchema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema,
    annotations: { title: tool.title, ...tool.annotations },
  }
}

function listedPrompt(prompt: McpPrompt): RpcMessage {
  return {
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments.map(({ name, description, required }) => ({ name, description, required })),
  }
}

function getPrompt(prompts: McpPrompt[], params: unknown): RpcMessage {
  const p = record(params)
  const prompt = prompts.find((item) => item.name === p.name)
  if (!prompt) throw new RpcError(RPC_INVALID_PARAMS, `Unknown prompt: ${String(p.name)}`)
  const given = record(p.arguments)
  const args: Record<string, string> = {}
  for (const arg of prompt.arguments) {
    const value = given[arg.name]
    if (value !== undefined && typeof value !== 'string') throw new RpcError(RPC_INVALID_PARAMS, `Argument ${arg.name} must be a string`)
    const text = value?.trim() ?? ''
    if (!text && arg.required) throw new RpcError(RPC_INVALID_PARAMS, `Missing required argument: ${arg.name}`)
    if (text && arg.values && !arg.values.includes(text)) {
      throw new RpcError(RPC_INVALID_PARAMS, `Argument ${arg.name} must be one of ${arg.values.join(', ')}`)
    }
    if (text) args[arg.name] = text
  }
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args) } }],
  }
}

const errorResult = (text: string): RpcMessage => ({ content: [{ type: 'text', text }], isError: true })

function toolResult(output: ToolOutput): RpcMessage {
  if (!('structured' in output)) return { content: [{ type: 'image', ...output.image }] }
  return {
    content: [{ type: 'text', text: JSON.stringify(output.structured) }, ...(output.image ? [{ type: 'image', ...output.image }] : [])],
    structuredContent: output.structured,
  }
}

function notify(session: McpSession, method: string, params: unknown): void {
  if (method !== 'notifications/cancelled') return
  const id = record(params).requestId
  if (isId(id)) session.inflight.get(id)?.abort()
}

async function callTool(server: McpServer, session: McpSession, id: RpcId, params: unknown, send: Send): Promise<RpcMessage | null> {
  const p = record(params)
  const tool = server.tools.find((item) => item.name === p.name)
  if (!tool) throw new RpcError(RPC_INVALID_PARAMS, `Unknown tool: ${String(p.name)}`)
  const parsed = tool.input.safeParse(p.arguments ?? {})
  if (!parsed.success) return errorResult(issueText(parsed.error.issues))
  const controller = new AbortController()
  session.inflight.set(id, controller)
  const token = record(p._meta).progressToken
  const progress = (value: number, total?: number, message?: string): void => {
    if (!isId(token) || controller.signal.aborted) return
    send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: token, progress: value, ...(total === undefined ? {} : { total }), ...(message ? { message } : {}) },
    })
  }
  try {
    if (tool.writes ? tool.writes(parsed.data) : !tool.annotations.readOnlyHint) await server.beforeWrite?.(session)
    if (controller.signal.aborted) return null
    const output = await tool.run({ session, signal: controller.signal, progress }, parsed.data)
    return controller.signal.aborted ? null : toolResult(output)
  } catch (error) {
    return controller.signal.aborted ? null : errorResult(errorText(error))
  } finally {
    if (session.inflight.get(id) === controller) session.inflight.delete(id)
  }
}

async function request(server: McpServer, session: McpSession, id: RpcId, method: string, params: unknown, send: Send): Promise<RpcMessage | null> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: negotiateVersion(record(params).protocolVersion),
        capabilities: { tools: {}, ...(server.prompts ? { prompts: {} } : {}) },
        serverInfo: server.info,
        instructions: server.instructions,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: server.tools.map(listedTool) }
    case 'tools/call':
      return callTool(server, session, id, params, send)
    case 'prompts/list':
      if (server.prompts) return { prompts: server.prompts.map(listedPrompt) }
      break
    case 'prompts/get':
      if (server.prompts) return getPrompt(server.prompts, params)
      break
  }
  throw new RpcError(RPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
}

export async function handleMessage(server: McpServer, session: McpSession, message: unknown, send: Send): Promise<void> {
  if (Array.isArray(message)) return send(failure(null, RPC_INVALID_REQUEST, 'Batches are not supported'))
  const m = record(message)
  const id = isId(m.id) ? m.id : null
  if (m.method === undefined && ('result' in m || 'error' in m)) return
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string' || ('id' in m && id === null)) {
    return send(failure(id, RPC_INVALID_REQUEST, 'Invalid request'))
  }
  if (id === null) return notify(session, m.method, m.params)
  try {
    const result = await request(server, session, id, m.method, m.params, send)
    if (result) send({ jsonrpc: '2.0', id, result })
  } catch (error) {
    send(error instanceof RpcError ? failure(id, error.code, error.message) : failure(id, RPC_INTERNAL_ERROR, errorText(error)))
  }
}

export function handleLine(server: McpServer, session: McpSession, line: string, send: Send): Promise<void> {
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    send(failure(null, RPC_PARSE_ERROR, 'Parse error'))
    return Promise.resolve()
  }
  return handleMessage(server, session, message, send)
}
