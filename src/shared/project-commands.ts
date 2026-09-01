import { approveCue, changeCompOutput, changeCueText, changeTakeOutput, invalidateVoicedOutput, removeApproval } from './approval'
import { compProblem, normalizeComp } from './comp'
import {
  CHARACTER_COLORS,
  DEFAULT_VOICE_SETTINGS,
  ELEVENLABS_STS_MODEL,
  ELEVENLABS_TTS_MODEL,
  hasVoicedTake,
  type Character,
  type Cue,
  type CueComp,
  type Project,
  type VoiceSettings,
} from './domain'

export type ProjectCommand =
  | { type: 'cue.saveText'; cueId: string; text: string }
  | { type: 'cue.approve'; cueId: string; approved: boolean; approvedAt?: string }
  | { type: 'cue.setFinalTake'; cueId: string; takeId: string }
  | { type: 'cue.setComp'; cueId: string; comp: CueComp | null }
  | { type: 'cue.acceptSuggestion'; cueId: string }
  | { type: 'cue.rejectSuggestion'; cueId: string }
  | { type: 'cue.setVoiceOverride'; cueId: string; override: Partial<VoiceSettings> | null }
  | { type: 'cue.deleteTake'; cueId: string; takeId: string; deletedAt?: string }
  | { type: 'cue.setCharacter'; cueId: string; characterId: string }
  | { type: 'character.setVoiceSettings'; characterId: string; settings: VoiceSettings }
  | { type: 'character.create'; id: string; name: string }
  | { type: 'character.rename'; characterId: string; name: string }
  | { type: 'character.setProvider'; characterId: string; voiceId: string; ttsModel: string; stsModel: string }
  | { type: 'character.delete'; characterId: string; reassignTo: string }
  | { type: 'rules.set'; text: string }

export interface ChangeSet {
  cues?: Cue[]
  characters?: Project['characters']
  pronunciationRules?: string
}

export interface CommandResult { revision: number; changes: ChangeSet }
export interface ProjectSnapshot { revision: number; project: Project }

const cueById = (project: Project, id: string): Cue => {
  const cue = project.cues.find((item) => item.id === id)
  if (!cue) throw new Error('Cue not found')
  return cue
}

const characterById = (project: Project, id: string): Character => {
  const character = project.characters.find((item) => item.id === id)
  if (!character) throw new Error('Character not found')
  return character
}

const characterList = (project: Project): ChangeSet => ({ characters: structuredClone(project.characters) })

function uniqueName(project: Project, name: string, exceptId?: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Character name cannot be empty')
  const clash = project.characters.some(
    (item) => item.id !== exceptId && item.name.trim().toLowerCase() === trimmed.toLowerCase()
  )
  if (clash) throw new Error(`Character "${trimmed}" already exists`)
  return trimmed
}

export function applyProjectCommand(project: Project, command: ProjectCommand): ChangeSet {
  if (command.type === 'character.setVoiceSettings') {
    characterById(project, command.characterId).voiceSettings = structuredClone(command.settings)
    return characterList(project)
  }
  if (command.type === 'character.create') {
    if (project.characters.some((item) => item.id === command.id)) throw new Error('Character id is already used')
    project.characters.push({
      id: command.id,
      name: uniqueName(project, command.name),
      color: CHARACTER_COLORS[project.characters.length % CHARACTER_COLORS.length],
      provider: {
        providerId: 'elevenlabs',
        voiceId: '',
        ttsModel: ELEVENLABS_TTS_MODEL,
        stsModel: ELEVENLABS_STS_MODEL,
      },
      voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
    })
    return characterList(project)
  }
  if (command.type === 'character.rename') {
    const character = characterById(project, command.characterId)
    character.name = uniqueName(project, command.name, character.id)
    return characterList(project)
  }
  if (command.type === 'character.setProvider') {
    const character = characterById(project, command.characterId)
    character.provider = {
      ...character.provider,
      voiceId: command.voiceId.trim(),
      ttsModel: command.ttsModel,
      stsModel: command.stsModel,
    }
    return characterList(project)
  }
  if (command.type === 'character.delete') {
    const character = characterById(project, command.characterId)
    if (command.reassignTo) {
      if (command.reassignTo === character.id) throw new Error('Cannot reassign cues to the character being deleted')
      characterById(project, command.reassignTo)
    }
    const moved: Cue[] = []
    for (const cue of project.cues) {
      if (cue.characterId !== character.id) continue
      cue.characterId = command.reassignTo
      Object.assign(cue, invalidateVoicedOutput(cue))
      moved.push(structuredClone(cue))
    }
    project.characters = project.characters.filter((item) => item.id !== character.id)
    return { ...characterList(project), cues: moved }
  }
  if (command.type === 'rules.set') {
    project.pronunciationRules = command.text
    return { pronunciationRules: command.text }
  }
  const cue = cueById(project, command.cueId)
  switch (command.type) {
    case 'cue.saveText':
      Object.assign(cue, changeCueText(cue, command.text))
      if (cue.status === 'empty' && command.text.trim()) cue.status = 'translated'
      break
    case 'cue.approve':
      if (command.approved) Object.assign(cue, approveCue(cue, command.approvedAt))
      else {
        Object.assign(cue, removeApproval(cue))
        delete cue.approval
      }
      break
    case 'cue.setFinalTake': {
      const take = cue.takes.find((item) => item.id === command.takeId)
      if (!take) throw new Error('Take not found in this cue')
      if (take.kind === 'recording') throw new Error('A raw recording cannot be final — convert it first')
      Object.assign(cue, changeTakeOutput(cue, command.takeId))
      break
    }
    case 'cue.setComp': {
      if (command.comp === null) {
        delete cue.comp
        Object.assign(cue, changeCompOutput(cue, null))
        break
      }
      const problem = compProblem(command.comp)
      if (problem) throw new Error(`Invalid composition: ${problem}`)
      for (const clip of command.comp.clips) {
        if (!cue.takes.some((take) => take.id === clip.sourceTakeId)) throw new Error(`Composition clip "${clip.id}": take ${clip.sourceTakeId} is not in this cue`)
      }
      Object.assign(cue, changeCompOutput(cue, normalizeComp(command.comp)))
      break
    }
    case 'cue.acceptSuggestion':
      if (cue.suggestedText !== undefined) {
        Object.assign(cue, changeCueText(cue, cue.suggestedText))
        delete cue.suggestedText
        if (cue.status === 'empty') cue.status = 'translated'
      }
      break
    case 'cue.rejectSuggestion':
      delete cue.suggestedText
      break
    case 'cue.setVoiceOverride':
      if (command.override === null) delete cue.voiceSettingsOverride
      else cue.voiceSettingsOverride = structuredClone(command.override)
      break
    case 'cue.deleteTake': {
      const take = cue.takes.find((item) => item.id === command.takeId)
      if (!take) throw new Error('Take not found in this cue')
      if (take.id === cue.finalTakeId) throw new Error('The final take cannot be deleted')
      if (!take.deletedAt) take.deletedAt = command.deletedAt ?? new Date().toISOString()
      if (cue.status === 'generated' && !hasVoicedTake(cue)) cue.status = cue.text.trim() ? 'translated' : 'empty'
      break
    }
    case 'cue.setCharacter': {
      if (command.characterId) characterById(project, command.characterId)
      if (cue.characterId === command.characterId) break
      cue.characterId = command.characterId
      Object.assign(cue, invalidateVoicedOutput(cue))
      break
    }
  }
  return { cues: [structuredClone(cue)] }
}

export function applyChangeSet(project: Project, changes: ChangeSet): Project {
  let next = project
  if (changes.cues) {
    const replacements = new Map(changes.cues.map((cue) => [cue.id, cue]))
    next = { ...next, cues: next.cues.map((cue) => replacements.get(cue.id) ?? cue) }
  }
  if (changes.characters) next = { ...next, characters: changes.characters }
  if (changes.pronunciationRules !== undefined) next = { ...next, pronunciationRules: changes.pronunciationRules }
  return next
}
