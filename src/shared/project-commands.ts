import { approveCue, sanitizeRevision, changeCompOutput, changeCueSourceText, changeCueText, changeTakeOutput, invalidateVoicedOutput, outputUsesTake, removeApproval, sanitizeApproval, sanitizeCueOutput, setExcluded } from './approval'
import { compProblem, normalizeComp } from './comp'
import { sanitizeEffects } from './effects'
import {
  blankCharacter,
  DEFAULT_VOICE_SETTINGS,
  hasVoicedTake,
  sanitizeCharacterProposal,
  sanitizeCueRegion,
  sanitizeLanguages,
  sanitizeLinkProposal,
  sanitizeOriginal,
  sanitizePinned,
  sanitizeProviderSettings,
  sanitizeStems,
  sanitizeTerms,
  withOrigin,
  type AudioRef,
  type Character,
  type CharacterProposal,
  type CueProposals,
  type LinkProposal,
  type ProjectAsset,
  type ProposalKind,
  type CueApproval,
  type CueOutput,
  type ClipEffects,
  type Cue,
  type CueComp,
  type CueRegion,
  type OriginalLane,
  type Project,
  type ProjectLanguages,
  type ProjectSource,
  type ProjectVersion,
  type ProviderSettings,
  type Stem,
  type Term,
  type VoiceSettings,
} from './domain'
import { referencedByOtherComp, resolveTake, type TakeLookup } from './library'
import { sanitizeExportSettings, type ExportSettings } from './export-settings'
import { mixesOriginal } from './export-plan'
import { newLineCue, nextLineNumber } from './lines'
import { isInsideDir } from './project-summary'

export type ProjectCommand =
  | { type: 'cue.saveText'; cueId: string; text: string; ifText?: string }
  | { type: 'cue.approve'; cueId: string; approved: boolean; approvedAt?: string }
  | { type: 'cue.setFinalTake'; cueId: string; takeId: string }
  | { type: 'cue.setComp'; cueId: string; comp: CueComp | null }
  | { type: 'cue.setOriginal'; cueId: string; original: OriginalLane | null }
  | { type: 'cue.setStems'; cueId: string; stems: Stem[] | null }
  | { type: 'cue.setTakePinned'; cueId: string; takeId: string; pinned: boolean }
  | { type: 'cue.setTakeEffects'; cueId: string; takeId: string; effects: ClipEffects | null }
  | { type: 'cue.setRegion'; cueId: string; region: CueRegion | null }
  | { type: 'cue.acceptSuggestion'; cueId: string }
  | { type: 'cue.rejectSuggestion'; cueId: string }
  | { type: 'cue.setVoiceOverride'; cueId: string; override: Partial<VoiceSettings> | null }
  | { type: 'cue.deleteTake'; cueId: string; takeId: string; deletedAt?: string }
  | { type: 'cue.setCharacter'; cueId: string; characterId: string }
  | { type: 'cue.setExcluded'; cueId: string; excluded: boolean }
  | { type: 'cue.propose'; items: ProposalItem[] }
  | { type: 'proposal.accept'; items: ProposalRef[] }
  | { type: 'proposal.reject'; items: ProposalRef[] }
  | { type: 'cue.create'; afterCueId: string | null; lines: { id: string; text: string }[] }
  | { type: 'cue.delete'; cueIds: string[] }
  | { type: 'cue.restore'; cues: PlacedCue[] }
  | {
      type: 'table.step'
      remove: string[]
      restore: PlacedCue[]
      fields: FieldStep[]
      addCharacters: Character[]
      dropCharacters: Character[]
    }
  | { type: 'cue.useTakeAsOriginal'; cueId: string; takeId: string }
  | ({ type: 'cue.restoreOriginal'; cueId: string; whenState: OutputState } & OriginalState)
  | ({ type: 'cue.restoreOutput'; cueId: string; whenState: OutputState; whenTextRevision: number } & OutputState)
  | { type: 'character.setVoiceSettings'; characterId: string; settings: VoiceSettings }
  | { type: 'character.create'; id: string; name: string }
  | { type: 'character.rename'; characterId: string; name: string }
  | { type: 'character.setProvider'; characterId: string; voiceId?: string; ttsModel?: string; stsModel?: string }
  | { type: 'character.delete'; characterId: string; reassignTo: string }
  | { type: 'rules.set'; text: string }
  | { type: 'terms.set'; terms: Term[] }
  | { type: 'project.rename'; name: string }
  | { type: 'project.setLanguages'; languages: ProjectLanguages | null }
  | { type: 'project.setExport'; settings: ExportSettings | null }
  | { type: 'project.setProvider'; provider: ProviderSettings | null }
  | { type: 'project.setExportTemplate'; template: string }

export interface ProposalItem {
  cueId: string
  character?: CharacterProposal | null
  link?: LinkProposal | null
}

export interface ProposalRef {
  cueId: string
  kind: ProposalKind
}

export interface OutputState {
  status: Cue['status']
  output?: CueOutput | null
  approval?: CueApproval | null
}

export interface OriginalState extends OutputState {
  referenceAudio: AudioRef | null
  referenceDuration: number | null
}

export interface PlacedCue {
  cue: Cue
  index: number
}

export type LineFields = Partial<Pick<Cue, 'sourceText' | 'text' | 'characterId'>> & { suggestedText?: string | null }

export interface FieldStep {
  cueId: string
  from: LineFields
  to: LineFields
}

export interface ChangeSet {
  name?: string
  languages?: ProjectLanguages | null
  export?: ExportSettings | null
  provider?: ProviderSettings | null
  exportTemplate?: string
  versions?: ProjectVersion[]
  cues?: Cue[]
  cueIndex?: Record<string, number>
  removedCueIds?: string[]
  removedCues?: PlacedCue[]
  sources?: ProjectSource[]
  assets?: ProjectAsset[]
  characters?: Project['characters']
  charactersReplace?: boolean
  pronunciationRules?: string
  terms?: Term[] | null
  linesFromTable?: true
}

export type ChangeOrigin = 'agent'
export interface CommandResult { revision: number; changes: ChangeSet; origin?: ChangeOrigin }
export interface ProjectSnapshot { revision: number; project: Project }
export interface SerializedSnapshot { revision: number; json: string }

export const serializeSnapshot = (revision: number, project: Project): SerializedSnapshot => ({ revision, json: JSON.stringify(project) })
export const parseSnapshot = ({ revision, json }: SerializedSnapshot): ProjectSnapshot => ({ revision, project: JSON.parse(json) as Project })

const cueById = (project: Project, id: string): Cue => {
  const cue = project.cues.find((item) => item.id === id)
  if (!cue) throw new Error('Cue not found')
  return cue
}

export function savedText(cue: Cue, text: string, project?: TakeLookup): Cue {
  const next = changeCueText(cue, text, project)
  return next.status === 'empty' && text.trim() ? { ...next, status: 'translated' } : next
}

export const outputStateKey = ({ status, output, approval }: OutputState): string =>
  JSON.stringify({ status, output: sanitizeCueOutput(output), approval: sanitizeApproval(approval) })

function restoreOutputState(cue: Cue, state: OutputState): void {
  cue.status = state.status
  if (state.output === undefined) delete cue.output
  else cue.output = structuredClone(state.output)
  if (state.approval === undefined) delete cue.approval
  else cue.approval = structuredClone(state.approval)
}

const characterById = (project: Project, id: string): Character => {
  const character = project.characters.find((item) => item.id === id)
  if (!character) throw new Error('Character not found')
  return character
}

const characterList = (project: Project): ChangeSet => ({
  characters: structuredClone(project.characters),
  charactersReplace: true,
})

const characterOnly = (character: Character): ChangeSet => ({ characters: [structuredClone(character)] })

function invalidateCharacterCues(project: Project, characterId: string): Cue[] {
  const moved: Cue[] = []
  for (const cue of project.cues) {
    if (cue.characterId !== characterId) continue
    const next = invalidateVoicedOutput(cue, project)
    if (next === cue) continue
    Object.assign(cue, next)
    moved.push(structuredClone(cue))
  }
  return moved
}

function uniqueName(project: Project, name: string, exceptId?: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Character name cannot be empty')
  const clash = project.characters.some(
    (item) => item.id !== exceptId && item.name.trim().toLowerCase() === trimmed.toLowerCase()
  )
  if (clash) throw new Error(`Character "${trimmed}" already exists`)
  return trimmed
}

function insertCues(project: Project, placed: PlacedCue[]): ChangeSet {
  const cueIndex: Record<string, number> = {}
  for (const { cue, index } of [...placed].sort((a, b) => a.index - b.index)) {
    const at = Math.max(0, Math.min(project.cues.length, Math.trunc(index)))
    project.cues.splice(at, 0, cue)
    cueIndex[cue.id] = at
  }
  return { cues: structuredClone(placed.map((p) => p.cue)), cueIndex }
}

function deleteCues(project: Project, cueIds: string[]): ChangeSet {
  const ids = new Set(cueIds)
  if (ids.size === 0 || ids.size !== cueIds.length) throw new Error('Invalid line list')
  const removed: PlacedCue[] = []
  project.cues.forEach((cue, index) => {
    if (ids.has(cue.id)) removed.push({ cue, index })
  })
  if (removed.length !== ids.size) throw new Error('Cue not found')
  const takeIds = new Set(removed.flatMap(({ cue }) => cue.takes.map((take) => take.id)))
  const usedElsewhere = project.cues.some(
    (cue) => !ids.has(cue.id) && (cue.comp?.clips ?? []).some((clip) => takeIds.has(clip.sourceTakeId))
  )
  if (usedElsewhere) throw new Error('This line has a source used on another line — remove it there first')
  const snapshot = structuredClone(removed)
  for (const { index } of [...removed].reverse()) project.cues.splice(index, 1)
  return { removedCueIds: [...ids], removedCues: snapshot }
}

function checkRestore(project: Project, placed: PlacedCue[]): void {
  const ids = new Set(placed.map((item) => item.cue.id))
  if (ids.size === 0 || ids.size !== placed.length || project.cues.some((cue) => ids.has(cue.id))) {
    throw new Error('Line id is already used')
  }
  const lookup = { cues: [...project.cues, ...placed.map((item) => item.cue)] }
  for (const { cue } of placed) {
    for (const clip of cue.comp?.clips ?? []) {
      if (!resolveTake(lookup, cue, clip.sourceTakeId)) throw new Error('A source this line uses is no longer available')
    }
  }
}

const VOICE_KEYS = Object.keys(DEFAULT_VOICE_SETTINGS) as (keyof VoiceSettings)[]
const PROVIDER_KEYS = ['providerId', 'voiceId', 'ttsModel', 'stsModel'] as const

const sameCharacter = (a: Character, b: Character): boolean =>
  a.name === b.name &&
  a.color === b.color &&
  PROVIDER_KEYS.every((key) => a.provider[key] === b.provider[key]) &&
  VOICE_KEYS.every((key) => a.voiceSettings[key] === b.voiceSettings[key])

function stepFields(project: Project, cue: Cue, from: LineFields, to: LineFields): Cue {
  let next = cue
  if (to.sourceText !== undefined && next.sourceText === from.sourceText) {
    next = changeCueSourceText(next, to.sourceText, project)
  }
  if (to.text !== undefined && next.text === from.text) next = changeCueText(next, to.text, project)
  const characterId = to.characterId
  if (
    characterId !== undefined &&
    next.characterId === from.characterId &&
    next.characterId !== characterId &&
    (characterId === '' || project.characters.some((item) => item.id === characterId))
  ) {
    next = { ...next, characterId }
    next = { ...next, ...invalidateVoicedOutput(next, project) }
  }
  const suggestion = to.suggestedText
  const pending = next.suggestedText ?? null
  if (suggestion !== undefined && pending === from.suggestedText && pending !== suggestion) {
    const { suggestedText: _dropped, ...rest } = next
    next = suggestion === null ? rest : { ...rest, suggestedText: suggestion }
  }
  return next
}

function tableStep(project: Project, command: Extract<ProjectCommand, { type: 'table.step' }>): ChangeSet {
  const present = new Set(project.cues.map((cue) => cue.id))
  const remove = command.remove.filter((id) => present.has(id))
  if (command.restore.length > 0) checkRestore(project, command.restore)
  const removed = remove.length > 0 ? deleteCues(project, remove) : {}
  const cueIndex = command.restore.length > 0 ? insertCues(project, structuredClone(command.restore)).cueIndex : undefined
  let charactersChanged = false
  for (const character of command.addCharacters) {
    if (project.characters.some((item) => item.id === character.id)) continue
    project.characters.push(structuredClone(character))
    charactersChanged = true
  }
  const byId = new Map(project.cues.map((cue) => [cue.id, cue]))
  const touched = new Set(Object.keys(cueIndex ?? {}))
  for (const { cueId, from, to } of command.fields) {
    const cue = byId.get(cueId)
    if (!cue) continue
    const next = stepFields(project, cue, from, to)
    if (next === cue) continue
    Object.assign(cue, next)
    if (next.suggestedText === undefined) delete cue.suggestedText
    touched.add(cueId)
  }
  for (const character of command.dropCharacters) {
    const at = project.characters.findIndex((item) => item.id === character.id)
    if (at < 0 || !sameCharacter(project.characters[at], character)) continue
    if (project.cues.some((cue) => cue.characterId === character.id)) continue
    project.characters.splice(at, 1)
    charactersChanged = true
  }
  return {
    ...removed,
    ...(touched.size > 0 ? { cues: [...touched].map((id) => structuredClone(byId.get(id) as Cue)) } : {}),
    ...(cueIndex ? { cueIndex } : {}),
    ...(charactersChanged ? characterList(project) : {}),
  }
}

function setProposal<K extends keyof CueProposals>(cue: Cue, kind: K, value: CueProposals[K]): void {
  const next = { ...cue.proposals }
  if (value) next[kind] = value
  else delete next[kind]
  if (next.character || next.link) cue.proposals = next
  else delete cue.proposals
}

function uniqueCues(project: Project, ids: string[]): Cue[] {
  if (ids.length === 0) throw new Error('No lines given')
  return [...new Set(ids)].map((id) => cueById(project, id))
}

function propose(project: Project, items: ProposalItem[]): ChangeSet {
  const touched = new Map<string, Cue>()
  const cues = new Map(uniqueCues(project, items.map((item) => item.cueId)).map((cue) => [cue.id, cue]))
  for (const item of items) {
    const cue = cues.get(item.cueId) as Cue
    if (item.character !== undefined) {
      const character = item.character === null ? undefined : sanitizeCharacterProposal(item.character)
      if (item.character !== null && !character) throw new Error('Invalid character proposal')
      if (character) characterById(project, character.characterId)
      setProposal(cue, 'character', character)
      touched.set(cue.id, cue)
    }
    if (item.link !== undefined) {
      const link = item.link === null ? undefined : sanitizeLinkProposal(item.link)
      if (item.link !== null && !link) throw new Error('Invalid link proposal')
      if (link && !project.assets?.some((asset) => asset.id === link.assetId)) throw new Error('Asset not found')
      setProposal(cue, 'link', link)
      touched.set(cue.id, cue)
    }
  }
  return { cues: structuredClone([...touched.values()]) }
}

function acceptProposal(project: Project, cue: Cue, kind: ProposalKind): void {
  if (kind === 'text') {
    if (cue.suggestedText === undefined) return
    Object.assign(cue, changeCueText(cue, cue.suggestedText, project))
    delete cue.suggestedText
    if (cue.status === 'empty') cue.status = 'translated'
    return
  }
  if (kind === 'character') {
    const proposal = cue.proposals?.character
    setProposal(cue, 'character', undefined)
    if (!proposal || cue.characterId === proposal.characterId) return
    if (!project.characters.some((item) => item.id === proposal.characterId)) return
    cue.characterId = proposal.characterId
    Object.assign(cue, invalidateVoicedOutput(cue, project))
    return
  }
  const link = cue.proposals?.link
  setProposal(cue, 'link', undefined)
  if (link && project.assets?.some((asset) => asset.id === link.assetId)) cue.origins = withOrigin(cue.origins, { assetId: link.assetId, row: link.row })
}

function rejectProposal(cue: Cue, kind: ProposalKind): void {
  if (kind === 'text') delete cue.suggestedText
  else setProposal(cue, kind, undefined)
}

function settleProposals(project: Project, items: ProposalRef[], accept: boolean): ChangeSet {
  const cues = new Map(uniqueCues(project, items.map((item) => item.cueId)).map((cue) => [cue.id, cue]))
  for (const { cueId, kind } of items) {
    const cue = cues.get(cueId) as Cue
    if (accept) acceptProposal(project, cue, kind)
    else rejectProposal(cue, kind)
  }
  return { cues: structuredClone([...cues.values()]) }
}

export function applyProjectCommand(project: Project, command: ProjectCommand): ChangeSet {
  if (command.type === 'cue.propose') return propose(project, command.items)
  if (command.type === 'proposal.accept' || command.type === 'proposal.reject') {
    return settleProposals(project, command.items, command.type === 'proposal.accept')
  }
  if (command.type === 'cue.create') {
    if (command.lines.length === 0) throw new Error('No lines to create')
    const ids = new Set(command.lines.map((line) => line.id))
    if (ids.size !== command.lines.length || project.cues.some((cue) => ids.has(cue.id))) {
      throw new Error('Line id is already used')
    }
    const after = command.afterCueId === null ? project.cues.length - 1 : project.cues.findIndex((cue) => cue.id === command.afterCueId)
    if (after < 0 && command.afterCueId !== null) throw new Error('Cue not found')
    const first = nextLineNumber(project.cues)
    return insertCues(
      project,
      command.lines.map((line, i) => ({ cue: newLineCue(line.id, first + i, line.text), index: after + 1 + i }))
    )
  }
  if (command.type === 'cue.restore') {
    checkRestore(project, command.cues)
    return insertCues(project, structuredClone(command.cues))
  }
  if (command.type === 'cue.delete') return deleteCues(project, command.cueIds)
  if (command.type === 'table.step') return tableStep(project, command)
  if (command.type === 'character.setVoiceSettings') {
    const character = characterById(project, command.characterId)
    character.voiceSettings = structuredClone(command.settings)
    return characterOnly(character)
  }
  if (command.type === 'character.create') {
    if (project.characters.some((item) => item.id === command.id)) throw new Error('Character id is already used')
    project.characters.push(blankCharacter(command.id, uniqueName(project, command.name), project.characters.length))
    return characterList(project)
  }
  if (command.type === 'character.rename') {
    const character = characterById(project, command.characterId)
    character.name = uniqueName(project, command.name, character.id)
    return characterOnly(character)
  }
  if (command.type === 'character.setProvider') {
    const character = characterById(project, command.characterId)
    const provider = { ...character.provider }
    if (command.voiceId !== undefined) provider.voiceId = command.voiceId.trim()
    if (command.ttsModel !== undefined) provider.ttsModel = command.ttsModel
    if (command.stsModel !== undefined) provider.stsModel = command.stsModel
    const voiceChanged = provider.voiceId !== character.provider.voiceId
    character.provider = provider
    const changes = characterOnly(character)
    if (!voiceChanged) return changes
    return { ...changes, cues: invalidateCharacterCues(project, character.id) }
  }
  if (command.type === 'character.delete') {
    const character = characterById(project, command.characterId)
    if (command.reassignTo) {
      if (command.reassignTo === character.id) throw new Error('Cannot reassign cues to the character being deleted')
      characterById(project, command.reassignTo)
    }
    const moved: Cue[] = []
    for (const cue of project.cues) {
      const proposed = cue.proposals?.character?.characterId === character.id
      if (proposed) setProposal(cue, 'character', undefined)
      if (cue.characterId === character.id) {
        cue.characterId = command.reassignTo
        Object.assign(cue, invalidateVoicedOutput(cue, project))
      } else if (!proposed) continue
      moved.push(structuredClone(cue))
    }
    project.characters = project.characters.filter((item) => item.id !== character.id)
    return { ...characterList(project), cues: moved }
  }
  if (command.type === 'rules.set') {
    project.pronunciationRules = command.text
    return { pronunciationRules: command.text }
  }
  if (command.type === 'terms.set') {
    const terms = sanitizeTerms(command.terms)
    if (terms) project.terms = terms
    else delete project.terms
    return { terms: terms ?? null }
  }
  if (command.type === 'project.rename') {
    const name = command.name.trim()
    if (!name) throw new Error('Project name cannot be empty')
    project.name = name
    return { name }
  }
  if (command.type === 'project.setLanguages') {
    const languages = command.languages === null ? undefined : sanitizeLanguages(command.languages)
    if (command.languages !== null && !languages) throw new Error('Invalid language pair')
    if (languages) project.languages = languages
    else delete project.languages
    return { languages: languages ?? null }
  }
  if (command.type === 'project.setExportTemplate') {
    const template = command.template.trim()
    if (!template) throw new Error('Output name cannot be empty')
    project.exportTemplate = template
    return { exportTemplate: template }
  }
  if (command.type === 'project.setProvider') {
    const provider = command.provider === null ? undefined : sanitizeProviderSettings(command.provider)
    if (provider) project.provider = provider
    else delete project.provider
    return { provider: provider ?? null }
  }
  if (command.type === 'project.setExport') {
    const settings = command.settings === null ? undefined : sanitizeExportSettings(command.settings)
    if (settings) project.export = settings
    else delete project.export
    return { export: settings ?? null }
  }
  const cue = cueById(project, command.cueId)
  switch (command.type) {
    case 'cue.saveText':
      if (command.ifText !== undefined && cue.text !== command.ifText) break
      Object.assign(cue, savedText(cue, command.text, project))
      break
    case 'cue.approve':
      if (command.approved) Object.assign(cue, approveCue(cue, command.approvedAt, project))
      else {
        Object.assign(cue, removeApproval(cue, project))
        delete cue.approval
      }
      break
    case 'cue.setFinalTake': {
      const take = cue.takes.find((item) => item.id === command.takeId)
      if (!take) throw new Error('Take not found in this cue')
      if (take.kind === 'recording') throw new Error('A raw recording cannot be final — convert it first')
      Object.assign(cue, changeTakeOutput(cue, command.takeId, project))
      break
    }
    case 'cue.setComp': {
      if (command.comp === null) {
        delete cue.comp
        Object.assign(cue, changeCompOutput(cue, null, project))
        break
      }
      const problem = compProblem(command.comp)
      if (problem) throw new Error(`Invalid composition: ${problem}`)
      for (const clip of command.comp.clips) {
        if (!resolveTake(project, cue, clip.sourceTakeId)) throw new Error(`Composition clip "${clip.id}": take ${clip.sourceTakeId} is not in this cue`)
      }
      Object.assign(cue, changeCompOutput(cue, normalizeComp(command.comp), project))
      break
    }
    case 'cue.setOriginal': {
      if (command.original === null) {
        delete cue.original
        break
      }
      const original = sanitizeOriginal(command.original)
      if (!original) throw new Error('Invalid original lane settings')
      cue.original = original
      break
    }
    case 'cue.setStems': {
      if (command.stems === null) {
        delete cue.stems
        break
      }
      const stems = sanitizeStems(command.stems)
      if (!stems) throw new Error('Invalid stems')
      cue.stems = stems
      break
    }
        case 'cue.setTakePinned': {
      const take = cue.takes.find((item) => item.id === command.takeId)
      if (!take) throw new Error('Take not found in this cue')
      const pinned = sanitizePinned(command.pinned)
      if (pinned) take.pinned = pinned
      else {
        if (referencedByOtherComp(project, cue.id, take.id)) {
          throw new Error('This source is used on another line — remove it there first')
        }
        delete take.pinned
      }
      break
    }
    case 'cue.setTakeEffects': {
      const take = cue.takes.find((item) => item.id === command.takeId)
      if (!take) throw new Error('Take not found in this cue')
      const effects = command.effects === null ? undefined : sanitizeEffects(command.effects)
      if (JSON.stringify(effects ?? null) === JSON.stringify(take.edits.effects ?? null)) break
      if (effects) take.edits = { ...take.edits, effects }
      else {
        const { effects: _dropped, ...edits } = take.edits
        take.edits = edits
      }
      if (outputUsesTake(cue, take.id, project)) Object.assign(cue, invalidateVoicedOutput(cue, project))
      const others: Cue[] = []
      for (const other of project.cues) {
        if (other.id === cue.id || !outputUsesTake(other, take.id, project)) continue
        const next = invalidateVoicedOutput(other, project)
        if (next === other) continue
        Object.assign(other, next)
        others.push(structuredClone(other))
      }
      return { cues: [structuredClone(cue), ...others] }
    }
    case 'cue.setRegion': {
      if (command.region === null) {
        delete cue.region
        break
      }
      const region = sanitizeCueRegion(command.region)
      if (!region) throw new Error('Invalid region')
      if (!project.sources?.some((s) => s.id === region.sourceId)) {
        throw new Error(`Source "${region.sourceId}" is not in this project`)
      }
      cue.region = region
      break
    }
    case 'cue.acceptSuggestion':
      if (cue.suggestedText !== undefined) {
        Object.assign(cue, changeCueText(cue, cue.suggestedText, project))
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
      if ((cue.comp?.clips ?? []).some((clip) => clip.sourceTakeId === take.id)) {
        throw new Error('This source is used by a clip on this line — remove the clip first')
      }
      if (take.pinned && referencedByOtherComp(project, cue.id, take.id)) {
        throw new Error('This pinned source is used on another line')
      }
      if (!take.deletedAt) take.deletedAt = command.deletedAt ?? new Date().toISOString()
      if (cue.status === 'generated' && !hasVoicedTake(cue)) cue.status = cue.text.trim() ? 'translated' : 'empty'
      break
    }
    case 'cue.setExcluded':
      Object.assign(cue, setExcluded(cue, command.excluded, project))
      break
    case 'cue.useTakeAsOriginal': {
      const found = resolveTake(project, cue, command.takeId)
      if (!found || found.take.deletedAt) throw new Error('Take not found in this cue')
      cue.referenceAudio = structuredClone(found.take.file)
      if (found.take.duration > 0) cue.referenceDuration = found.take.duration
      else delete cue.referenceDuration
      if (mixesOriginal(cue)) Object.assign(cue, invalidateVoicedOutput(cue, project))
      break
    }
    case 'cue.restoreOriginal': {
      if (command.referenceAudio) cue.referenceAudio = structuredClone(command.referenceAudio)
      else delete cue.referenceAudio
      if (command.referenceDuration !== null) cue.referenceDuration = command.referenceDuration
      else delete cue.referenceDuration
      if (outputStateKey(cue) !== outputStateKey(command.whenState)) {
        if (mixesOriginal(cue)) Object.assign(cue, invalidateVoicedOutput(cue, project))
        break
      }
      restoreOutputState(cue, command)
      break
    }
    case 'cue.restoreOutput':
      if (sanitizeRevision(cue.textRevision) !== command.whenTextRevision) break
      if (outputStateKey(cue) === outputStateKey(command.whenState)) restoreOutputState(cue, command)
      break
    case 'cue.setCharacter': {
      if (command.characterId) characterById(project, command.characterId)
      if (cue.characterId === command.characterId) break
      cue.characterId = command.characterId
      Object.assign(cue, invalidateVoicedOutput(cue, project))
      break
    }
  }
  return { cues: [structuredClone(cue)] }
}

export function commandAudioPaths(command: ProjectCommand): string[] {
  if (command.type === 'cue.restoreOriginal') return command.referenceAudio ? [command.referenceAudio.relPath] : []
  const restored = command.type === 'cue.restore' ? command.cues : command.type === 'table.step' ? command.restore : []
  return restored.flatMap(({ cue }) => [
    ...cue.takes.map((take) => take.file.relPath),
    ...(cue.referenceAudio ? [cue.referenceAudio.relPath] : []),
    ...(cue.stems ?? []).map((stem) => stem.file.relPath),
  ])
}

export function audioWithinRoots(command: ProjectCommand, roots: string[]): boolean {
  return commandAudioPaths(command).every((file) => roots.some((root) => isInsideDir(file, root)))
}

export function applyChangeSet(project: Project, changes: ChangeSet): Project {
  let next = project
  if (changes.name !== undefined) next = { ...next, name: changes.name }
  if (changes.languages !== undefined) {
    if (changes.languages === null) {
      const { languages: _drop, ...rest } = next
      next = rest
    } else next = { ...next, languages: changes.languages }
  }
  if (changes.export !== undefined) {
    if (changes.export === null) {
      const { export: _dropped, ...rest } = next
      next = rest as Project
    } else next = { ...next, export: structuredClone(changes.export) }
  }
  if (changes.provider !== undefined) {
    if (changes.provider === null) {
      const { provider: _dropped, ...rest } = next
      next = rest as Project
    } else next = { ...next, provider: structuredClone(changes.provider) }
  }
  if (changes.versions) next = { ...next, versions: structuredClone(changes.versions) }
  if (changes.sources) next = { ...next, sources: structuredClone(changes.sources) }
  if (changes.assets) next = { ...next, assets: structuredClone(changes.assets) }
  if (changes.removedCueIds && changes.removedCueIds.length > 0) {
    const gone = new Set(changes.removedCueIds)
    next = { ...next, cues: next.cues.filter((cue) => !gone.has(cue.id)) }
  }
  if (changes.cues) {
    const replacements = new Map(changes.cues.map((cue) => [cue.id, cue]))
    const known = new Set(next.cues.map((cue) => cue.id))
    const fresh = changes.cues.filter((cue) => !known.has(cue.id))
    const at = changes.cueIndex ?? {}
    const cues = next.cues.map((cue) => replacements.get(cue.id) ?? cue)
    const placed = fresh.filter((cue) => at[cue.id] !== undefined).sort((a, b) => at[a.id] - at[b.id])
    for (const cue of placed) cues.splice(Math.max(0, Math.min(cues.length, at[cue.id])), 0, cue)
    next = { ...next, cues: cues.concat(fresh.filter((cue) => at[cue.id] === undefined)) }
  }
  if (changes.characters) {
    if (changes.charactersReplace) next = { ...next, characters: changes.characters }
    else {
      const replacements = new Map(changes.characters.map((character) => [character.id, character]))
      next = { ...next, characters: next.characters.map((character) => replacements.get(character.id) ?? character) }
    }
  }
  if (changes.exportTemplate !== undefined) next = { ...next, exportTemplate: changes.exportTemplate }
  if (changes.pronunciationRules !== undefined) next = { ...next, pronunciationRules: changes.pronunciationRules }
  if (changes.terms !== undefined) {
    if (changes.terms === null) {
      const { terms: _dropped, ...rest } = next
      next = rest as Project
    } else next = { ...next, terms: structuredClone(changes.terms) }
  }
  if (changes.linesFromTable) next = { ...next, linesFromTable: true }
  return next
}
