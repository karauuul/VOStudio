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
const { DEFAULT_APP_SETTINGS, sanitizeAgentAccess } = await import('../src/shared/ipc')

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
})
