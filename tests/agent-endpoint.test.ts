import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import path from 'path'
import { endpointFor } from '../src/main/bridge'
import { agentEndpoint } from '../src/shared/agent-endpoint'
import { GUARD_VERSION_MS, needsGuardVersion } from '../src/shared/versions'

const fakeHash = (text: string): string => `${text}0123456789abcdef0123456789`

describe('agent endpoint', () => {
  it('uses a named pipe keyed by the lowercased userData path on Windows', () => {
    const hashed: string[] = []
    const endpoint = agentEndpoint('win32', 'C:\\Users\\Ann\\AppData\\Roaming\\VO Studio', (text) => {
      hashed.push(text)
      return 'deadbeefcafebabe0011223344556677'
    })
    expect(hashed).toEqual(['c:\\users\\ann\\appdata\\roaming\\vo studio'])
    expect(endpoint).toBe('\\\\.\\pipe\\vostudio-deadbeefcafebabe')
  })

  it('uses a socket file inside userData elsewhere', () => {
    expect(agentEndpoint('linux', '/home/ann/.config/VO Studio', fakeHash)).toBe('/home/ann/.config/VO Studio/agent.sock')
    expect(agentEndpoint('darwin', '/Users/ann/Library/Application Support/vo-studio/', fakeHash)).toBe(
      '/Users/ann/Library/Application Support/vo-studio/agent.sock'
    )
  })
})

describe('bridge endpoint parity', () => {
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
  it('derives the same Windows pipe as the server', () => {
    for (const dir of ['C:\\Users\\Ann\\AppData\\Roaming\\VO Studio', 'D:\\Portable\\vo-studio', 'C:\\Users\\Łukasz\\AppData\\Roaming\\VO Studio']) {
      expect(endpointFor('win32', dir)).toBe(agentEndpoint('win32', dir, sha256))
    }
  })

  it('derives the same socket file as the server', () => {
    const dir = path.join('/tmp', 'vo profile')
    expect(endpointFor('linux', dir)).toBe(agentEndpoint('linux', dir, sha256))
  })
})

describe('Before agent version guard', () => {
  const now = Date.parse('2026-09-27T12:00:00Z')
  it('saves when there is no recent version', () => {
    expect(needsGuardVersion([], now)).toBe(true)
    expect(needsGuardVersion([{ createdAt: new Date(now - GUARD_VERSION_MS).toISOString() }], now)).toBe(true)
    expect(needsGuardVersion([{ createdAt: 'garbage' }], now)).toBe(true)
  })

  it('skips when the newest version is under ten minutes old', () => {
    expect(needsGuardVersion([{ createdAt: '2020-01-01T00:00:00Z' }, { createdAt: new Date(now - 60_000).toISOString() }], now)).toBe(false)
  })
})
