import type { ReimportDiff, TemplateIssue, TemplatePreview } from '@shared/ipc'

interface Props {
  preview: TemplatePreview
  busy: boolean
  diff?: ReimportDiff
  confirmLabel?: string
  onCancel: () => void
  onCreate: () => void
}

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

export function TemplatePreviewDialog({ preview, busy, diff, confirmLabel, onCancel, onCreate }: Props) {
  const blocked = preview.fatalErrors.length > 0

  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal tpl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {preview.meta?.name ?? 'Template'}
          <button className="icon-btn" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="home-badges">
            <span className="pb mono">{preview.dir}</span>
            {preview.meta && (
              <span className="pb">
                {preview.meta.sourceLang} → {preview.meta.targetLang}
              </span>
            )}
            <span className="pb">{preview.totalCues} cues</span>
            <span className="pb">{preview.characters.length} characters</span>
            <span className="pb">{preview.terms} terms</span>
            {preview.warnings.length > 0 && <span className="pb warn">{preview.warnings.length} warnings</span>}
            {blocked && <span className="pb err">{preview.fatalErrors.length} errors</span>}
          </div>

          {diff && (
            <div className="home-badges">
              <span className="pb ok">Added {diff.added}</span>
              <span className="pb">Updated {diff.updated}</span>
              <span className="pb">Untouched {diff.untouched}</span>
              <span className={diff.orphaned > 0 ? 'pb warn' : 'pb'}>Orphaned {diff.orphaned}</span>
              {diff.updatedSample.map((s) => (
                <span key={s.cueId} className="pb mono">
                  {s.cueId}
                  {s.sourceChanged ? ' src' : ''}
                  {s.translationChanged ? ' tr' : ''}
                </span>
              ))}
            </div>
          )}

          {preview.characters.length > 0 && (
            <div className="home-badges tpl-chars">
              {preview.characters.map((c) => (
                <span key={c} className="pb ok">
                  {c}
                </span>
              ))}
            </div>
          )}

          {preview.firstRows.length > 0 && (
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
          )}

          {blocked && <IssueList issues={preview.fatalErrors} tone="err" />}
          {preview.warnings.length > 0 && <IssueList issues={preview.warnings} tone="warn" />}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={onCreate} disabled={busy || blocked}>
            {confirmLabel ?? 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
