import { useCallback, useEffect, useRef, useState } from 'react'
import type { MigrationReport } from '@shared/ipc'
import { api } from './api'

interface Props {
  onClose: () => void
  onApplied: () => void
}

export function MigrationDialog({ onClose, onApplied }: Props) {
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(true)
  const [adopted, setAdopted] = useState<{ adoptedNormal: number; adoptedComposite: number } | null>(
    null
  )

  const appliedRef = useRef(onApplied)
  appliedRef.current = onApplied

  const scan = useCallback(async (rescan: boolean): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      if (rescan) {
        const r = await api['migration:apply']()
        setAdopted(r)
        if (r.adoptedNormal || r.adoptedComposite) appliedRef.current()
      }
      setReport(await api['migration:dryRun']())
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void scan(false)
  }, [scan])

  const matched = report ? report.normal.length : 0

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Migration report — generated/
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {busy && !report && <div className="muted">Scanning generated/ and hashing sha256…</div>}
          {err && <div className="t-err">{err}</div>}

          {report && (
            <>
              <div className="stats-row">
                <div className="stat">
                  files total
                  <b>{report.totalFiles}</b>
                </div>
                <div className="stat ok">
                  matched
                  <b>{matched}</b>
                </div>
                <div className="stat ac">
                  composite
                  <b>{report.composite.length}</b>
                </div>
                <div className="stat warn">
                  orphans
                  <b>{report.orphans.length}</b>
                </div>
                <div className="stat err">
                  ambiguous
                  <b>{report.ambiguous.length}</b>
                </div>
              </div>

              {report.orphans.length > 0 && (
                <>
                  <div className="sec-h">Orphans — segments without a manifest</div>
                  <ul className="mig-list">
                    {report.orphans.map((o) => (
                      <li key={o.file}>
                        <span className="mono">{o.eventName}</span>
                        <span className="sp" />
                        <span className="dim">{o.note}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {report.ambiguous.length > 0 && (
                <>
                  <div className="sec-h">Ambiguous — not adopted</div>
                  <ul className="mig-list">
                    {report.ambiguous.map((a) => (
                      <li key={a.file}>
                        <span className="mono">{a.eventName}</span>
                        <span className="sp" />
                        <span className="dim">{a.note}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {adopted && (
                <div className="sec-h" style={{ marginTop: 16 }}>
                  {adopted.adoptedNormal || adopted.adoptedComposite ? (
                    <span className="t-ok">
                      New audio adopted: {adopted.adoptedNormal} normal,{' '}
                      {adopted.adoptedComposite} composite
                    </span>
                  ) : (
                    <span className="t-ok">Everything is already adopted — no new files</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={() => void scan(true)} disabled={busy}>
            Rescan
          </button>
        </div>
      </div>
    </div>
  )
}
