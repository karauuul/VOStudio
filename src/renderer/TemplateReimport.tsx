import { useCallback, useState, type ReactElement } from 'react'
import type { ReimportPreview } from '@shared/ipc'
import { api } from './api'
import { TemplatePreviewDialog } from './TemplatePreviewDialog'

type Status = (kind: 'ok' | 'err' | 'info', text: string) => void

export function useTemplateReimport(onStatus: Status): {
  start: () => void
  open: boolean
  dialog: ReactElement | null
} {
  const [state, setState] = useState<ReimportPreview | null>(null)
  const [busy, setBusy] = useState(false)

  const start = useCallback(() => {
    setBusy(true)
    void api['project:pickTemplate']()
      .then((picked) => (picked ? api['project:previewReimport'](picked.dir) : null))
      .then(setState)
      .catch((e: unknown) => onStatus('err', String(e)))
      .finally(() => setBusy(false))
  }, [onStatus])

  const apply = useCallback(
    (dir: string) => {
      setBusy(true)
      void api['project:applyReimport'](dir)
        .then((r) => {
          setState(null)
          onStatus(
            'ok',
            `Re-import: ${r.added} added, ${r.updated} updated, ${r.untouched} untouched, ${r.orphaned} orphaned`
          )
          if (r.warnings.length > 0) {
            onStatus('info', `${r.warnings.length} warnings: ${r.warnings[0].reason}`)
          }
        })
        .catch((e: unknown) => onStatus('err', String(e)))
        .finally(() => setBusy(false))
    },
    [onStatus]
  )

  return {
    start,
    open: state !== null,
    dialog: state && (
      <TemplatePreviewDialog
        preview={state.preview}
        diff={state.diff}
        confirmLabel="Apply"
        busy={busy}
        onCancel={() => setState(null)}
        onCreate={() => apply(state.preview.dir)}
      />
    ),
  }
}
