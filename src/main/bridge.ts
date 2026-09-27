import net from 'net'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'

const TOKEN_FILE = 'agent-token'
const SOCKET_FILE = 'agent.sock'
const APP_NAMES = ['VO Studio', 'vo-studio']
const LAUNCH_WAIT_MS = 20_000
const RETRY_MS = 500
const USER_DATA_FLAG = '--user-data-dir'

type Message = Record<string, unknown>

const log = (message: string): void => {
  process.stderr.write(`vostudio-mcp: ${message}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function appDataDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')
}

function splitArgs(argv: string[]): { userData?: string; rest: string[] } {
  const rest: string[] = []
  let userData: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === USER_DATA_FLAG) userData = argv[++i]
    else if (arg.startsWith(`${USER_DATA_FLAG}=`)) userData = arg.slice(USER_DATA_FLAG.length + 1)
    else rest.push(arg)
  }
  return { userData, rest }
}

export function endpointFor(platform: string, userData: string): string {
  if (platform !== 'win32') return `${userData.replace(/\/+$/, '')}/${SOCKET_FILE}`
  return `\\\\.\\pipe\\vostudio-${createHash('sha256').update(userData.toLowerCase()).digest('hex').slice(0, 16)}`
}

function readToken(userData: string): string | null {
  try {
    return readFileSync(path.join(userData, TOKEN_FILE), 'utf8').trim() || null
  } catch {
    return null
  }
}

const connect = (userData: string, token: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(endpointFor(process.platform, userData))
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      socket.write(`${token}\n`)
      resolve(socket)
    })
  })

async function tryConnect(candidates: string[]): Promise<net.Socket | null> {
  for (const userData of candidates) {
    const token = readToken(userData)
    if (!token) continue
    try {
      return await connect(userData, token)
    } catch {
      continue
    }
  }
  return null
}

function electronBinary(root: string): string {
  const dir = path.join(root, 'node_modules', 'electron')
  return path.join(dir, 'dist', readFileSync(path.join(dir, 'path.txt'), 'utf8').trim())
}

function launchApp(userData: string | undefined): void {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const flags = [...(userData ? [`${USER_DATA_FLAG}=${userData}`] : []), '--agent']
  const packaged = __dirname.includes('app.asar')
  const root = path.resolve(__dirname, '..', '..')
  const command = packaged || process.versions.electron ? process.execPath : electronBinary(root)
  const args = packaged ? flags : [root, ...flags]
  spawn(command, args, { detached: true, stdio: 'ignore', env }).unref()
}

async function reach(candidates: string[], userData: string | undefined): Promise<net.Socket> {
  const running = await tryConnect(candidates)
  if (running) return running
  log('VO Studio is not reachable, starting it')
  launchApp(userData)
  const deadline = Date.now() + LAUNCH_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(RETRY_MS)
    const socket = await tryConnect(candidates)
    if (socket) return socket
  }
  throw new Error('VO Studio did not open its agent connection within 20 s; open the app and turn on Settings > Agent access')
}

function proxy(socket: net.Socket): void {
  socket.on('close', () => process.stdin.destroy())
  socket.on('error', (error) => log(error.message))
  socket.pipe(process.stdout)
  process.stdin.pipe(socket)
}

function rpc(socket: net.Socket): (method: string, params: Message, notify?: boolean) => Promise<Message> {
  const waiting = new Map<number, (message: Message) => void>()
  let next = 0
  readline.createInterface({ input: socket }).on('line', (line) => {
    const message = JSON.parse(line) as Message
    if (typeof message.id === 'number') waiting.get(message.id)?.(message)
  })
  socket.on('close', () => {
    for (const settle of waiting.values()) settle({ error: { message: 'VO Studio closed the connection' } })
  })
  return (method, params, notify = false) => {
    if (notify) {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
      return Promise.resolve({})
    }
    const id = ++next
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve) => waiting.set(id, resolve))
  }
}

async function call(socket: net.Socket, tool: string | undefined, json: string | undefined): Promise<number> {
  if (!tool) throw new Error('usage: vostudio-mcp call <tool> [json-arguments]')
  const args = json ? (JSON.parse(json) as Message) : {}
  const send = rpc(socket)
  const init = await send('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'vostudio-mcp', version: '1' },
  })
  if (init.error) throw new Error(String((init.error as Message).message))
  await send('notifications/initialized', {}, true)
  const reply = await send('tools/call', { name: tool, arguments: args })
  socket.destroy()
  if (reply.error) throw new Error(String((reply.error as Message).message))
  const result = reply.result as { content: Message[]; structuredContent?: unknown; isError?: boolean }
  if (result.isError) {
    log(result.content.map((c) => String(c.text ?? '')).join('\n'))
    return 1
  }
  const image = result.content.find((c) => c.type === 'image')
  if (image) {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'vostudio-mcp-')), `${tool}.png`)
    writeFileSync(file, Buffer.from(String(image.data), 'base64'))
    process.stdout.write(`${file}\n`)
    return 0
  }
  process.stdout.write(`${JSON.stringify(result.structuredContent ?? null, null, 2)}\n`)
  return 0
}

async function main(): Promise<void> {
  const { userData, rest } = splitArgs(process.argv.slice(2))
  const explicit = userData ?? process.env.VOSTUDIO_USER_DATA
  const candidates = explicit ? [path.resolve(explicit)] : APP_NAMES.map((name) => path.join(appDataDir(), name))
  const socket = await reach(candidates, explicit && path.resolve(explicit))
  if (rest[0] === 'call') process.exitCode = await call(socket, rest[1], rest[2])
  else proxy(socket)
}

if (require.main === module) {
  main().catch((error: unknown) => {
    log(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
