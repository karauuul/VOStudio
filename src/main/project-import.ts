import type { Project } from '@shared/domain'
import type { ProjectSnapshot } from '@shared/project-commands'
import type { SerialProjectRepository } from './project-repository'

interface ImportedProjectSetup<Staged> {
  stageImport: () => Promise<Staged>
  detachCurrent: () => Promise<unknown>
  importProject: (staged: Staged) => Promise<unknown>
  currentProject: () => Project | null
  resetRepository: (project: Project) => SerialProjectRepository
  finishImport: (repository: SerialProjectRepository) => Promise<unknown>
}

interface OpenedProjectSetup {
  detachCurrent: () => Promise<unknown>
  openProject: () => Promise<Project | null>
  prepareProject: (project: Project) => Promise<unknown>
  resetRepository: (project: Project) => SerialProjectRepository
  finishOpen: (repository: SerialProjectRepository) => Promise<unknown>
  abandonProject: () => void
}

export async function setupImportedProject<Staged>({
  stageImport,
  detachCurrent,
  importProject,
  currentProject,
  resetRepository,
  finishImport,
}: ImportedProjectSetup<Staged>): Promise<ProjectSnapshot> {
  const staged = await stageImport()
  const previousProject = structuredClone(currentProject())
  await detachCurrent()
  try {
    await importProject(staged)
  } catch (error) {
    if (previousProject) resetRepository(previousProject)
    throw error
  }
  const importedProject = currentProject()
  if (!importedProject) throw new Error('No imported project is open')
  const repository = resetRepository(importedProject)
  await finishImport(repository)
  return repository.snapshot()
}

export async function setupOpenedProject({
  detachCurrent,
  openProject,
  prepareProject,
  resetRepository,
  finishOpen,
  abandonProject,
}: OpenedProjectSetup): Promise<ProjectSnapshot | null> {
  await detachCurrent()
  const project = await openProject()
  if (!project) return null
  try {
    await prepareProject(project)
    const repository = resetRepository(project)
    await finishOpen(repository)
    return repository.snapshot()
  } catch (error) {
    abandonProject()
    throw error
  }
}
