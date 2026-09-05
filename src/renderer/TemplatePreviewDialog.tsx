import type { ReimportDiff, TemplateIssue, TemplatePreview } from '@shared/ipc'
import { Overlay } from './Overlay'

interface Props {
  preview: TemplatePreview
  busy: boolean
  diff?: ReimportDiff
  confirmLabel?: string
  onCancel: () => void
  onCreate: () => void
}

const PRESERVED = ['Takes', 'Comps', 'Approvals', 'Voice overrides', 'Notes']

function IssueList({ issues, tone }: { issues: TemplateIssue[]; tone: 'err' | 'warn' }) {
  return (
    <ul className={`tpl-issues ${tone}`}>
      {issues.map((issue, i) => (
        <li key={`${issue.row ?? 'file'}-${i}`}>
          <span className="mono">{issue.row === null ? 'file' : `row ${issue.row}`}</span>
          <span className="sp" />
          <span>{issue.reason}</span>
        </li>
      ))}
    </ul>
  )
}

export function TemplatePreviewDialog({
  preview,
  busy,
  diff,
  confirmLabel,
  onCancel,
  onCreate,
}: Props) {
  const blocked = preview.fatalErrors.length > 0

  return (
    <Overlay
      title={preview.meta?.name ?? 'Template'}
      label={diff ? 'Re-import template' : 'Import template'}
      onClose={onCancel}
      busy={busy}
      wide
    >
      <div className="modal-body">
        <div className="sec-h">Summary</div>
        <div className="home-badges">
          <span className="pb mono">{preview.dir}</span>
          {preview.meta && (
            <span className="pb">
              {preview.meta.sourceLang} → {preview.meta.targetLang}
            </span>
          )}
          <span className="pb">{preview.totalCues} cues</span>
          <span className="pb">{preview.characters.length} characters</span>
          {diff ? (
            <span className="pb">Terms not re-imported</span>
          ) : (
            <span className="pb">{preview.terms} terms</span>
          )}
          {blocked && <span className="pb err">{preview.fatalErrors.length} errors</span>}
        </div>

        {diff && (
          <>
            <div className="home-badges">
              <span className="pb ok">Added {diff.added}</span>
              <span className="pb">Updated {diff.updated}</span>
              <span className="pb">Untouched {diff.untouched}</span>
              <span className={diff.orphaned > 0 ? 'pb warn' : 'pb'}>
                Orphaned {diff.orphaned}
              </span>
            </div>
            <div className="sec-h">Preserved</div>
            <div className="home-badges">
              {PRESERVED.map((p) => (
                <span key={p} className="pb ok">
                  {p}
                </span>
              ))}
              <span className="pb">Orphaned cues kept</span>
            </div>
          </>
        )}

        {!diff && preview.characters.length > 0 && (
          <div className="home-badges tpl-chars">
            {preview.characters.map((c) => (
              <span key={c} className="pb ok">
                {c}
              </span>
            ))}
          </div>
        )}

        {blocked && (
          <>
            <div className="sec-h t-err">Errors</div>
            <IssueList issues={preview.fatalErrors} tone="err" />
          </>
        )}

        {preview.warnings.length > 0 && (
          <details className="tpl-more">
            <summary>{preview.warnings.length} warnings</summary>
            <IssueList issues={preview.warnings} tone="warn" />
          </details>
        )}

        {diff && diff.updatedSample.length > 0 && (
          <details className="tpl-more">
            <summary>Sample · {diff.updatedSample.length} changed rows</summary>
            <ul className="tpl-issues warn">
              {diff.updatedSample.map((s) => (
                <li key={s.cueId}>
                  <span className="mono">{s.cueId}</span>
                  <span className="sp" />
                  <span>
                    {[s.sourceChanged ? 'source' : '', s.translationChanged ? 'translation' : '']
                      .filter(Boolean)
                      .join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {preview.firstRows.length > 0 && (
          <>
            <div className="sec-h">Sample</div>
            <div className="tpl-scroll">
              <table className="tpl-table">
                <thead>
                  <tr>
                    <th>cueId</th>
                    <th>character</th>
                    <th>sourceText</th>
                    <th>translation</th>
                    <th>exportName</th>
                    <th>refAudio</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.firstRows.map((r, i) => (
                    <tr key={`${r.cueId}-${i}`} className={r.status === 'excluded' ? 'off' : ''}>
                      <td className="mono">{r.cueId}</td>
                      <td>{r.character}</td>
                      <td>{r.sourceText}</td>
                      <td>{r.translation}</td>
                      <td className="mono">{r.exportName}</td>
                      <td className={r.missingAudio ? 'mono t-warn' : 'mono'}>{r.refAudio}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="modal-foot">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={onCreate} disabled={busy || blocked}>
          {busy ? <span className="spin" /> : null}
          {confirmLabel ?? 'Create project'}
        </button>
      </div>
    </Overlay>
  )
}
