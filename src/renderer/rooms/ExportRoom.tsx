import type { ComponentProps } from 'react'
import { DeliverScreen } from '../DeliverScreen'

interface Props {
  hidden: boolean
  deliver: Omit<ComponentProps<typeof DeliverScreen>, 'hidden'>
}

export function ExportRoom({ hidden, deliver }: Props) {
  return (
    <div className="main" hidden={hidden}>
      <section className="panel">
        <div className="phd">Export</div>
        <DeliverScreen {...deliver} hidden={hidden} />
      </section>
    </div>
  )
}
