import net from 'net'
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { promises as fs, rmSync } from 'fs'
import path from 'path'
import { agentEndpoint, AGENT_TOKEN_FILE } from '@shared/agent-endpoint'
import { createSession, endSession, handleLine, type McpServer, type RpcMessage } from '@shared/mcp'

const TOKEN_LINE_MAX = 256
const AUTH_TIMEOUT_MS = 5000
const LINE_MAX = 32 * 1024 * 1024

export interface AgentServerHandle {
  stop: () => Promise<void>
}

const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

function sameToken(line: string, token: string): boolean {
  const given = Buffer.from(line.trim())
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const reachable = (endpoint: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.connect(endpoint)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })

async function clearStaleSocket(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return
  const present = await fs.stat(endpoint).then(() => true, () => false)
  if (present && !(await reachable(endpoint))) await fs.rm(endpoint, { force: true })
}

function serve(socket: net.Socket, token: string, server: McpServer): void {
  socket.setEncoding('utf8')
  const session = createSession()
  let authed = false
  let buffer = ''
  const timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS)
  const send = (message: RpcMessage): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
  }
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!authed) {
        if (!sameToken(line, token)) {
          socket.destroy()
          return
        }
        authed = true
        clearTimeout(timer)
      } else if (line.trim()) void handleLine(server, session, line, send).catch(() => undefined)
    }
    if (buffer.length > (authed ? LINE_MAX : TOKEN_LINE_MAX)) socket.destroy()
  })
  socket.on('error', () => undefined)
  socket.on('close', () => {
    clearTimeout(timer)
    endSession(session)
  })
}

export async function startAgentServer(userData: string, server: McpServer): Promise<AgentServerHandle> {
  const endpoint = agentEndpoint(process.platform, userData, sha256Hex)
  const tokenFile = path.join(userData, AGENT_TOKEN_FILE)
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<net.Socket>()
  const listener = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    serve(socket, token, server)
  })
  await clearStaleSocket(endpoint)
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(endpoint, () => {
      listener.off('error', reject)
      resolve()
    })
  })
  await fs.rm(tokenFile, { force: true })
  await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 })
  return {
    stop: () => {
      for (const socket of sockets) socket.destroy()
      const closed = new Promise<void>((resolve) => listener.close(() => resolve()))
      try {
        rmSync(tokenFile, { force: true })
      } catch (error) {
        console.error('agent token cleanup:', error)
      }
      return closed
    },
  }
}
