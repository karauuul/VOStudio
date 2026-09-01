import type { Project } from '@shared/domain'
import { applyProjectCommand, type ChangeSet, type CommandResult, type ProjectCommand, type ProjectSnapshot } from '@shared/project-commands'

export class SerialProjectRepository {
  private project: Project
  private revision = 0
  private queue: Promise<unknown> = Promise.resolve()
  private dirtyRevision = 0
  private enqueuedRevision = 0
  private persistedRevision = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private persistRun: Promise<void> = Promise.resolve()
  private accepting = true
  private detached = false

  constructor(project: Project, private readonly persist: (project: Project) => Promise<unknown>, private readonly debounceMs = 1500) {
    this.project = structuredClone(project)
  }

  snapshot(): ProjectSnapshot { return { revision: this.revision, project: structuredClone(this.project) } }
  projectForMain(): Project { return this.project }

  execute(command: ProjectCommand): Promise<CommandResult> {
    if (!this.accepting) return Promise.reject(new Error('Project repository is detached'))
    const run = this.queue.then(() => {
      this.assertAttached()
      const changes = applyProjectCommand(this.project, structuredClone(command))
      this.revision++
      this.dirtyRevision = this.revision
      this.schedule()
      return { revision: this.revision, changes }
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  commit(changes: ChangeSet): Promise<CommandResult> {
    if (!this.accepting) return Promise.reject(new Error('Project repository is detached'))
    const run = this.queue.then(() => {
      this.assertAttached()
      this.revision++
      this.dirtyRevision = this.revision
      this.schedule()
      return { revision: this.revision, changes: structuredClone(changes) }
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private schedule(): void {
    if (this.detached) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.startPersist() }, this.debounceMs)
  }

  private startPersist(): void {
    if (this.detached) return
    if (this.dirtyRevision <= this.enqueuedRevision) return
    const revision = this.dirtyRevision
    this.enqueuedRevision = revision
    const snapshot = structuredClone(this.project)
    this.persistRun = this.persistRun.catch(() => undefined).then(async () => {
      if (this.detached) return
      await this.persist(snapshot)
      this.persistedRevision = Math.max(this.persistedRevision, revision)
      if (!this.detached && this.dirtyRevision > this.persistedRevision) this.startPersist()
    })
  }

  private assertAttached(): void {
    if (this.detached) throw new Error('Project repository is detached')
  }

  async detach(): Promise<void> {
    this.accepting = false
    try {
      await this.queue
      if (this.dirtyRevision > this.persistedRevision) this.startPersist()
      while (this.persistedRevision < this.dirtyRevision) await this.persistRun
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
      this.detached = true
    } catch (error) {
      this.accepting = true
      throw error
    }
  }

  async flush(): Promise<void> {
    await this.queue
    if (this.detached) {
      await this.persistRun
      return
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.dirtyRevision > this.persistedRevision) this.startPersist()
    while (this.persistedRevision < this.dirtyRevision) await this.persistRun
  }
}
