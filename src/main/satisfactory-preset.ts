import {
  DEFAULT_VOICE_SETTINGS,
  ELEVENLABS_STS_MODEL,
  ELEVENLABS_TTS_MODEL,
  type Character,
  type Project,
} from '@shared/domain'

export const ADA_ID = 'ada'

export const ALIEN: Character = {
  id: 'alien',
  name: 'Alien',
  color: '#b58cf0',
  provider: {
    providerId: 'elevenlabs',
    voiceId: '',
    ttsModel: ELEVENLABS_TTS_MODEL,
    stsModel: ELEVENLABS_STS_MODEL,
  },
  voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
}

export function characterForEvent(eventName: string): string {
  if (eventName.includes('ADA')) return ADA_ID
  if (/Alien|SamOre|Whisper/i.test(eventName)) return ALIEN.id
  return ADA_ID
}

export function needsAlienMigration(
  project: Pick<Project, 'csvBinding' | 'characters' | 'cues'>
): boolean {
  if (!project.csvBinding) return false
  if (!project.characters.some((c) => c.id === ADA_ID)) return false
  if (project.characters.some((c) => c.id === ALIEN.id)) return false
  return project.cues.some((c) => c.fields['EventName'])
}

export function applyAlienMigration(project: Project): boolean {
  if (project.alienMigrated || !project.csvBinding) return false
  if (needsAlienMigration(project)) {
    project.characters.push(structuredClone(ALIEN))
    for (const cue of project.cues) {
      cue.characterId = characterForEvent(cue.fields['EventName'] ?? '')
    }
  }
  project.alienMigrated = true
  return true
}
