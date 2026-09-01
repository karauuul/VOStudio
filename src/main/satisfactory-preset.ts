import type { Character } from '@shared/domain'

export const ADA_ID = 'ada'

export const ALIEN: Character = {
  id: 'alien',
  name: 'Alien',
  color: '#b58cf0',
  provider: {
    providerId: 'elevenlabs',
    voiceId: '',
    ttsModel: 'eleven_multilingual_v2',
    stsModel: 'eleven_multilingual_sts_v2',
  },
  voiceSettings: { stability: 0.45, similarity: 0.51, style: 0, speed: 1.0, boost: true },
}

export function characterForEvent(eventName: string): string {
  if (eventName.includes('ADA')) return ADA_ID
  if (/Alien|SamOre|Whisper/i.test(eventName)) return ALIEN.id
  return ADA_ID
}
