import { useMemo, useState, type DragEvent } from 'react'
import { sourceLabel, type Project } from '@shared/domain'
import { audioSources } from '@shared/import-table'
import { api } from '../api'
import type { TableSource } from './LinesTable'

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M1 3h4l1.5 1.5H13v8H1z" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

const FileIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 1h5l3 3v9H3z" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M8 1v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

const TableIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2 3h10M2 7h10M2 11h6" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

const VideoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <rect x="1" y="3" width="9" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M10 6l3-2v6l-3-2z" fill="currentColor" />
  </svg>
)

export function spanText(seconds: number): string {
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

const nnn = (n: number): string => n.toLocaleString('en-US')

interface Props {
  project: Project
  tables: TableSource[]
  onPick: (kind: 'files' | 'folder') => void
  onDrop: (paths: string[]) => void
  busy: boolean
}

export function SourcesPanel({ project, tables, onPick, onDrop, busy }: Props) {
  const [over, setOver] = useState(false)
  const audio = useMemo(() => audioSources(project.cues), [project.cues])
  const videos = project.sources ?? []
  const regions = useMemo(() => {
    const map = new Map<string, number>()
    for (const cue of project.cues) {
      if (!cue.region) continue
      map.set(cue.region.sourceId, (map.get(cue.region.sourceId) ?? 0) + 1)
    }
    return map
  }, [project.cues])

  const drop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    const paths = api.pathsFor([...e.dataTransfer.files])
    if (paths.length > 0) onDrop(paths)
  }

  const count = audio.length + videos.length + tables.length

  return (
    <section className="panel">
      <div className="phd">
        Sources <span className="n">{count}</span>
      </div>

      <div
        className={'drop' + (over ? ' over' : '')}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <button className="btn ghost" disabled={busy} onClick={() => onPick('files')}>
          <FileIcon />
          Files
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => onPick('folder')}>
          <FolderIcon />
          Folder
        </button>
      </div>

      <div className="imp-srcs">
        {audio.map((row) => (
          <div className="imp-src" key={`a:${row.name}`}>
            <span className="k">
              <FolderIcon />
            </span>
            <div>
              <div className="nm">{row.name}</div>
              <div className="sb">
                {nnn(row.files)} files · {row.formats.join(', ')} · {spanText(row.duration)}
              </div>
            </div>
            <span className="m">{nnn(row.lines)} lines</span>
          </div>
        ))}

        {videos.map((source) => (
          <div className="imp-src" key={`v:${source.id}`}>
            <span className="k">
              <VideoIcon />
            </span>
            <div>
              <div className="nm">{source.name}</div>
              <div className="sb">
                {sourceLabel(source)}
              </div>
            </div>
            <span className="m">{nnn(regions.get(source.id) ?? 0)} lines</span>
          </div>
        ))}

        {tables.map((table) => (
          <div className="imp-src" key={`t:${table.path}`}>
            <span className="k">
              <TableIcon />
            </span>
            <div>
              <div className="nm">{table.name}</div>
              <div className="sb">
                {nnn(table.rows)} rows ·{' '}
                {(Object.keys(table.mapping) as (keyof typeof table.mapping)[]).join(', ') || 'no columns'}
              </div>
            </div>
            <span className="m">
              {nnn(table.matched)} matched
              {table.unmatched > 0 && (
                <>
                  <br />
                  <span className="t-err">{nnn(table.unmatched)} unmatched</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="foot">
        {project.languages
          ? `${project.languages.source.toUpperCase()} → ${project.languages.target.toUpperCase()}`
          : ''}
      </div>
    </section>
  )
}
