import { afterEach, describe, expect, it, vi } from 'vitest'
import { appSettingsSchema } from '../src/main/schemas'
import { DEFAULT_APP_SETTINGS } from '../src/shared/ipc'
import { punchPrerollSeconds, recordLatencyMs } from '../src/shared/punch'
import { pcmBitDepth } from '../src/shared/wav-header'
import { applySink, deviceIdForLabel } from '../src/renderer/audio/transport'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubDevices(list: Partial<MediaDeviceInfo>[]): void {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: () => Promise.resolve(list) } })
}

describe('app settings persistence', () => {
  it('round trips the device labels', () => {
    const settings = {
      micDeviceLabel: 'USB Mic (Rode)',
      outputDeviceLabel: 'Speakers (Realtek)',
      countIn: true,
      autoReference: false,
    }
    expect(appSettingsSchema.parse(structuredClone(settings))).toStrictEqual(settings)
  })

  it('leaves settings without device fields untouched', () => {
    const settings = { countIn: false, autoReference: true }
    expect(appSettingsSchema.parse(structuredClone(settings))).toStrictEqual(settings)
  })

  it('saves settings written by an older build byte for byte', () => {
    const settings = { micDeviceId: 'mic-1', countIn: true, autoReference: false }
    expect(JSON.stringify(appSettingsSchema.parse(structuredClone(settings)))).toBe(
      JSON.stringify(settings)
    )
  })

  it('round trips the recording bit depth', () => {
    const settings = { micDeviceLabel: 'USB Mic', recordBitDepth: 24, countIn: true, autoReference: false }
    expect(appSettingsSchema.parse(structuredClone(settings))).toStrictEqual(settings)
    expect(appSettingsSchema.parse({ ...settings, recordBitDepth: 16 }).recordBitDepth).toBe(16)
  })

  it('rejects an unknown bit depth', () => {
    for (const recordBitDepth of [32, 8, '24', null]) {
      expect(appSettingsSchema.safeParse({ countIn: true, autoReference: false, recordBitDepth }).success).toBe(false)
    }
  })

  it('records 16-bit unless 24-bit was chosen', () => {
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('recordBitDepth')
    expect(pcmBitDepth(DEFAULT_APP_SETTINGS.recordBitDepth)).toBe(16)
    expect(pcmBitDepth(24)).toBe(24)
    expect(pcmBitDepth(16)).toBe(16)
    for (const junk of [32, '24', null, 24.5, {}]) expect(pcmBitDepth(junk)).toBe(16)
  })

  it('round trips the latency and pre-roll overrides', () => {
    for (const recordLatencyMs of [-1000, -35, 0, 120, 1000, 'auto']) {
      const settings = { recordLatencyMs, punchPrerollSeconds: 2.5, countIn: true, autoReference: false }
      expect(appSettingsSchema.parse(structuredClone(settings))).toStrictEqual(settings)
    }
    for (const punchPrerollSeconds of [0, 0.5, 7, 10]) {
      const settings = { punchPrerollSeconds, countIn: false, autoReference: true }
      expect(appSettingsSchema.parse(structuredClone(settings))).toStrictEqual(settings)
    }
  })

  it('rejects latency and pre-roll values outside the allowed range', () => {
    const base = { countIn: true, autoReference: false }
    for (const recordLatencyMs of [1001, -1001, 12.5, '100', 'Auto', null, Number.NaN]) {
      expect(appSettingsSchema.safeParse({ ...base, recordLatencyMs }).success).toBe(false)
    }
    for (const punchPrerollSeconds of [-0.5, 10.5, 0.3, '5', null, Number.POSITIVE_INFINITY]) {
      expect(appSettingsSchema.safeParse({ ...base, punchPrerollSeconds }).success).toBe(false)
    }
  })

  it('keeps settings without latency or pre-roll byte for byte and on the defaults', () => {
    const settings = { micDeviceLabel: 'USB Mic', recordBitDepth: 24, countIn: true, autoReference: false }
    expect(JSON.stringify(appSettingsSchema.parse(structuredClone(settings)))).toBe(JSON.stringify(settings))
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('recordLatencyMs')
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('punchPrerollSeconds')
    expect(recordLatencyMs(DEFAULT_APP_SETTINGS.recordLatencyMs)).toBeUndefined()
    expect(punchPrerollSeconds(DEFAULT_APP_SETTINGS.punchPrerollSeconds)).toBe(5)
  })

  it('drops a cleared override from the saved file', () => {
    const settings = { countIn: true, autoReference: false, recordLatencyMs: undefined, punchPrerollSeconds: undefined }
    expect(JSON.stringify(appSettingsSchema.parse(settings))).toBe(
      JSON.stringify({ countIn: true, autoReference: false })
    )
  })
})

describe('output sink', () => {
  it('reports the applied device', async () => {
    const setSinkId = vi.fn(() => Promise.resolve())
    expect(await applySink({ setSinkId }, 'out-1')).toBe('out-1')
    expect(setSinkId).toHaveBeenCalledWith('out-1')
  })

  it('falls back to the default device when the sink is rejected', async () => {
    const setSinkId = vi.fn((id: string) =>
      id === '' ? Promise.resolve() : Promise.reject(new Error('gone'))
    )
    expect(await applySink({ setSinkId }, 'out-1')).toBe('')
    expect(setSinkId).toHaveBeenLastCalledWith('')
  })

  it('stays silent when the default device is rejected too', async () => {
    const setSinkId = vi.fn(() => Promise.reject(new Error('gone')))
    expect(await applySink({ setSinkId }, 'out-1')).toBe('')
  })

  it('does nothing when the context cannot switch sinks', async () => {
    expect(await applySink({}, 'out-1')).toBe('')
  })
})

describe('microphone by label', () => {
  it('resolves the label to the id of the current session', async () => {
    stubDevices([
      { kind: 'audiooutput', label: 'USB Mic (Rode)', deviceId: 'out-3' },
      { kind: 'audioinput', label: 'USB Mic (Rode)', deviceId: 'in-7' },
    ])
    expect(await deviceIdForLabel('audioinput', 'USB Mic (Rode)')).toBe('in-7')
  })

  it('resolves to nothing when the device is gone', async () => {
    stubDevices([{ kind: 'audioinput', label: 'Internal Mic', deviceId: 'in-1' }])
    expect(await deviceIdForLabel('audioinput', 'USB Mic (Rode)')).toBe('')
  })
})
