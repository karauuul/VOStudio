import { changeCueSourceText } from '@shared/approval'
import type { AudioRef, Cue, Project } from '@shared/domain'
import type { CommandResult } from '@shared/project-commands'
import type { SerialProjectRepository } from './project-repository'

const transcribable = (project: Project, cueId: string, overwrite: boolean): Cue | undefined => {
  const cue = project.cues.find((c) => c.id === cueId)
  return cue?.referenceAudio && (overwrite || !cue.sourceText.trim()) ? cue : undefined
}

export async function transcribeCues(
  repository: SerialProjectRepository,
  cueIds: string[],
  overwrite: boolean,
  stt: (ref: AudioRef) => Promise<string>,
  publish: (result: CommandResult) => void
): Promise<{ updated: number; skipped: number }> {
  const texts = new Map<string, { ref: AudioRef; text: string }>()
  let failure: { error: unknown } | null = null
  for (const cueId of cueIds) {
    const ref = transcribable(repository.projectForMain(), cueId, overwrite)?.referenceAudio
    if (!ref) continue
    try {
      const text = await stt(ref)
      if (text) texts.set(cueId, { ref, text })
    } catch (error) {
      failure = { error }
      break
    }
  }
  const changed: Cue[] = []
  const published = await repository.mutate((project) => {
    for (const [cueId, { ref, text }] of texts) {
      const cue = transcribable(project, cueId, overwrite)
      if (!cue || cue.referenceAudio?.relPath !== ref.relPath) continue
      Object.assign(cue, changeCueSourceText(cue, text, project))
      changed.push(cue)
    }
    return changed.length > 0 ? { cues: changed } : null
  })
  if (published) publish(published)
  if (failure) throw failure.error
  return { updated: changed.length, skipped: cueIds.length - changed.length }
}
