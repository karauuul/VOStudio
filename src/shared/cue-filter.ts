import { approvalState, hasValidVoicedOutput } from './approval'
import { hasVoicedTake, type Character, type Cue } from './domain'

export const DEFAULT_FILTER = 'work'
export const ALL_CHARACTERS = 'all'

export const FILTERS: { id: string; label: string }[] = [
  { id: 'work', label: 'Working set' },
  { id: 'notgen', label: 'Needs output' },
  { id: 'review', label: 'Review' },
  { id: 'gen', label: 'Outputs' },
  { id: 'appr', label: 'Approved' },
  { id: 'sugg', label: 'Suggestions' },
  { id: 'excluded', label: 'Excluded' },
  { id: 'all', label: 'All' },
]

export function matchesFilter(cue: Cue, filter: string): boolean {
  switch (filter) {
    case 'work':
      return cue.status !== 'excluded'
    case 'translated':
      return cue.status === 'translated'
    case 'gen':
      return hasValidVoicedOutput(cue)
    case 'notgen':
      return !hasValidVoicedOutput(cue) && cue.status !== 'excluded'
    case 'review':
      return hasValidVoicedOutput(cue) && cue.status !== 'excluded' && approvalState(cue) !== 'approved'
    case 'appr':
      return cue.status !== 'excluded' && approvalState(cue) === 'approved'
    case 'sugg':
      return cue.suggestedText !== undefined
    case 'excluded':
      return cue.status === 'excluded'
    default:
      return true
  }
}

export function matchesCharacter(cue: Cue, characterId: string): boolean {
  return characterId === ALL_CHARACTERS || cue.characterId === characterId
}

export function matchesSearch(cue: Cue, search: string): boolean {
  if (!search) return true
  const q = search.toLowerCase()
  return (
    (cue.fields['EventName'] ?? '').toLowerCase().includes(q) ||
    cue.text.toLowerCase().includes(q) ||
    cue.sourceText.toLowerCase().includes(q) ||
    cue.key.toLowerCase().includes(q)
  )
}

export function filterCues(
  cues: Cue[],
  filter: string,
  search: string,
  characterId: string = ALL_CHARACTERS
): Cue[] {
  return cues.filter(
    (c) => matchesFilter(c, filter) && matchesCharacter(c, characterId) && matchesSearch(c, search)
  )
}

export function filterCounts(
  cues: Cue[],
  search: string,
  characterId: string = ALL_CHARACTERS
): Record<string, number> {
  const scope = cues.filter((c) => matchesCharacter(c, characterId) && matchesSearch(c, search))
  const counts: Record<string, number> = {}
  for (const f of FILTERS) counts[f.id] = scope.filter((c) => matchesFilter(c, f.id)).length
  return counts
}

export type ReviewLabel =
  | 'Approved'
  | 'Needs review'
  | 'Stale approval'
  | 'Needs output'
  | 'Needs voice'
  | 'Excluded'

export function reviewLabel(cue: Cue): ReviewLabel {
  if (cue.status === 'excluded') return 'Excluded'
  const state = approvalState(cue)
  if (state === 'approved') return 'Approved'
  if (state === 'stale') return 'Stale approval'
  if (state === 'needs-review') return 'Needs review'
  return hasVoicedTake(cue) ? 'Needs output' : 'Needs voice'
}

export interface GenerateReview {
  eligible: Cue[]
  busy: number
  missingText: number
  missingVoice: number
  excluded: number
}

export function reviewGeneration(
  cues: Cue[],
  characters: Pick<Character, 'id' | 'provider'>[],
  isBusy: (cueId: string) => boolean
): GenerateReview {
  const voiced = new Set(characters.filter((c) => c.provider.voiceId).map((c) => c.id))
  const review: GenerateReview = {
    eligible: [],
    busy: 0,
    missingText: 0,
    missingVoice: 0,
    excluded: 0,
  }
  for (const cue of cues) {
    if (cue.status === 'excluded') review.excluded++
    else if (isBusy(cue.id)) review.busy++
    else if (!cue.text.trim()) review.missingText++
    else if (!voiced.has(cue.characterId)) review.missingVoice++
    else review.eligible.push(cue)
  }
  return review
}
