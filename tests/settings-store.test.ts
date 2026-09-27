import { mkdirSync, promises as fs } from 'fs'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => ({
  root: `${process.env['TEMP'] ?? process.env['TMPDIR'] ?? '/tmp'}/vostudio-settings-${Date.now()}`,
}))

vi.mock('electron', () => ({ app: { getPath: () => H.root } }))

mkdirSync(H.root, { recursive: true })

const store = await import('../src/main/project-store')
const { appSettingsSchema } = await import('../src/main/schemas')
const { AGENT_BUDGET_DEFAULT, DEFAULT_APP_SETTINGS, agentBudget, sanitizeAgentAccess, sanitizeAgentBudget } = await import('../src/shared/ipc')

const writeState = (settings: unknown): Promise<void> =>
  fs.writeFile(path.join(H.root, 'app.json'), JSON.stringify({ settings }))

describe('stored settings', () => {
  it('returns valid settings as stored', async () => {
    await writeState({ countIn: false, autoReference: true, recordLatencyMs: 120, punchPrerollSeconds: 2.5 })
    expect(await store.getSettings()).toEqual({ countIn: false, autoReference: true, recordLatencyMs: 120, punchPrerollSeconds: 2.5 })
  })

  it('drops hand-edited out-of-range values so the next save validates', async () => {
    await writeState({ countIn: true, autoReference: false, recordLatencyMs: 5000, recordBitDepth: 32, micDeviceLabel: 'Mic' })
    const settings = await store.getSettings()
    expect(settings).toEqual({ countIn: true, autoReference: false, micDeviceLabel: 'Mic' })
    expect(appSettingsSchema.safeParse(settings).success).toBe(true)
  })

  it('restores defaults for invalid required values', async () => {
    await writeState({ countIn: 'yes', autoReference: false })
    expect(await store.getSettings()).toEqual({ countIn: true, autoReference: false })
  })

  it('keeps agent access off and absent unless it was turned on', async () => {
    await writeState({ countIn: true, autoReference: false })
    const settings = await store.getSettings()
    expect('agentAccess' in settings).toBe(false)
    expect(sanitizeAgentAccess(settings.agentAccess)).toBeUndefined()
    await store.setSettings(settings)
    const raw = JSON.parse(await fs.readFile(path.join(H.root, 'app.json'), 'utf-8'))
    expect(raw).toEqual({ settings: { countIn: true, autoReference: false } })
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('agentAccess')
  })

  it('round-trips agent access through save and load', async () => {
    const on = appSettingsSchema.parse({ countIn: true, autoReference: false, agentAccess: true })
    await store.setSettings(on)
    expect(await store.getSettings()).toEqual({ countIn: true, autoReference: false, agentAccess: true })
    expect(sanitizeAgentAccess((await store.getSettings()).agentAccess)).toBe(true)
  })

  it('drops a hand-edited agent access value that is not true', async () => {
    await writeState({ countIn: true, autoReference: false, agentAccess: 'yes' })
    expect(await store.getSettings()).toEqual({ countIn: true, autoReference: false })
    await writeState({ countIn: true, autoReference: false, agentAccess: false })
    expect(await store.getSettings()).toEqual({ countIn: true, autoReference: false })
  })

  it('keeps the agent budget absent by default and reads it as 20000 characters', async () => {
    await writeState({ countIn: true, autoReference: false })
    const settings = await store.getSettings()
    expect('agentCharacterBudget' in settings).toBe(false)
    expect(agentBudget(settings.agentCharacterBudget)).toBe(AGENT_BUDGET_DEFAULT)
    expect(AGENT_BUDGET_DEFAULT).toBe(20_000)
    await store.setSettings(settings)
    const raw = JSON.parse(await fs.readFile(path.join(H.root, 'app.json'), 'utf-8'))
    expect(raw).toEqual({ settings: { countIn: true, autoReference: false } })
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('agentCharacterBudget')
  })

  it('round-trips the agent budget, including 0 for unlimited', async () => {
    for (const budget of [0, 10, 10_000_000]) {
      await store.setSettings(appSettingsSchema.parse({ countIn: true, autoReference: false, agentCharacterBudget: budget }))
      expect(await store.getSettings()).toEqual({ countIn: true, autoReference: false, agentCharacterBudget: budget })
      expect(agentBudget((await store.getSettings()).agentCharacterBudget)).toBe(budget)
    }
  })

  it('drops a hand-edited agent budget that is not an integer from 0 to 10000000', async () => {
    for (const bad of [-1, 1.5, 10_000_001, '100', null]) {
      await writeState({ countIn: true, autoReference: false, agentCharacterBudget: bad })
      expect(await store.getSettings()).toEqual({ countIn: true, autoReference: false })
      expect(sanitizeAgentBudget(bad)).toBeUndefined()
      expect(agentBudget(bad)).toBe(AGENT_BUDGET_DEFAULT)
    }
  })
})
