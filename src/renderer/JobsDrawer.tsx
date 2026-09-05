import { useMemo, useState } from 'react'
import type { Cue } from '@shared/domain'
import { useJobsStore } from './jobs/store'
import type { Job, JobState } from './jobs/queue'
import { Overlay } from './Overlay'

const STATE_LABEL: Record<JobState, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Finished',
  error: 'Failed',
}

const STATE_CLASS: Record<JobState, string> = {
  queued: 'pb',
  running: 'pb',
  done: 'pb ok',
  error: 'pb err',
}

interface Props {
  cues: Cue[]
  onOpenCue: (cueId: string) => void
  onStatus: (kind: 'ok' | 'err' | 'info', text: string) => void
  onClose: () => void
}

export function JobsDrawer({ cues, onOpenCue, onStatus, onClose }: Props) {
  const jobs = useJobsStore((s) => s.jobs)
  const [open, setOpen] = useState<string | null>(null)

  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of cues) map.set(c.id, c.fields['EventName'] || c.key || c.id)
    return map
  }, [cues])

  const rows = useMemo(() => [...jobs].reverse(), [jobs])

  const copy = (job: Job): void => {
    void navigator.clipboard.writeText(job.error ?? '').then(
      () => onStatus('ok', 'Copied'),
      (e: unknown) => onStatus('err', String(e))
    )
  }

  return (
    <Overlay title={`Jobs ${rows.length}`} label="Jobs" onClose={onClose} drawer>
      <div className="modal-body jobs-list">
        {rows.length === 0 && <div className="home-empty">No jobs</div>}
        {rows.map((job) => (
          <div className={'jobs-row' + (job.state === 'error' ? ' err' : '')} key={job.id}>
            <div className="jobs-line">
              <span className={STATE_CLASS[job.state]}>{STATE_LABEL[job.state]}</span>
              <span className="pb mono">{job.kind}</span>
              <span className="jobs-cue">{names.get(job.cueId) ?? job.cueId}</span>
              <span className="sp" />
              {job.error && (
                <button
                  className="btn ghost"
                  aria-expanded={open === job.id}
                  onClick={() => setOpen(open === job.id ? null : job.id)}
                >
                  Details
                </button>
              )}
              <button
                className="btn ghost"
                disabled={!names.has(job.cueId)}
                onClick={() => onOpenCue(job.cueId)}
              >
                Open cue
              </button>
            </div>
            {job.error && open === job.id && (
              <div className="jobs-err">
                <pre className="mono">{job.error}</pre>
                <button className="btn ghost" onClick={() => copy(job)}>
                  Copy
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Overlay>
  )
}
