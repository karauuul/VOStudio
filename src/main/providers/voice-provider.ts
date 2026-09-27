import { keyedQueue, queuedMethods } from '@shared/keyed-queue'
import { hasApiKey } from '../secrets'
import * as elevenlabs from './elevenlabs'
import { mockProvider } from './mock'

export type VoiceProvider = Pick<
  typeof elevenlabs,
  'tts' | 'ttsWithTimestamps' | 'sts' | 'audioIsolation' | 'stt' | 'sttWords' | 'voices' | 'models' | 'usage'
> & {
  id: string
  hasApiKey: () => Promise<boolean>
}

const SERIAL_PROVIDER_CALLS = ['tts', 'ttsWithTimestamps', 'sts', 'audioIsolation', 'stt', 'sttWords'] as const

const providerLock = keyedQueue()
const serial = (provider: VoiceProvider): VoiceProvider =>
  queuedMethods(provider, SERIAL_PROVIDER_CALLS, providerLock, 'provider')

const elevenlabsProvider = serial({ ...elevenlabs, id: 'elevenlabs', hasApiKey })
const serialMock = serial(mockProvider)

export const voiceProvider = (): VoiceProvider =>
  process.env.VOSTUDIO_PROVIDER === 'mock' ? serialMock : elevenlabsProvider
