import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridge = path.join(root, 'out', 'main', 'bridge.js')
const TOKEN_WAIT_MS = 30_000
const LINES = [
  { dir: 'scene1', id: 'hello', en: 'Hello there traveller.', uk: 'Привіт мандрівнику.' },
  { dir: 'scene1', id: 'bye', en: 'See you soon.', uk: 'До зустрічі.' },
  { dir: 'scene2', id: 'door', en: 'The door is locked.', uk: 'Двері замкнені.' },
]

const work = mkdtempSync(path.join(os.tmpdir(), 'vostudio-e2e-'))
const userData = path.join(work, 'user-data')
const projects = path.join(work, 'projects')
const fixture = path.join(work, 'fixture')
const logFile = path.join(work, 'app.log')
let app = null

function cleanup() {
  if (app && app.exitCode === null && app.signalCode === null) {
    try {
      process.kill(-app.pid, 'SIGKILL')
    } catch {
      app.kill('SIGKILL')
    }
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5 })
}

function fail(message) {
  process.stderr.write(`agent-e2e: FAIL ${message}\n`)
  if (existsSync(logFile)) process.stderr.write(`--- app log tail ---\n${readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n')}\n`)
  cleanup()
  process.exit(1)
}

function check(condition, message) {
  if (!condition) fail(message)
}

const step = (message) => process.stdout.write(`agent-e2e: ${message}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tool(name, args = {}) {
  try {
    const out = execFileSync(process.execPath, [bridge, '--user-data-dir', userData, 'call', name, JSON.stringify(args)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    return JSON.parse(out)
  } catch (error) {
    fail(`${name} ${JSON.stringify(args)}: ${String(error.stderr || error.message).trim()}`)
  }
}

function makeFixture() {
  const ffmpeg = require('ffmpeg-static')
  for (const [i, line] of LINES.entries()) {
    mkdirSync(path.join(fixture, 'audio', line.dir), { recursive: true })
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${330 + i * 110}:duration=3`,
      '-ar', '44100', '-ac', '1', path.join(fixture, 'audio', line.dir, `${line.id}.wav`),
    ])
  }
  writeFileSync(path.join(fixture, 'script.csv'), ['id,en,uk', ...LINES.map((l) => `${l.id},${l.en},${l.uk}`)].join('\n') + '\n')
}

async function launch() {
  mkdirSync(userData, { recursive: true })
  mkdirSync(projects, { recursive: true })
  const env = { ...process.env, VOSTUDIO_PROVIDER: 'mock', VOSTUDIO_PROJECTS_ROOT: projects, ELECTRON_ENABLE_LOGGING: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const log = openSync(logFile, 'a')
  app = spawn(require('electron'), [path.join(root, 'out', 'main', 'index.js'), '--headless', '--no-sandbox', `--user-data-dir=${userData}`], {
    cwd: work,
    env,
    detached: true,
    stdio: ['ignore', log, log],
  })
  app.once('exit', (code, signal) => {
    if (!quitting) fail(`the app exited early (code ${code}, signal ${signal})`)
  })
  const deadline = Date.now() + TOKEN_WAIT_MS
  while (!existsSync(path.join(userData, 'agent-token'))) {
    check(Date.now() < deadline, 'the app did not write its agent token within 30 s')
    await sleep(200)
  }
}

let quitting = false

async function run() {
  makeFixture()
  await launch()
  const n = LINES.length

  const status = tool('status')
  check(status.provider === 'mock' && status.mode === 'headless', `status: ${JSON.stringify(status)}`)
  step(`status ok: provider ${status.provider}, mode ${status.mode}`)

  const opened = tool('project_open', { create: 'Agent E2E' })
  check(opened.project?.name === 'Agent E2E', `project_open: ${JSON.stringify(opened)}`)

  const added = tool('asset_add', { paths: [path.join(fixture, 'audio'), path.join(fixture, 'script.csv')] })
  check(added.added === n + 1, `asset_add added ${added.added}, expected ${n + 1}`)

  const built = tool('lines_build', { strategy: 'perFile' })
  check(built.created === n, `lines_build created ${built.created}, expected ${n}`)

  const linked = tool('link', { asset: 'script.csv', strategy: 'key', apply: true })
  check(linked.linked === n && linked.suggestions === n, `link: ${JSON.stringify(linked)}`)
  step(`bin and lines ok: ${added.added} assets, ${built.created} lines, ${linked.linked} linked`)

  const accepted = tool('proposals', { acceptAll: { kind: 'text' } })
  check(accepted.accepted === n, `proposals accepted ${accepted.accepted}, expected ${n}`)

  const voice = tool('voices').voices?.[0]?.id
  check(Boolean(voice), 'voices returned no voice')
  tool('character_set', { create: 'Narrator', voiceId: voice })
  const lines = tool('lines', { filter: 'all', limit: 100 }).rows
  check(lines.length === n, `lines returned ${lines.length}, expected ${n}`)
  const assigned = tool('characters_assign', {
    items: lines.map((l) => ({ line: l.key, character: 'Narrator', confidence: 1, reason: 'e2e' })),
    apply: 'set',
  })
  check(assigned.outcomes.every((o) => o.outcome === 'set'), `characters_assign: ${JSON.stringify(assigned.outcomes)}`)

  const plan = tool('generate', { filter: 'all', dryRun: true })
  check(plan.totals.lines === n && plan.totals.skipped === 0, `generate dryRun: ${JSON.stringify(plan.totals)}`)
  const expectedTexts = new Set(LINES.map((l) => l.uk))
  check(plan.lines.every((l) => expectedTexts.has(l.text)), `generate dryRun texts: ${JSON.stringify(plan.lines.map((l) => l.text))}`)
  let jobs = tool('generate', { filter: 'all', wait: 45 }).jobs
  for (let i = 0; i < 4 && jobs.some((j) => j.state === 'queued' || j.state === 'running'); i++) {
    jobs = tool('jobs', { ids: jobs.map((j) => j.id), wait: 45 }).jobs
  }
  check(jobs.length === n && jobs.every((j) => j.state === 'done' && !j.error), `generate jobs: ${JSON.stringify(jobs)}`)
  step(`generate ok: ${plan.totals.chars} characters, ${jobs.length} jobs done`)

  const render = tool('render', { line: lines[0].key, withOriginal: true })
  const metrics = render.metrics
  check(render.source === 'output' && metrics.duration > 0 && Number.isFinite(metrics.lufs), `render: ${JSON.stringify(render)}`)
  check(existsSync(render.path), `render file missing: ${render.path}`)
  step(`render ok: ${render.line} ${metrics.duration.toFixed(2)} s, ${metrics.lufs.toFixed(1)} LUFS, original ${render.original?.metrics.duration.toFixed(2)} s`)

  const compared = tool('compare', { line: lines[0].key })
  check(Number.isFinite(compared.rhythm) && Number.isFinite(compared.intonation) && Array.isArray(compared.suggestions), `compare: ${JSON.stringify(compared)}`)
  step(`compare ok: rhythm ${compared.rhythm}, intonation ${compared.intonation}, ${compared.suggestions.length} suggestions`)

  const dry = tool('export', { filter: 'all', dryRun: true })
  check(dry.ready === n && dry.skippedTotal === 0, `export dryRun: ${JSON.stringify(dry)}`)
  const exported = tool('export', { filter: 'all' })
  check(exported.written === n && exported.failed.length === 0 && exported.skippedTotal === 0, `export: ${JSON.stringify(exported)}`)
  const files = dry.files.map((f) => path.join(exported.outDir, f.name))
  const missing = files.filter((f) => !existsSync(f))
  check(missing.length === 0, `exported files missing: ${missing.join(', ')} (folder has ${readdirSync(exported.outDir, { recursive: true }).join(', ')})`)
  step(`export ok: ${exported.written} files in ${exported.outDir}`)

  const entries = tool('diagnostics').entries
  check(entries.length === 0, `diagnostics: ${JSON.stringify(entries)}`)

  quitting = true
  const exited = new Promise((resolve) => app.once('exit', resolve))
  try {
    execFileSync(process.execPath, [bridge, '--user-data-dir', userData, 'stop'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
  } catch (error) {
    fail(`stop: ${String(error.stderr || error.message).trim()}`)
  }
  const code = await Promise.race([exited, sleep(15_000).then(() => 'timeout')])
  check(code === 0, `the app did not quit cleanly after stop (${code})`)
  step('diagnostics clean, app quit')
}

process.on('SIGINT', () => fail('interrupted'))
process.on('SIGTERM', () => fail('terminated'))
run().then(
  () => {
    cleanup()
    step('PASS')
  },
  (error) => fail(error instanceof Error ? error.stack : String(error))
)
