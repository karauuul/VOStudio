import { useState } from 'react'
import type { BatchExportCollision, BatchExportRequest, BatchExportResult } from '@shared/ipc'
import { exportBatch, type ExportProgress } from './export/run-export'

type Strategy = 'suffix-wemid' | 'skip' | 'reuse'

const STRATEGY_LABEL: Record<Strategy, string> = {
  'suffix-wemid': 'append __WemId',
  skip: 'skip',
  reuse: 'overwrite (last one wins)',
}

interface Props {
  onClose: () => void
}

export function BatchExportDialog({ onClose }: Props) {
  const [scope, setScope] = useState<BatchExportRequest['scope']>('approved')
  const [collisions, setCollisions] = useState<BatchExportCollision[]>([])
  const [strategy, setStrategy] = useState<Record<string, Strategy>>({})
  const [result, setResult] = useState<BatchExportResult | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)

  function changeScope(s: BatchExportRequest['scope']): void {
    setScope(s)
    setCollisions([])
    setResult(null)
    setErr('')
  }

  async function run(withStrategy: boolean): Promise<void> {
    setBusy(true)
    setErr('')
    setProgress(null)
    try {
      const req: BatchExportRequest = { scope }
      if (withStrategy) req.collisionStrategy = strategy
      const r = await exportBatch(req, setProgress)
      if (r.collisions.length > 0) {
        setCollisions(r.collisions)
        setStrategy((prev) => {
          const next: Record<string, Strategy> = {}
          for (const c of r.collisions) next[c.name] = prev[c.name] ?? 'suffix-wemid'
          return next
        })
        setResult(null)
      } else {
        setCollisions([])
        setResult(r)
      }
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Batch export
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="sec-h" style={{ marginTop: 0 }}>
            What to export
          </div>
          <div className="row">
            <label className="radio">
              <input
                type="radio"
                checked={scope === 'approved'}
                onChange={() => changeScope('approved')}
              />
              Approved only
            </label>
            <label className="radio">
              <input
                type="radio"
                checked={scope === 'all-final'}
                onChange={() => changeScope('all-final')}
              />
              Everything with a final take
            </label>
          </div>

          {collisions.length > 0 && (
            <>
              <div className="sec-h">
                <span className="t-warn">
                  Name collisions ({collisions.length}) — export blocked, pick a strategy for each
                </span>
              </div>
              <div className="coll-list">
                {collisions.map((c) => (
                  <div className="coll" key={c.name}>
                    <div className="mono">{c.name}</div>
                    <div className="dim">WemId: {c.cueKeys.join(', ')}</div>
                    <select
                      value={strategy[c.name] ?? 'suffix-wemid'}
                      onChange={(e) =>
                        setStrategy((s) => ({ ...s, [c.name]: e.target.value as Strategy }))
                      }
                    >
                      {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
                        <option key={s} value={s}>
                          {STRATEGY_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}

          {err && <div className="t-err">{err}</div>}
          {progress && progress.total > 0 && (
            <div className="dim" style={{ marginTop: 16 }}>
              Exporting {progress.done} / {progress.total}
              {progress.current ? ` — ${progress.current}` : ''}
            </div>
          )}
          {result && (
            <div className="t-ok" style={{ marginTop: 16 }}>
              Written {result.written}, skipped {result.skipped} → {result.outDir}
            </div>
          )}
          {result?.indexPath && <div className="dim mono">index.updated.csv → {result.indexPath}</div>}
          {result?.reportPath && <div className="dim mono">report.json → {result.reportPath}</div>}
          {result && result.failed.length > 0 && (
            <>
              <div className="sec-h">
                <span className="t-warn">Failed ({result.failed.length})</span>
              </div>
              <div className="coll-list">
                {result.failed.map((f) => (
                  <div className="coll" key={f.name + f.cueKey}>
                    <div className="mono">{f.name}</div>
                    <div className="dim">WemId: {f.cueKey}</div>
                    <div className="t-err">{f.error}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="dim">
            {collisions.length > 0
              ? 'nothing written'
              : progress && progress.total > 0
                ? `${progress.done} / ${progress.total}`
                : ''}
          </span>
          <button
            className="btn primary"
            onClick={() => void run(collisions.length > 0)}
            disabled={busy}
          >
            {collisions.length > 0 ? 'Export with strategies' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  )
}
