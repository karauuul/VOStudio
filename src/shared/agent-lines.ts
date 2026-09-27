import { approvalState, isDone } from './approval'
import { ALL_CHARACTERS, filterCues, FILTERS, outputDuration } from './cue-filter'
import { clipSpeed, liveTakes, type Character, type Cue, type Project } from './domain'
import { readinessRows, summarize, type LineRow } from './readiness'

export const LINE_FILTERS = FILTERS.map((f) => f.id) as [string, ...string[]]
export const LINES_PAGE_DEFAULT = 50
export const LINES_PAGE_MAX = 200
export const CONCISE_TEXT_MAX = 120

export function findLine(project: Pick<Project, 'cues'>, ref: string): Cue {
  const byId = project.cues.find((cue) => cue.id === ref)
  if (byId) return byId
  const byKey = project.cues.filter((cue) => cue.key === ref)
  if (byKey.length === 1) return byKey[0]
  if (byKey.length > 1) {
    throw new Error(`Line key "${ref}" matches ${byKey.length} lines (ids ${byKey.map((cue) => cue.id).join(', ')}); pass one of these ids instead.`)
  }
  throw new Error(`No line has key or id "${ref}"; call lines to list them.`)
}

export function findCharacter(project: Pick<Project, 'characters'>, ref: string): Character {
  const wanted = ref.trim().toLowerCase()
  const found =
    project.characters.find((c) => c.id === ref) ?? project.characters.find((c) => c.name.trim().toLowerCase() === wanted)
  if (!found) throw new Error(`No character "${ref}"; call characters to list them.`)
  return found
}

const characterName = (project: Project, cue: Cue): string | null =>
  project.characters.find((c) => c.id === cue.characterId)?.name ?? null

const concise = (text: string): string =>
  text.length > CONCISE_TEXT_MAX ? `${text.slice(0, CONCISE_TEXT_MAX - 1)}…` : text

const readinessById = (project: Project): Map<string, LineRow> =>
  new Map(readinessRows(project).map((row) => [row.cueId, row]))

export interface LineQuery {
  filter?: string
  character?: string
  search?: string
  cursor?: string
  limit?: number
  detail?: 'concise' | 'full'
}

export function cursorOffset(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return 0
  const offset = /^\d+$/.test(cursor) ? Number(cursor) : NaN
  if (!Number.isSafeInteger(offset) || offset > total) {
    throw new Error('Invalid cursor; pass the nextCursor value from the previous lines call.')
  }
  return offset
}

export function offsetPage<T>(items: T[], cursor: string | undefined, limit: number): { page: T[]; nextCursor?: string } {
  const start = cursorOffset(cursor, items.length)
  const next = start + limit
  return { page: items.slice(start, next), ...(next < items.length ? { nextCursor: String(next) } : {}) }
}

export function stablePage<T>(
  items: T[],
  cueOf: (item: T) => Cue,
  cues: Cue[],
  cursor: string | undefined,
  limit: number
): { page: T[]; nextCursor?: string } {
  const positions = new Map(cues.map((cue, i) => [cue.id, i]))
  const position = (item: T): number => positions.get(cueOf(item).id) ?? cues.length
  const resume = cursorOffset(cursor, cues.length)
  const found = items.findIndex((item) => position(item) >= resume)
  const start = found < 0 ? items.length : found
  const page = items.slice(start, start + limit)
  const next = items[start + limit]
  return { page, ...(next === undefined ? {} : { nextCursor: String(position(next)) }) }
}

export function listLines(project: Project, query: LineQuery): Record<string, unknown> {
  const characterId = query.character ? findCharacter(project, query.character).id : ALL_CHARACTERS
  const matched = filterCues(project.cues, query.filter ?? 'all', query.search ?? '', characterId)
  const limit = Math.min(LINES_PAGE_MAX, Math.max(1, query.limit ?? LINES_PAGE_DEFAULT))
  const { page, nextCursor } = stablePage(matched, (cue) => cue, project.cues, query.cursor, limit)
  const readiness = readinessById(project)
  const full = query.detail === 'full'
  const rows = page.map((cue) => {
    const duration = outputDuration(cue)
    return {
      key: cue.key,
      id: cue.id,
      character: characterName(project, cue),
      text: full ? cue.text : concise(cue.text),
      ...(full ? { source: cue.sourceText } : {}),
      ...(full && cue.suggestedText !== undefined ? { suggested: cue.suggestedText } : {}),
      ...(full && cue.notes ? { notes: cue.notes } : {}),
      status: cue.status,
      takes: liveTakes(cue).length,
      ...(duration === undefined ? {} : { duration }),
      readiness: readiness.get(cue.id)?.status ?? 'no-audio',
    }
  })
  return { total: matched.length, rows, ...(nextCursor === undefined ? {} : { nextCursor }) }
}

export function lineDetail(project: Project, cue: Cue): Record<string, unknown> {
  const character = project.characters.find((c) => c.id === cue.characterId)
  return {
    key: cue.key,
    id: cue.id,
    character: character ? { id: character.id, name: character.name } : null,
    status: cue.status,
    done: isDone(cue, project),
    approval: approvalState(cue, project),
    source: cue.sourceText,
    text: cue.text,
    ...(cue.suggestedText === undefined ? {} : { suggested: cue.suggestedText }),
    notes: cue.notes,
    takes: cue.takes.map((take) => ({
      id: take.id,
      kind: take.kind,
      ...(take.meta.provider ? { provider: take.meta.provider } : {}),
      ...(take.meta.model ? { model: take.meta.model } : {}),
      duration: take.duration,
      createdAt: take.createdAt,
      ...(take.meta.text === undefined ? {} : { text: take.meta.text }),
      ...(take.pinned ? { pinned: true } : {}),
      ...(take.fragment ? { fragment: true } : {}),
      ...(take.deletedAt ? { deleted: true } : {}),
    })),
    comp: cue.comp
      ? cue.comp.clips.map((clip) => {
          const speed = clipSpeed(clip.edits)
          return {
            id: clip.id,
            takeId: clip.sourceTakeId,
            ...(clip.trackId ? { trackId: clip.trackId } : {}),
            start: clip.start,
            end: clip.start + (clip.srcOut - clip.srcIn) / speed,
            srcIn: clip.srcIn,
            srcOut: clip.srcOut,
            speed,
            gainDb: clip.edits.gainDb,
            effects: clip.edits.effects !== undefined,
          }
        })
      : null,
    output: cue.output ?? null,
    readiness: readinessById(project).get(cue.id) ?? null,
  }
}

export function projectOverview(project: Project, dir: string | null): Record<string, unknown> {
  const statuses: Record<string, number> = {}
  for (const cue of project.cues) statuses[cue.status] = (statuses[cue.status] ?? 0) + 1
  return {
    name: project.name,
    dir,
    lines: project.cues.length,
    statuses,
    characters: project.characters.length,
    readiness: summarize(project, readinessRows(project)),
  }
}
