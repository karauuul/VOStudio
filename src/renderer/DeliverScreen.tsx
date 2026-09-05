import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Project } from '@shared/domain'
import type { BatchExportResult, ExportPreflight } from '@shared/ipc'
import type { CollisionStrategy } from '@shared/export-plan'
import type { ExportScope } from '@shared/export-preflight'
import { api } from './api'
import { runPlan, type ExportProgress } from './export/run-export'
import type { StatusKind } from './useProjectSession'

const STRATEGIES: { id: CollisionStrategy; label: string }[] = [
  { id: 'suffix-wemid', label: 'Append ID' },
  { id: 'skip', label: 'Skip' },
  { id: 'reuse', label: 'Overwrite' },
]

const PREVIEW_ROWS = 8

interface Props {
  hidden: boolean
  project: Project
  onStatus: (kind: StatusKind, text: string) => void
  onOpenFilter: (filterId: string) => void
  onOpenCue: (cueId: string) => void
  beginExport: () => Promise<boolean>
  endExport: () => void
}

function Group({
  label,
  value,
  tone,
  onClick,
}: {
  label: string
  value: number
  tone?: string
  onClick?: () => void
}) {
  return (
    <button
      className={'dlv-row' + (tone ? ' ' + tone : '')}
      disabled={!onClick}
      onClick={onClick}
    >
      <span>{label}</span>
      <b>{value}</b>
    </button>
  )
}

export function DeliverScreen({
  hidden,
  project,
  onStatus,
  onOpenFilter,
  onOpenCue,
  beginExport,
  endExport,
}: Props) {
  const [scope, setScope] = useState<ExportScope>('approved')
  const [confirmAll, setConfirmAll] = useState(false)
  const [strategy, setStrategy] = useState<Record<string, CollisionStrategy>>({})
  const [data, setData] = useState<ExportPreflight | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [result, setResult] = useState<BatchExportResult | null>(null)
  const seq = useRef(0)

  const refresh = useCallback(() => {
    const n = ++seq.current
    setData(null)
    void api['export:preflight']({ scope, collisionStrategy: strategy }).then(
      (d) => {
        if (n === seq.current) {
          setData(d)
          setErr('')
        }
      },
      (e: unknown) => {
        if (n === seq.current) setErr(String(e))
      }
    )
  }, [scope, strategy])

  useEffect(() => {
    if (hidden || busy) return
    refresh()
  }, [hidden, busy, refresh, project])

  const chooseScope = useCallback((next: ExportScope) => {
    setConfirmAll(false)
    setScope(next)
    setData(null)
    setStrategy({})
    setResult(null)
    setErr('')
  }, [])

  const exportPackage = useCallback(async () => {
    if (busy) return
    if (!(await beginExport())) return
    setBusy(true)
    setErr('')
    setResult(null)
    setProgress(null)
    try {
      const plan = await api['export:planBatch']({ scope, collisionStrategy: strategy })
      if (plan.collisions.length > 0) throw new Error('Resolve the name collisions first')
      setResult(await runPlan(plan, setProgress))
    } catch (e) {
      setErr(String(e))
    } finally {
      setProgress(null)
      setBusy(false)
      endExport()
    }
  }, [busy, beginExport, endExport, scope, strategy])

  const copyPath = useCallback(() => {
    if (!data) return
    void navigator.clipboard.writeText(data.outDir).then(
      () => onStatus('ok', 'Copied'),
      (e: unknown) => onStatus('err', String(e))
    )
  }, [data, onStatus])

  const missing = data?.missingFiles.filter((f) => f.inScope) ?? []
  const firstMissing = data?.missingFiles[0]
  const unresolved = data?.collisions.filter((c) => !strategy[c.name]) ?? []
  const ready =
    !!data &&
    data.eligible > 0 &&
    missing.length === 0 &&
    data.invalid.length === 0 &&
    unresolved.length === 0

  let session: ReactNode = null
  if (busy) {
    session = (
      <div className="dlv-sec">
        <div className="sec-h">Exporting</div>
        <div className="dlv-prog">
          {progress ? `${progress.done} / ${progress.total}` : 'Preparing…'}
          {progress?.current ? <span className="dim mono"> {progress.current}</span> : null}
        </div>
      </div>
    )
  } else if (result) {
    session = (
      <div className="dlv-sec">
        <div className="sec-h">{result.failed.length > 0 ? 'Partial export' : 'Export complete'}</div>
        <div className="stats-row">
          <div className="stat ok">
            Exported <b>{result.written}</b>
          </div>
          <div className="stat err">
            Failed <b>{result.failed.length}</b>
          </div>
          <div className="stat">
            Skipped <b>{result.skipped}</b>
          </div>
        </div>
        <div className="dim mono dlv-path">{result.outDir}</div>
        {result.indexPath && <div className="dim mono dlv-path">{result.indexPath}</div>}
        {result.reportPath && <div className="dim mono dlv-path">{result.reportPath}</div>}
        {result.failed.length > 0 && (
          <div className="dlv-fails">
            {result.failed.map((f) => (
              <div className="dlv-fail" key={f.cueKey + f.name}>
                <span className="mono">{f.name}</span>
                <span className="dim"> {f.cueKey}</span>
                <div className="t-err">{f.error}</div>
              </div>
            ))}
          </div>
        )}
        <button className="btn ghost" onClick={() => setResult(null)}>
          Back to readiness
        </button>
      </div>
    )
  }

  return (
    <div className="deliver" style={hidden ? { display: 'none' } : undefined}>
      <div className="dlv-col">
        <div className="dlv-sec">
          <div className="sec-h">Scope</div>
          <div className="dlv-scope">
            <button
              className={'btn' + (scope === 'approved' ? ' primary' : ' ghost')}
              disabled={busy}
              onClick={() => chooseScope('approved')}
            >
              Approved only
            </button>
            <button
              className={'btn' + (scope === 'all-final' ? ' primary' : ' ghost')}
              disabled={busy}
              onClick={() => (scope === 'all-final' ? undefined : setConfirmAll(true))}
            >
              All outputs
            </button>
            <span className="dim">
              Approved {data?.approved ?? 0} · Unapproved {data?.unapproved ?? 0}
            </span>
          </div>
          {confirmAll && (
            <div className="dlv-confirm">
              <span className="dim">Unapproved</span>
              <span className="mono">{data?.unapproved ?? 0}</span>
              <button className="btn primary" onClick={() => chooseScope('all-final')}>
                Include
              </button>
              <button className="btn ghost" onClick={() => setConfirmAll(false)}>
                Cancel
              </button>
            </div>
          )}
        </div>

        {session ?? (
          <div className="dlv-sec">
            <div className="sec-h">Readiness</div>
            <div className="dlv-rows">
              <Group
                label="Eligible outputs"
                value={data?.eligible ?? 0}
                tone="ok"
                onClick={() => onOpenFilter(scope === 'approved' ? 'appr' : 'gen')}
              />
              <Group
                label="Stale approvals"
                value={data?.stale ?? 0}
                tone={data?.stale ? 'warn' : undefined}
                onClick={() => onOpenFilter('review')}
              />
              <Group
                label="Missing output files"
                value={data?.missingFiles.length ?? 0}
                tone={missing.length > 0 ? 'err' : undefined}
                onClick={firstMissing ? () => onOpenCue(firstMissing.cueId) : undefined}
              />
              <Group
                label="Missing outputs"
                value={data?.missingOutput ?? 0}
                onClick={() => onOpenFilter('notgen')}
              />
              <Group
                label="Excluded"
                value={data?.excluded ?? 0}
                onClick={() => onOpenFilter('excluded')}
              />
              <Group label="Missing reference audio" value={data?.missingReference ?? 0} />
            </div>

            {data && data.invalid.length > 0 && (
              <div className="t-err dlv-note">
                Unsupported container: {data.invalid.map((n) => n.name).join(', ')}
              </div>
            )}

            {missing.length > 0 && (
              <div className="dlv-note">
                {missing.slice(0, PREVIEW_ROWS).map((f) => (
                  <button className="dlv-link" key={f.cueId + f.path} onClick={() => onOpenCue(f.cueId)}>
                    <span className="mono">{f.name}</span>
                    <span className="dim"> {f.path}</span>
                  </button>
                ))}
              </div>
            )}

            {data && data.collisions.length > 0 && (
              <>
                <div className="sec-h">Name collisions {data.collisions.length}</div>
                <div className="dlv-colls">
                  {data.collisions.map((c) => (
                    <div className="dlv-coll" key={c.name}>
                      <div className="mono">{c.name}</div>
                      <div className="dim">{c.cueKeys.join(', ')}</div>
                      <div className="dlv-choice">
                        {STRATEGIES.map((s) => (
                          <button
                            key={s.id}
                            className={'btn ghost' + (strategy[c.name] === s.id ? ' on' : '')}
                            onClick={() => setStrategy((prev) => ({ ...prev, [c.name]: s.id }))}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {err && <div className="t-err dlv-note">{err}</div>}
      </div>

      <div className="dlv-col dlv-right">
        <div className="dlv-sec">
          <div className="sec-h">Destination</div>
          <div className="mono dlv-path">{data?.outDir ?? '—'}</div>
          <div className="dim">
            audio/{data?.writesIndex ? ' · index.updated.csv' : ''} · report.json
          </div>
        </div>

        <div className="dlv-sec">
          <div className="sec-h">File names</div>
          <div className="dlv-names">
            {(data?.names ?? []).slice(0, PREVIEW_ROWS).map((n) => (
              <div className="mono" key={n.cueId + n.name}>
                {n.name}
              </div>
            ))}
            {data && data.names.length === 0 && <div className="dim">Nothing to export</div>}
            {data && data.names.length > PREVIEW_ROWS && (
              <div className="dim">… {data.names.length - PREVIEW_ROWS} more</div>
            )}
          </div>
        </div>

        {data?.last && (
          <div className="dlv-sec">
            <div className="sec-h">Last export</div>
            <div className="dim">
              {data.last.createdAt} · {data.last.scope}
            </div>
            <div className="dim">
              Exported {data.last.exported} · Failed {data.last.failed} · Skipped{' '}
              {data.last.skipped}
            </div>
          </div>
        )}

        <div className="dlv-actions">
          <button className="btn ghost" onClick={copyPath} disabled={!data}>
            Copy package path
          </button>
          <button
            className="btn primary"
            disabled={busy || !ready}
            onClick={() => void exportPackage()}
          >
            {busy
              ? 'Exporting…'
              : `${result ? 'Export again' : 'Export package'} · ${data?.eligible ?? 0} files`}
          </button>
        </div>
      </div>
    </div>
  )
}
