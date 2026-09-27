import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { agentTools, AGENT_INSTRUCTIONS, type AgentDeps } from '../src/main/agent/tools'
import { agentPrompts } from '../src/main/agent/prompts'
import { splitArgs } from '../src/main/bridge'
import { LINE_FILTERS } from '../src/shared/agent-lines'

const toolNames = agentTools({} as AgentDeps).map((t) => t.name)
const docs = readFileSync(path.join(__dirname, '..', 'docs', 'agent.md'), 'utf8')

function section(heading: string): string {
  const start = docs.indexOf(`\n## ${heading}\n`)
  expect(start).toBeGreaterThan(-1)
  const end = docs.indexOf('\n## ', start + 1)
  return docs.slice(start, end < 0 ? undefined : end)
}

const listed = (text: string): string[] => [...text.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1])

describe('agent docs', () => {
  it('lists exactly the registered tools', () => {
    const documented = listed(section('Tools'))
    expect([...documented].sort()).toEqual([...toolNames].sort())
    expect(new Set(documented).size).toBe(documented.length)
  })

  it('lists exactly the registered prompts', () => {
    expect(listed(section('Prompts')).sort()).toEqual(agentPrompts.map((p) => p.name).sort())
  })
})

describe('agent prompts', () => {
  const texts = agentPrompts.map((p) =>
    p.text(Object.fromEntries(p.arguments.map((a) => [a.name, a.values ? a.values[0] : `<${a.name}>`])))
  )

  it('name only registered tools', () => {
    for (const text of texts) {
      const named = [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
      expect(named.length).toBeGreaterThan(0)
      expect(named.filter((n) => !toolNames.includes(n))).toEqual([])
    }
  })

  it('fill in their arguments', () => {
    const localize = agentPrompts.find((p) => p.name === 'localize')
    expect(localize?.text({ folder: '/data/vo', targetLanguage: 'Ukrainian' })).toMatch(/^Localize the voice-over in \/data\/vo into Ukrainian/)
    const voice = agentPrompts.find((p) => p.name === 'voice_lines')
    expect(voice?.arguments[0].values).toEqual(LINE_FILTERS)
    expect(voice?.text({})).toContain('filter notgen')
    expect(voice?.text({ filter: 'review' })).toContain('`generate` with filter review')
  })

  it('are mentioned in the server instructions', () => {
    for (const prompt of agentPrompts) expect(AGENT_INSTRUCTIONS).toContain(prompt.name)
  })
})

describe('bridge arguments', () => {
  it('takes out the user data dir and the headless flag', () => {
    expect(splitArgs(['--headless', '--user-data-dir', '/tmp/ud', 'call', 'status'])).toEqual({ userData: '/tmp/ud', headless: true, rest: ['call', 'status'] })
    expect(splitArgs(['--user-data-dir=/tmp/ud', 'stop'])).toEqual({ userData: '/tmp/ud', headless: false, rest: ['stop'] })
    expect(splitArgs([])).toEqual({ headless: false, rest: [] })
  })
})
