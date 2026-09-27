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

const elevenlabsProvider: VoiceProvider = { ...elevenlabs, id: 'elevenlabs', hasApiKey }

export const voiceProvider = (): VoiceProvider =>
  process.env.VOSTUDIO_PROVIDER === 'mock' ? mockProvider : elevenlabsProvider
