import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { ProjectAsset } from '@shared/domain'
import type { AssetPage } from '@shared/ipc'
import { api } from '../api'

const ROW_H = 34
const SAMPLE_ROWS = 50

const nnn = (n: number): string => n.toLocaleString('en-US')

function columnTemplate(page: AssetPage, count: number): string {
  const widths = Array.from({ length: count }, (_, c) => {
    const longest = Math.max(page.columns[c]?.length ?? 0, ...page.rows.slice(0, SAMPLE_ROWS).map((cells) => cells[c]?.length ?? 0))
    return `minmax(64px, ${Math.min(6, Math.max(1, Math.round(longest / 12)))}fr)`
  })
  return `52px ${widths.join(' ')}`
}

export function AssetPreview({ asset, onClose }: { asset: ProjectAsset; onClose: () => void }) {
  const [page, setPage] = useState<AssetPage | null>(null)
  const [rows, setRows] = useState<string[][]>([])
  const [error, setError] = useState('')
  const loading = useRef<object | null>(null)

  useEffect(() => {
    let live = true
    setPage(null)
    setRows([])
    setError('')
    loading.current = null
    void api['assets:read']({ id: asset.id }).then(
      (next) => {
        if (!live) return
        setPage(next)
        setRows(next.rows)
      },
      (e: unknown) => live && setError(String(e))
    )
    return () => {
      live = false
    }
  }, [asset.id])

  const loadMore = useCallback(() => {
    if (!page || rows.length >= page.total || loading.current !== null) return
    const request = {}
    loading.current = request
    void api['assets:read']({ id: asset.id, from: rows.length }).then(
      (next) => {
        if (loading.current !== request) return
        loading.current = null
        setRows((prev) => [...prev, ...next.rows])
      },
      (e: unknown) => {
        if (loading.current !== request) return
        loading.current = null
        setError(String(e))
      }
    )
  }, [asset.id, page, rows.length])

  const count = page ? Math.max(1, page.columns.length, ...page.rows.slice(0, SAMPLE_ROWS).map((cells) => cells.length)) : 0
  const columns = useMemo(() => (page ? columnTemplate(page, count) : ''), [page, count])
  const total = page ? (page.total > rows.length ? `${nnn(rows.length)} / ${nnn(page.total)}` : nnn(page.total)) : ''

  return (
    <section className="panel asset-prev">
      <div className="phd">
        {asset.name.slice(asset.name.lastIndexOf('/') + 1)}
        {page && (
          <span className="n">
            {page.format} · {total} {page.total === 1 ? 'row' : 'rows'}
          </span>
        )}
        <span className="acts">
          <button className="ico sm" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>

      {error && <div className="t-err">{error}</div>}

      {page && (
        <>
          <div className="imp-head" style={{ gridTemplateColumns: columns }}>
            <span>#</span>
            {Array.from({ length: count }, (_, c) => (
              <span key={c}>{page.columns[c] ?? ''}</span>
            ))}
          </div>
          <Virtuoso
            className="imp-scroll"
            data={rows}
            fixedItemHeight={ROW_H}
            endReached={loadMore}
            itemContent={(index, cells) => (
              <div className="imp-row" style={{ gridTemplateColumns: columns }}>
                <span className="imp-n">{index + 1}</span>
                {Array.from({ length: count }, (_, c) => (
                  <span key={c} className="imp-tx">
                    {cells[c] ?? ''}
                  </span>
                ))}
              </div>
            )}
          />
        </>
      )}
    </section>
  )
}
