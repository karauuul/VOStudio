import type { ReadinessSummary, LineFilter } from '@shared/readiness'
import { formatBytes } from '@shared/export-settings'

interface Props {
  summary: ReadinessSummary
  lastVersion?: number
  videos: { id: string; name: string; out: string; lines: number }[]
  busy: boolean
  progress: { done: number; total: number; current: string } | null
  error: string
  onFilter: (f: LineFilter) => void
  onExport: (changedOnly: boolean) => void
}

function Row({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return (
    <div className="exp-pr">
      {label}
      <span className="bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <b>
        {value.toLocaleString('en-US')} / {total.toLocaleString('en-US')}
      </b>
    </div>
  )
}

export function SummaryPanel({
  summary,
  lastVersion,
  videos,
  busy,
  progress,
  error,
  onFilter,
  onExport,
}: Props) {
  const since = lastVersion === undefined ? '' : ` since v${lastVersion}`
  return (
    <section className="panel">
      <div className="phd">Summary</div>

      <div className="exp-prog">
        <Row label="Translated" value={summary.translated} total={summary.total} />
        <Row label="Voiced" value={summary.voiced} total={summary.total} />
        <Row label="Done" value={summary.done} total={summary.total} />
      </div>

      <button className="exp-sum h top" onClick={() => onFilter('ready')}>
        Will export
        <b>
          {summary.ready.toLocaleString('en-US')} files · {formatBytes(summary.bytes)}
        </b>
      </button>
      <div className="exp-sum dim">
        Unchanged{since}
        <b>{summary.unchanged}</b>
      </div>
      <button className="exp-sum dim" onClick={() => onFilter('changed')}>
        Changed
        <b>{summary.changed}</b>
      </button>

      <button className="exp-sum h" onClick={() => onFilter('notready')}>
        Not ready
        <b>{summary.notReady}</b>
      </button>
      <button className="exp-sum dim" onClick={() => onFilter('notready')}>
        No audio
        <b>{summary.noAudio}</b>
      </button>
      <button className="exp-sum dim" onClick={() => onFilter('notready')}>
        Longer than original
        <b>{summary.longer}</b>
      </button>
      <button className="exp-sum dim" onClick={() => onFilter('notready')}>
        Name collision
        <b>{summary.collision}</b>
      </button>

      {videos.length > 0 && (
        <>
          <div className="exp-sum h">
            Video<b>{videos.length}</b>
          </div>
          {videos.map((v) => (
            <div className="exp-sum dim" key={v.id}>
              {v.out}
              <b>{v.lines}</b>
            </div>
          ))}
        </>
      )}

      <div className="sp" />

      {error && <div className="exp-run t-err">{error}</div>}
      {busy && (
        <div className="exp-run">
          {progress ? `${progress.done} / ${progress.total} ${progress.current}` : 'Preparing…'}
        </div>
      )}

      <div className="exp-actions">
        <button
          className="btn ghost"
          disabled={busy || summary.changed === 0}
          onClick={() => onExport(true)}
        >
          Export changed {summary.changed}
        </button>
        <button
          className="btn primary"
          disabled={busy || summary.ready === 0}
          onClick={() => onExport(false)}
        >
          Export {summary.ready}
        </button>
      </div>
    </section>
  )
}
