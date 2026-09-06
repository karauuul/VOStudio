import type { ComponentProps } from 'react'
import { ProjectTable } from '../ProjectTable'

interface Props {
  hidden: boolean
  table: Omit<ComponentProps<typeof ProjectTable>, 'hidden'>
}

export function ImportRoom({ hidden, table }: Props) {
  return (
    <div className="main" hidden={hidden}>
      <section className="panel">
        <div className="phd">
          Lines <span className="n">{table.project.cues.length}</span>
        </div>
        <ProjectTable {...table} hidden={hidden} />
      </section>
    </div>
  )
}
