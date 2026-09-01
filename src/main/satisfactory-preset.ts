import type { Character, ColumnMapping } from '@shared/domain'

export const SATISFACTORY_CSV = process.env.VOSTUDIO_SOURCE_CSV ?? ''
export const REFERENCE_DIR = process.env.VOSTUDIO_REFERENCE_DIR ?? ''
export const REFERENCE_PATTERN = '*__{key}.wav'
export const RULES_PATH = process.env.VOSTUDIO_RULES_PATH ?? ''

export const MAPPING: ColumnMapping = {
  key: 'WemId',
  text: 'UkrText',
  sourceText: 'Transcript',
  character: { fixed: 'ADA' },
  status: { column: 'Status', map: { mapped: 'translated', no_match: 'excluded' } },
  approvedFlag: { column: 'Notes', value: 'approved' },
  duration: 'AudioDuration',
}

export const ADA: Character = {
  id: 'ada',
  name: 'ADA',
  color: '#4fc3f7',
  provider: {
    providerId: 'elevenlabs',
    voiceId: 'l2Ae8U5M2C0gPXNHp3oH',
    ttsModel: 'eleven_multilingual_v2',
    stsModel: 'eleven_multilingual_sts_v2',
  },
  voiceSettings: { stability: 0.45, similarity: 0.51, style: 0, speed: 1.0, boost: true },
}

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

export const CHARACTERS: Character[] = [ADA, ALIEN]

export function characterForEvent(eventName: string): string {
  if (eventName.includes('ADA')) return ADA.id
  if (/Alien|SamOre|Whisper/i.test(eventName)) return ALIEN.id
  return ADA.id
}
