import { describe, expect, it, vi } from 'vitest'
import { SerialProjectRepository } from '../src/main/project-repository'
import { transcribeCues } from '../src/main/transcribe'
import { type Cue, type Project } from '../src/shared/domain'
import { applyChangeSet, type CommandResult } from '../src/shared/project-commands'

function cue(id: string, sourceText = ''): Cue {
  return {
    id, characterId: 'ch', key: id, fields: {}, sourceText, text: '', status: 'empty', notes: '', takes: [],
    referenceAudio: { fileId: id, relPath: `${id}.wav`, format: 'wav' },
  }
}

function project(): Project {
  return {
    id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', pronunciationRules: '',
    media: { referenceDir: '', referencePattern: '' }, sessions: [], exportTemplate: '',
    characters: [{ id: 'ch', name: 'Ada', color: '#fff', provider: { providerId: 'elevenlabs', voiceId: 'v', ttsModel: 'm', stsModel: 's' }, voiceSettings: { stability: .5, similarity: .5, style: 0, speed: 1, boost: true } }],
    cues: [cue('a'), cue('b')],
    ui: { filter: '', search: '' },
  }
}

function deferred(): { promise: Promise<string>; resolve: (text: string) => void; reject: (error: Error) => void } {
  let resolve!: (text: string) => void
  let reject!: (error: Error) => void
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('transcription against the serial repository', () => {
  it('keeps a source text that arrived while speech-to-text was running', async () => {
    const repo = new SerialProjectRepository(project(), vi.fn(), 1)
    const pending = deferred()
    const run = transcribeCues(repo, ['a'], false, () => pending.promise, vi.fn())
    await tick()
    const live = repo.projectForMain().cues[0]
    live.sourceText = 'imported'
    await repo.commit({ cues: [live] })
    pending.resolve('heard')
    await run
    expect(repo.snapshot().project.cues[0].sourceText).toBe('imported')
  })

  it('applies texts collected before a failed request and rethrows the original error', async () => {
    const initial = project()
    initial.cues.push(cue('c'))
    const repo = new SerialProjectRepository(initial, vi.fn(), 1)
    const quota = new Error('quota exceeded')
    const stt = vi.fn(async (ref: { fileId: string }) => {
      if (ref.fileId === 'b') throw quota
      return `text ${ref.fileId}`
    })
    const published: CommandResult[] = []
    await expect(transcribeCues(repo, ['a', 'b', 'c'], false, stt, (r) => published.push(r))).rejects.toBe(quota)
    expect(stt).toHaveBeenCalledTimes(2)
    expect(published).toHaveLength(1)
    expect(published[0].revision).toBe(1)
    expect(published[0].changes.cues?.map((c) => [c.id, c.sourceText])).toEqual([['a', 'text a']])
    const { revision, project: current } = repo.snapshot()
    expect(revision).toBe(1)
    expect(current.cues.map((c) => c.sourceText)).toEqual(['text a', '', ''])
    expect(applyChangeSet(initial, published[0].changes)).toEqual(current)
  })

  it('publishes one change set whose replay matches the repository', async () => {
    const initial = project()
    const repo = new SerialProjectRepository(initial, vi.fn(), 1)
    const results: CommandResult[] = []
    const run = transcribeCues(repo, ['a', 'b'], false, async (ref) => `text ${ref.fileId}`, (r) => results.push(r))
    results.push(await repo.execute({ type: 'cue.saveText', cueId: 'b', text: 'typed' }))
    await run
    const replay = results
      .sort((x, y) => x.revision - y.revision)
      .reduce((p, r) => applyChangeSet(p, r.changes), initial)
    expect(replay).toEqual(repo.snapshot().project)
    expect(repo.snapshot().project.cues.map((c) => [c.sourceText, c.text])).toEqual([['text a', ''], ['text b', 'typed']])
  })
})

describe('repository mutations', () => {
  it('runs in queue order with commands and bumps the revision once', async () => {
    const repo = new SerialProjectRepository(project(), vi.fn(), 1)
    const first = repo.execute({ type: 'cue.saveText', cueId: 'a', text: 'one' })
    const second = repo.mutate((p) => {
      p.cues[0].notes = p.cues[0].text
      return { cues: [p.cues[0]] }
    })
    expect((await first).revision).toBe(1)
    const result = await second
    expect(result).toMatchObject({ revision: 2, changes: { cues: [{ id: 'a', notes: 'one' }] } })
    result!.changes.cues![0].notes = 'renderer'
    expect(repo.snapshot().project.cues[0].notes).toBe('one')
  })

  it('does not advance the revision for a rejected or empty mutation', async () => {
    const repo = new SerialProjectRepository(project(), vi.fn(), 1)
    await expect(repo.mutate(() => { throw new Error('Cue not found') })).rejects.toThrow('Cue not found')
    await expect(repo.mutate(() => null)).resolves.toBeNull()
    expect((await repo.execute({ type: 'cue.saveText', cueId: 'a', text: 'ok' })).revision).toBe(1)
  })

  it('rejects mutations after detach', async () => {
    const repo = new SerialProjectRepository(project(), vi.fn(), 1)
    await repo.detach()
    await expect(repo.mutate(() => ({}))).rejects.toThrow('detached')
  })
})
