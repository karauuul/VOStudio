import { useMemo } from 'react'
import { TableVirtuoso, type ItemProps } from 'react-virtuoso'
import { statusWords, type LineFilter, type LineRow } from '@shared/readiness'

interface Props {
  rows: LineRow[]
  total: number
  counts: { ready: number; changed: number; notReady: number }
  filter: LineFilter
  onFilter: (f: LineFilter) => void
  search: string
  onSearch: (s: string) => void
  selected: string | null
  onSelect: (cueId: string) => void
  onOpen: () => void
  lastVersion?: number
}

const TABS: { id: LineFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'changed', label: 'Changed' },
  { id: 'notready', label: 'Not ready' },
]

interface RowContext {
  selected: string | null
  onSelect: (cueId: string) => void
  onOpen: () => void
}

function TableRow({ item, context, ...rest }: ItemProps<LineRow> & { context?: RowContext }) {
  return (
    <tr
      {...rest}
      className={context && item.cueId === context.selected ? 'on' : ''}
      onClick={() => context?.onSelect(item.cueId)}
      onDoubleClick={() => context?.onOpen()}
    />
  )
}

const DOT: Record<LineRow['status'], string> = {
  ready: 'var(--ok)',
  longer: 'var(--warn)',
  'no-audio': 'var(--tx3)',
  collision: 'var(--err)',
  excluded: 'var(--tx3)',
}

function secs(v: number | undefined): string {
  return v === undefined || !(v > 0) ? '—' : v.toFixed(2)
}

export function ReadinessTable({
  rows,
  total,
  counts,
  filter,
  onFilter,
  search,
  onSearch,
  selected,
  onSelect,
  onOpen,
  lastVersion,
}: Props) {
  const tabCount = useMemo(
    () => ({ all: null, ready: counts.ready, changed: counts.changed, notready: counts.notReady }),
    [counts]
  )

  return (
    <section className="panel">
      <div className="phd">
        Lines <span className="n">{total.toLocaleString('en-US')}</span>
        <span className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={filter === t.id ? 'on' : ''}
              onClick={() => onFilter(t.id)}
            >
              {t.label}
              {tabCount[t.id] === null ? '' : ` ${tabCount[t.id]}`}
            </button>
          ))}
        </span>
      </div>

      <div className="exp-tbar">
        <span className="search">
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <circle cx="5.5" cy="5.5" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8.5 8.5l3.5 3.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <input
            type="search"
            value={search}
            placeholder="Search"
            onChange={(e) => onSearch(e.target.value)}
          />
        </span>
        <span className="sp" />
        <button className="btn ghost" disabled={!selected} onClick={onOpen}>
          Open in Work
        </button>
      </div>

      <div className="exp-scroll">
        <TableVirtuoso
          data={rows}
          style={{ height: '100%' }}
          fixedHeaderContent={() => (
            <tr>
              <th style={{ width: 260 }}>Source</th>
              <th>Output</th>
              <th style={{ width: 80 }}>Original</th>
              <th style={{ width: 80 }}>Output</th>
              <th style={{ width: 190 }}>Status</th>
              <th style={{ width: 60 }}>Done</th>
              <th style={{ width: 90 }}>Exported</th>
            </tr>
          )}
          computeItemKey={(_, row) => row.cueId}
          itemContent={(_, row) => (
            <>
              <td className="exp-id" title={row.cueKey}>
                {row.cueKey}
              </td>
              <td title={row.name}>{row.name || '—'}</td>
              <td className="mono">{secs(row.originalLength)}</td>
              <td className={row.outputLength === undefined ? 'mono' : 'mono exp-hi'}>
                {secs(row.outputLength)}
              </td>
              <td>
                <span
                  className="exp-st"
                  style={{ '--c': DOT[row.status] } as React.CSSProperties}
                >
                  {statusWords(row)}
                </span>
              </td>
              <td className="mono">{row.done ? '✓' : '—'}</td>
              <td className="mono">
                {row.exportedVersion === undefined ? '—' : `v${row.exportedVersion}`}
              </td>
            </>
          )}
          context={{ selected, onSelect, onOpen }}
          components={{ TableRow }}
        />
      </div>

      <div className="exp-foot">
        <b>{counts.ready}</b> ready · <b>{counts.changed}</b> changed
        {lastVersion === undefined ? '' : ` since v${lastVersion}`} · <b>{counts.notReady}</b> not
        ready
      </div>
    </section>
  )
}
