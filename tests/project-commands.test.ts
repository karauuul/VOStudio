import { describe, expect, it, vi } from 'vitest'
import { applyChangeSet, applyProjectCommand, type ProjectCommand } from '../src/shared/project-commands'
import { SerialProjectRepository } from '../src/main/project-repository'
import { emptyEdits, type Project } from '../src/shared/domain'
import { projectCommandSchema } from '../src/main/schemas'
import { approvalState } from '../src/shared/approval'
import { setupImportedProject, setupOpenedProject } from '../src/main/project-import'

function project(): Project {
  return {
    id: 'p', schemaVersion: 1, createdAt: 'now', name: 'P', pronunciationRules: '',
    characters: [{ id: 'ch', name: 'Ada', color: '#fff', provider: { providerId: 'elevenlabs', voiceId: 'v', ttsModel: 'm', stsModel: 's' }, voiceSettings: { stability: .5, similarity: .5, style: 0, speed: 1, boost: true } }],
    cues: [{ id: 'c', characterId: 'ch', key: '1', fields: {}, sourceText: 'S', text: 'T', status: 'generated', notes: '', takes: [{ id: 't', kind: 'tts', createdAt: 'now', file: { fileId: 't', relPath: 't.mp3', format: 'mp3' }, duration: 1, meta: {}, edits: emptyEdits() }], finalTakeId: 't' }],
    ui: { filter: '', search: '' },
  }
}

describe('project commands', () => {
  it('validates the command boundary without stripping command data', () => {
    const command: ProjectCommand = { type: 'cue.saveText', cueId: 'c', text: 'Changed' }
    expect(projectCommandSchema.parse(command)).toEqual(command)
    expect(() => projectCommandSchema.parse({ ...command, cueId: '' })).toThrow()
  })
  it('returns the authoritative entity as a ChangeSet', () => {
    const p = project()
    const change = applyProjectCommand(p, { type: 'cue.saveText', cueId: 'c', text: 'Changed' })
    expect(change.cues?.[0]).toMatchObject({ id: 'c', text: 'Changed', textRevision: 1 })
    expect(applyChangeSet(project(), change)).toEqual(p)
  })

  it('keeps Must 1 transitions in main command logic', () => {
    const p = project()
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'c', approved: true, approvedAt: 'then' })
    const change = applyProjectCommand(p, { type: 'cue.saveText', cueId: 'c', text: 'Changed' })
    expect(change.cues?.[0].status).toBe('generated')
    expect(change.cues?.[0].approval).toMatchObject({ approvedAt: 'then' })
  })

  it('removes approval when a cue is unapproved', () => {
    const p = project()
    applyProjectCommand(p, { type: 'cue.approve', cueId: 'c', approved: true, approvedAt: 'then' })
    const change = applyProjectCommand(p, { type: 'cue.approve', cueId: 'c', approved: false })
    expect(change.cues?.[0]).not.toHaveProperty('approval')
    expect(approvalState(p.cues[0])).not.toBe('approved')
  })
})

describe('serial project repository', () => {
  it('serializes concurrent commands and returns monotonic revisions', async () => {
    const repo = new SerialProjectRepository(project(), vi.fn(), 1)
    const commands: ProjectCommand[] = [
      { type: 'cue.saveText', cueId: 'c', text: 'one' },
      { type: 'cue.saveText', cueId: 'c', text: 'two' },
      { type: 'cue.saveText', cueId: 'c', text: 'three' },
    ]
    const results = await Promise.all(commands.map((c) => repo.execute(c)))
    expect(results.map((r) => r.revision)).toEqual([1, 2, 3])
    expect(repo.snapshot().project.cues[0].text).toBe('three')
  })

  it('deeply owns its project and returns detached snapshots', () => {
    const source = project()
    const repo = new SerialProjectRepository(source, vi.fn(), 1)
    source.cues[0].text = 'outside'
    const snapshot = repo.snapshot()
    snapshot.project.cues[0].text = 'renderer'
    expect(repo.snapshot().project.cues[0].text).toBe('T')
  })

  it('coalesces persistence without losing an edit arriving during a write', async () => {
    let release!: () => void
    const firstWrite = new Promise<void>((resolve) => { release = resolve })
    const saved: string[] = []
    const persist = vi.fn(async (p: Project) => {
      saved.push(p.cues[0].text)
      if (saved.length === 1) await firstWrite
    })
    const repo = new SerialProjectRepository(project(), persist, 1)
    await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'one' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'two' })
    release()
    await repo.flush()
    expect(saved).toEqual(['one', 'two'])
  })

  it('does not advance revision for a rejected command', async () => {
    const repo = new SerialProjectRepository(project(), vi.fn(), 1)
    await expect(repo.execute({ type: 'cue.setFinalTake', cueId: 'c', takeId: 'missing' })).rejects.toThrow()
    expect((await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'ok' })).revision).toBe(1)
  })

  it('recovers persistence after a rejected write and saves later edits', async () => {
    const saved: string[] = []
    const persist = vi.fn(async (p: Project) => {
      if (persist.mock.calls.length === 1) throw new Error('disk unavailable')
      saved.push(p.cues[0].text)
    })
    const repo = new SerialProjectRepository(project(), persist, 1)
    await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'first' })
    await expect(repo.flush()).rejects.toThrow('disk unavailable')
    await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'second' })
    await expect(repo.flush()).resolves.toBeUndefined()
    expect(saved).toEqual(['second'])
  })

  it('flushes a pending debounce persist when detached', async () => {
    vi.useFakeTimers()
    try {
      const persist = vi.fn()
      const repo = new SerialProjectRepository(project(), persist, 100)
      await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'dirty' })

      await repo.detach()
      await vi.advanceTimersByTimeAsync(100)

      expect(persist).toHaveBeenCalledOnce()
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ cues: [expect.objectContaining({ text: 'dirty' })] }))
      await expect(repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'late' })).rejects.toThrow('detached')
      await expect(repo.commit({ cues: [] })).rejects.toThrow('detached')
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for an in-flight persist before detach completes', async () => {
    let release!: () => void
    const writing = new Promise<void>((resolve) => { release = resolve })
    const persist = vi.fn(async () => writing)
    const repo = new SerialProjectRepository(project(), persist, 1)
    await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'dirty' })
    await new Promise((resolve) => setTimeout(resolve, 5))

    let detached = false
    const detaching = repo.detach().then(() => { detached = true })
    await Promise.resolve()
    expect(detached).toBe(false)

    release()
    await detaching
    expect(detached).toBe(true)
  })

  it('persists a command accepted before detach', async () => {
    const persist = vi.fn()
    const repo = new SerialProjectRepository(project(), persist, 1)
    const queued = repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'queued' })

    await repo.detach()

    await expect(queued).resolves.toMatchObject({ revision: 1 })
    expect(repo.snapshot().project.cues[0].text).toBe('queued')
    expect(persist).toHaveBeenCalledOnce()
  })

  it('remains usable when persistence fails during detach', async () => {
    const saved: string[] = []
    const persist = vi.fn(async (p: Project) => {
      if (persist.mock.calls.length === 1) throw new Error('disk full')
      saved.push(p.cues[0].text)
    })
    const repo = new SerialProjectRepository(project(), persist, 100)
    await repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'dirty' })

    await expect(repo.detach()).rejects.toThrow('disk full')
    await expect(repo.execute({ type: 'cue.saveText', cueId: 'c', text: 'still usable' })).resolves.toMatchObject({ revision: 2 })
    await expect(repo.flush()).resolves.toBeUndefined()

    expect(repo.snapshot().project.cues[0].text).toBe('still usable')
    expect(saved).toEqual(['still usable'])
  })
})

describe('imported project setup', () => {
  it('restores a usable previous repository when target creation fails', async () => {
    const previous = project()
    previous.id = 'previous'
    let current: Project | null = previous
    let repository = new SerialProjectRepository(previous, vi.fn(), 1)
    const saved: string[] = []

    await expect(setupImportedProject({
      stageImport: async () => project(),
      detachCurrent: () => repository.detach(),
      importProject: async () => { throw new Error('ui.json write rejected') },
      currentProject: () => current!,
      resetRepository: (restored) => {
        repository = new SerialProjectRepository(restored, async (p) => { saved.push(p.cues[0].text) }, 1)
        return repository
      },
      finishImport: async () => undefined,
    })).rejects.toThrow('ui.json write rejected')

    await expect(repository.execute({ type: 'cue.saveText', cueId: 'c', text: 'still open' })).resolves.toMatchObject({ revision: 1 })
    await repository.flush()
    expect(repository.snapshot().project).toMatchObject({ id: 'previous', cues: [{ text: 'still open' }] })
    expect(saved).toEqual(['still open'])
  })

  it('keeps the previous repository usable when staging the import fails', async () => {
    const previous = project()
    previous.id = 'previous'
    const saves: string[] = []
    const repository = new SerialProjectRepository(previous, async (p) => {
      saves.push(p.id)
    }, 1)
    const detachCurrent = vi.fn(() => repository.detach())

    await expect(setupImportedProject({
      stageImport: async () => { throw new Error('malformed CSV') },
      detachCurrent,
      importProject: async () => undefined,
      currentProject: () => previous,
      resetRepository: () => repository,
      finishImport: async () => undefined,
    })).rejects.toThrow('malformed CSV')

    expect(detachCurrent).not.toHaveBeenCalled()
    await repository.execute({ type: 'cue.saveText', cueId: 'c', text: 'still open' })
    await repository.flush()
    expect(repository.snapshot().project.cues[0].text).toBe('still open')
    expect(saves).toEqual(['previous'])
  })

  it('persists a pending edit to the previous project before import switches paths', async () => {
    vi.useFakeTimers()
    try {
      const previous = project()
      previous.id = 'previous'
      const imported = project()
      imported.id = 'imported'
      let destination = previous.id
      const saves: string[] = []
      const staleRepository = new SerialProjectRepository(previous, async (p) => {
        saves.push(`${p.id}:${p.cues[0].text}->${destination}`)
      }, 100)
      await staleRepository.execute({ type: 'cue.saveText', cueId: 'c', text: 'dirty' })

      await setupImportedProject({
        stageImport: async () => imported,
        detachCurrent: () => staleRepository.detach(),
        importProject: async () => { destination = imported.id },
        currentProject: () => imported,
        resetRepository: (next) => new SerialProjectRepository(next, vi.fn(), 100),
        finishImport: async () => undefined,
      })
      await vi.advanceTimersByTimeAsync(100)

      expect(saves).toEqual(['previous:dirty->previous'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists a command accepted while staging before import switches paths', async () => {
    const previous = project()
    previous.id = 'previous'
    const imported = project()
    imported.id = 'imported'
    let destination = previous.id
    const saves: string[] = []
    const staleRepository = new SerialProjectRepository(previous, async (p) => {
      saves.push(`${p.id}->${destination}`)
    }, 1)
    const queued = staleRepository.execute({ type: 'cue.saveText', cueId: 'c', text: 'queued' })

    await setupImportedProject({
      stageImport: async () => imported,
      detachCurrent: () => staleRepository.detach(),
      importProject: async () => { destination = imported.id },
      currentProject: () => imported,
      resetRepository: (next) => new SerialProjectRepository(next, vi.fn(), 1),
      finishImport: async () => undefined,
    })

    await expect(queued).resolves.toMatchObject({ revision: 1 })
    expect(saves).toEqual(['previous->previous'])
  })

  it('attaches suggestion persistence to the imported project repository', async () => {
    const previous = project()
    previous.id = 'previous'
    const imported = project()
    imported.id = 'imported'
    let current = previous
    let repository = new SerialProjectRepository(previous, vi.fn(), 1)
    const saved: string[] = []

    const snapshot = await setupImportedProject({
      stageImport: async () => imported,
      detachCurrent: () => repository.detach(),
      importProject: async () => { current = imported },
      currentProject: () => current,
      resetRepository: (next) => {
        repository = new SerialProjectRepository(next, async (p) => { saved.push(p.id) }, 1)
        return repository
      },
      finishImport: async (importedRepository) => {
        importedRepository.projectForMain().cues[0].suggestedText = 'Suggestion'
        await importedRepository.commit({ cues: [importedRepository.projectForMain().cues[0]] })
        await importedRepository.flush()
      },
    })

    expect(saved).toEqual(['imported'])
    expect(snapshot.project).toMatchObject({ id: 'imported', cues: [{ suggestedText: 'Suggestion' }] })
  })

  it('attaches openLast suggestion persistence to the opened project repository', async () => {
    const previous = project()
    previous.id = 'previous'
    const opened = project()
    opened.id = 'opened'
    let activeProjectId = previous.id
    const saves: string[] = []
    const persist = async (p: Project): Promise<void> => { saves.push(`${p.id}->${activeProjectId}`) }
    const staleRepository = new SerialProjectRepository(previous, persist, 1)
    await staleRepository.commit({ cues: [staleRepository.projectForMain().cues[0]] })

    const snapshot = await setupOpenedProject({
      detachCurrent: () => staleRepository.detach(),
      openProject: async () => {
        activeProjectId = opened.id
        return opened
      },
      prepareProject: async () => undefined,
      resetRepository: (next) => new SerialProjectRepository(next, persist, 1),
      abandonProject: () => undefined,
      finishOpen: async (openedRepository) => {
        openedRepository.projectForMain().cues[0].suggestedText = 'Suggestion'
        await openedRepository.commit({ cues: [openedRepository.projectForMain().cues[0]] })
        await openedRepository.flush()
      },
    })

    await staleRepository.flush()
    expect(saves).toEqual(['previous->previous', 'opened->opened'])
    expect(snapshot?.project).toMatchObject({ id: 'opened', cues: [{ suggestedText: 'Suggestion' }] })
  })

  it('rolls back a half-opened project when a post-open step fails', async () => {
    const opened = project()
    opened.id = 'opened'
    let abandoned = 0

    await expect(
      setupOpenedProject({
        detachCurrent: async () => undefined,
        openProject: async () => opened,
        prepareProject: async () => {
          throw new Error('migration failed')
        },
        resetRepository: (next) => new SerialProjectRepository(next, vi.fn(), 1),
        abandonProject: () => {
          abandoned++
        },
        finishOpen: async () => undefined,
      })
    ).rejects.toThrow('migration failed')
    expect(abandoned).toBe(1)
  })

  it('rolls back when finishOpen fails too — the repository is already created', async () => {
    const opened = project()
    opened.id = 'opened'
    let abandoned = 0

    await expect(
      setupOpenedProject({
        detachCurrent: async () => undefined,
        openProject: async () => opened,
        prepareProject: async () => undefined,
        resetRepository: (next) => new SerialProjectRepository(next, vi.fn(), 1),
        abandonProject: () => {
          abandoned++
        },
        finishOpen: async () => {
          throw new Error('suggestions failed')
        },
      })
    ).rejects.toThrow('suggestions failed')
    expect(abandoned).toBe(1)
  })

  it('detaches before import changes the persistence destination', async () => {
    const previous = project()
    previous.id = 'previous'
    const imported = project()
    imported.id = 'imported'
    let destination = previous.id
    let release!: () => void
    const writing = new Promise<void>((resolve) => { release = resolve })
    const saves: string[] = []
    const staleRepository = new SerialProjectRepository(previous, async (p) => {
      await writing
      saves.push(`${p.id}->${destination}`)
    }, 1)
    await staleRepository.execute({ type: 'cue.saveText', cueId: 'c', text: 'dirty' })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const setup = setupImportedProject({
      stageImport: async () => imported,
      detachCurrent: () => staleRepository.detach(),
      importProject: async () => { destination = imported.id },
      currentProject: () => imported,
      resetRepository: (next) => new SerialProjectRepository(next, vi.fn(), 1),
      finishImport: async () => undefined,
    })
    await Promise.resolve()
    expect(destination).toBe('previous')

    release()
    await setup
    expect(saves).toEqual(['previous->previous'])
  })
})
