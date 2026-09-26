import { useEffect, useRef, useState } from 'react'
import type { MatchRule } from '@shared/domain'
import { assignColumn, type TableColumn, type TableMapping, type TableSummary } from '@shared/import-table'
import type { TablePreview } from '@shared/ipc'
import { api } from '../api'
import { Confirm, Overlay } from '../Overlay'

export interface TableChoice {
  mapping: TableMapping
  replaceTranslations: boolean
  keepOriginal: boolean
}

interface Props {
  path: string
  rule: MatchRule
  ai: boolean
  onImport: (choice: TableChoice) => Promise<void>
  onClose: () => void
}

const FIELDS: TableColumn[] = ['id', 'text', 'translation', 'character']

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function TableImportDialog({ path, rule, ai, onImport, onClose }: Props) {
  const [mapping, setMapping] = useState<TableMapping | null>(null)
  const [replace, setReplace] = useState(false)
  const [keep, setKeep] = useState(false)
  const [preview, setPreview] = useState<TablePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const at = ++seq.current
    setLoading(true)
    api['import:tablePreview']({
      path,
      rule,
      ...(mapping ? { mapping } : {}),
      ...(replace ? { replaceTranslations: true } : {}),
      ...(keep ? { keepOriginal: true } : {}),
    }).then(
      (next) => {
        if (at !== seq.current) return
        setPreview(next)
        setError('')
        setLoading(false)
      },
      (e: unknown) => {
        if (at !== seq.current) return
        setError(String(e))
        setLoading(false)
      }
    )
  }, [path, rule, mapping, replace, keep])

  const current = mapping ?? preview?.mapping ?? {}
  const labels: Record<TableColumn, string> = {
    id: 'Key',
    text: 'Original',
    translation: ai ? 'Translation' : 'Text',
    character: 'Character',
  }
  const fieldOf = (column: number): TableColumn | '' => FIELDS.find((field) => current[field] === column) ?? ''
  const keyed = !preview?.script && current.id !== undefined
  const summary = preview?.summary
  const columns = preview ? Math.max(1, preview.headers.length) : 1
  const ready = !!preview && !loading && !error && !busy
  const changes = summary ? summary.added + summary.updated : 0

  const submit = (): void => {
    setBusy(true)
    void onImport({ mapping: current, replaceTranslations: replace, keepOriginal: keep }).finally(() => setBusy(false))
  }

  const stats: { key: keyof TableSummary; label: string; tone: string }[] = preview?.script
    ? [
        { key: 'added', label: 'new', tone: 'ok' },
        { key: 'skipped', label: 'skipped', tone: summary?.skipped ? 'warn' : '' },
      ]
    : [
        { key: 'added', label: 'new', tone: 'ok' },
        { key: 'updated', label: 'updated', tone: 'ac' },
        { key: 'unchanged', label: 'unchanged', tone: '' },
        { key: 'skipped', label: 'skipped', tone: summary?.skipped ? 'warn' : '' },
      ]

  return (
    <Overlay title={preview?.name ?? fileName(path)} label="Import table" onClose={onClose} busy={busy} wide>
      <div className="modal-body tbl-imp">
        {error && <div className="t-err">{error}</div>}

        {preview && (
          <div className="tbl-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(140px, 1fr))` }}>
            {!preview.script &&
              preview.headers.map((header, i) => (
                <label key={`h${i}`} className="tbl-col">
                  <span className="tbl-h">{header || `Column ${i + 1}`}</span>
                  <select
                    value={fieldOf(i)}
                    onChange={(e) => setMapping(assignColumn(current, i, (e.target.value || null) as TableColumn | null))}
                  >
                    <option value="">Ignore</option>
                    {FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {labels[field]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            {preview.rows.flatMap((row, r) =>
              Array.from({ length: columns }, (_, c) => (
                <span key={`${r}:${c}`} className={'tbl-cell' + (fieldOf(c) || preview.script ? '' : ' off')}>
                  {row[c] ?? ''}
                </span>
              ))
            )}
          </div>
        )}

        {keyed && (current.translation !== undefined || current.text !== undefined) && (
          <div className="tbl-opts">
            {current.translation !== undefined && (
              <label className="tgl">
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                Replace {labels.translation.toLowerCase()}
              </label>
            )}
            {current.text !== undefined && (
              <label className="tgl">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                Keep original
              </label>
            )}
          </div>
        )}

        {summary && (
          <div className={'stats-row' + (loading ? ' dim' : '')}>
            {stats.map(({ key, label, tone }) => (
              <div key={key} className={'stat' + (tone ? ` ${tone}` : '')}>
                {label}
                <b>{summary[key].toLocaleString('en-US')}</b>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="modal-foot">
        <Confirm
          detail={preview && <span className="dim mono">{preview.total.toLocaleString('en-US')} rows</span>}
          choices={[
            { label: 'Import', kind: 'primary', disabled: !ready || changes === 0, onClick: submit },
            { label: 'Cancel', disabled: busy, onClick: onClose },
          ]}
        />
      </div>
    </Overlay>
  )
}
