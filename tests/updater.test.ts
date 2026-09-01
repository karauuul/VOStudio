import { describe, expect, it } from 'vitest'
import {
  AUTO_INSTALL_ON_APP_QUIT,
  initialUpdateStatus,
  reduceUpdateStatus,
  shouldCheckForUpdates,
} from '../src/shared/updater'

describe('updater state', () => {
  it('tracks check, download, and ready transitions', () => {
    let state = initialUpdateStatus('0.1.0')
    state = reduceUpdateStatus(state, { type: 'check' })
    expect(state.phase).toBe('checking')
    state = reduceUpdateStatus(state, { type: 'available', version: '0.1.1' })
    expect(state).toMatchObject({ phase: 'available', availableVersion: '0.1.1', percent: 0 })
    state = reduceUpdateStatus(state, { type: 'progress', percent: 42.5 })
    expect(state).toMatchObject({ phase: 'downloading', percent: 42.5 })
    state = reduceUpdateStatus(state, { type: 'downloaded', version: '0.1.1' })
    expect(state).toMatchObject({
      phase: 'ready',
      availableVersion: '0.1.1',
      percent: 100,
    })
  })

  it('tracks up-to-date and error results', () => {
    const initial = initialUpdateStatus('0.1.0')
    expect(reduceUpdateStatus(initial, { type: 'not-available' }).phase).toBe('up-to-date')
    expect(reduceUpdateStatus(initial, { type: 'error', message: 'offline' })).toMatchObject({
      phase: 'error',
      error: 'offline',
    })
  })

  it('never checks when unpackaged', () => {
    expect(shouldCheckForUpdates(false, 'win32')).toBe(false)
    expect(shouldCheckForUpdates(true, 'linux')).toBe(false)
    expect(shouldCheckForUpdates(true, 'win32')).toBe(true)
  })

  it('installs only after an explicit restart request', () => {
    expect(AUTO_INSTALL_ON_APP_QUIT).toBe(false)
  })
})
