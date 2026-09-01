import { approveCue, changeCompOutput, changeCueText, changeTakeOutput, removeApproval } from './approval'
import { compProblem, normalizeComp } from './comp'
import { hasVoicedTake, type Cue, type CueComp, type Project, type VoiceSettings } from './domain'

export type ProjectCommand =
  | { type: 'cue.saveText'; cueId: string; text: string }
  | { type: 'cue.approve'; cueId: string; approved: boolean; approvedAt?: string }
  | { type: 'cue.setFinalTake'; cueId: string; takeId: string }
  | { type: 'cue.setComp'; cueId: string; comp: CueComp | null }
  | { type: 'cue.acceptSuggestion'; cueId: string }
  | { type: 'cue.rejectSuggestion'; cueId: string }
  | { type: 'cue.setVoiceOverride'; cueId: string; override: Partial<VoiceSettings> | null }
  | { type: 'cue.deleteTake'; cueId: string; takeId: string; deletedAt?: string }
  | { type: 'character.setVoiceSettings'; characterId: string; settings: VoiceSettings }
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

export function applyProjectCommand(project: Project, command: ProjectCommand): ChangeSet {
  if (command.type === 'character.setVoiceSettings') {
    const character = project.characters.find((item) => item.id === command.characterId)
    if (!character) throw new Error('Character not found')
    character.voiceSettings = structuredClone(command.settings)
    return { characters: [structuredClone(character)] }
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
  }
  return { cues: [structuredClone(cue)] }
}

export function applyChangeSet(project: Project, changes: ChangeSet): Project {
  let next = project
  if (changes.cues) {
    const replacements = new Map(changes.cues.map((cue) => [cue.id, cue]))
    next = { ...next, cues: next.cues.map((cue) => replacements.get(cue.id) ?? cue) }
  }
  if (changes.characters) {
    const replacements = new Map(changes.characters.map((character) => [character.id, character]))
    next = { ...next, characters: next.characters.map((character) => replacements.get(character.id) ?? character) }
  }
  if (changes.pronunciationRules !== undefined) next = { ...next, pronunciationRules: changes.pronunciationRules }
  return next
}
