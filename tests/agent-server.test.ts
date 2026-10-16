import net from 'net'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { mkdtempSync, promises as fs, statSync, writeFileSync } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { createHash } from 'crypto'
import { startAgentServer, type AgentServerHandle } from '../src/main/agent/server'
import { agentEndpoint } from '../src/shared/agent-endpoint'
import { tryConnect } from '../src/main/bridge'
import { defineTool, type McpServer } from '../src/shared/mcp'

const spec: McpServer = {
  info: { name: 'vo-studio', version: '0.0.0' },
  instructions: '',
  tools: [
    defineTool({
      name: 'hello',
      title: 'Hello',
      description: 'Says hello.',
      input: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run() {
        return { structured: { hello: true } }
      },
    }),
  ],
}

const posix = process.platform !== 'win32'
const endpointOf = (dir: string): string =>
  agentEndpoint(process.platform, dir, (text) => createHash('sha256').update(text).digest('hex'))

const dirs: string[] = []
const running: AgentServerHandle[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const handle of running.splice(0)) await handle.stop()
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function start(): Promise<{ dir: string; token: string; sock: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-agent-'))
  dirs.push(dir)
  running.push(await startAgentServer(dir, spec))
  return { dir, token: (await fs.readFile(path.join(dir, 'agent-token'), 'utf8')).trim(), sock: endpointOf(dir) }
}

function client(sock: string, first: string): { lines: AsyncIterator<string>; socket: net.Socket; closed: Promise<void> } {
  const socket = net.connect(sock)
  socket.write(`${first}\n`)
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  return { socket, closed, lines: readline.createInterface({ input: socket })[Symbol.asyncIterator]() }
}

const accepts = (sock: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.connect(sock)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })

describe('agent socket server', () => {
  it('writes a private 32-byte token and answers MCP after it', async () => {
    const { dir, token, sock } = await start()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    if (posix) expect(statSync(path.join(dir, 'agent-token')).mode & 0o777).toBe(0o600)
    const a = client(sock, token)
    const b = client(sock, token)
    a.socket.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello"}}\n')
    b.socket.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n')
    expect(JSON.parse((await a.lines.next()).value)).toMatchObject({ id: 1, result: { structuredContent: { hello: true } } })
    expect(JSON.parse((await b.lines.next()).value)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    a.socket.destroy()
    b.socket.destroy()
  })

  it('closes connections that open with a wrong token', async () => {
    const { sock } = await start()
    const bad = client(sock, 'f'.repeat(64))
    bad.socket.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    await bad.closed
    expect((await bad.lines.next()).done).toBe(true)
  })

  it('replaces a stale socket file and removes token and socket on stop', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-agent-'))
    dirs.push(dir)
    if (posix) writeFileSync(endpointOf(dir), '')
    const handle = await startAgentServer(dir, spec)
    await handle.stop()
    await expect(fs.stat(path.join(dir, 'agent-token'))).rejects.toThrow()
    if (posix) await expect(fs.stat(endpointOf(dir))).rejects.toThrow()
  })

  it('puts the fresh token on disk before the endpoint accepts connections', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vostudio-agent-'))
    dirs.push(dir)
    const sock = endpointOf(dir)
    const write = fs.writeFile
    const acceptingAtWrite: boolean[] = []
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      acceptingAtWrite.push(await accepts(sock))
      return write(...args)
    })
    running.push(await startAgentServer(dir, spec))
    expect(acceptingAtWrite).toEqual([false])
  })

  it('lets the bridge return only a connection the server authorized', async () => {
    const { dir, token } = await start()
    writeFileSync(path.join(dir, 'agent-token'), `${'f'.repeat(64)}\n`)
    expect(await tryConnect([dir])).toBeNull()
    writeFileSync(path.join(dir, 'agent-token'), `${token}\n`)
    const socket = await tryConnect([dir])
    expect(socket).not.toBeNull()
    const lines = readline.createInterface({ input: socket! })[Symbol.asyncIterator]()
    socket!.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n')
    expect(JSON.parse((await lines.next()).value)).toEqual({ jsonrpc: '2.0', id: 7, result: {} })
    socket!.destroy()
  })
})
