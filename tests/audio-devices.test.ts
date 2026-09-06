import { afterEach, describe, expect, it, vi } from 'vitest'
import { appSettingsSchema } from '../src/main/schemas'
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
