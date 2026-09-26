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
})
