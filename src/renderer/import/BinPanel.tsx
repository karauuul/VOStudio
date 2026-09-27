import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import { sourceLabel, type AssetKind, type Project, type ProjectAsset } from '@shared/domain'
import { extensionOf } from '@shared/asset-readers'
import { audioSources, hasSourceMaterial, tableColumnLabels, type TableColumn } from '@shared/import-table'
import { assetLinks, isUnlinked, linkLabel, looseAudioCues, unlinkedAssets } from '@shared/linking'
import type { TableImportResult } from '@shared/ipc'
import { api } from '../api'

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

const AudioIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M1.5 6v2M4 4v6M6.5 2v10M9 5v4M11.5 3.5v7" stroke="currentColor" strokeWidth="1.2" />
  </svg>
)

const SubtitlesIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <rect x="1" y="2.5" width="12" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3.5 7.5h4M8.5 7.5h2M3.5 9.5h7" stroke="currentColor" strokeWidth="1.1" />
  </svg>
)

const DataIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M5 1.5H4a1 1 0 0 0-1 1v3L1.5 7 3 8.5v3a1 1 0 0 0 1 1h1M9 1.5h1a1 1 0 0 1 1 1v3L12.5 7 11 8.5v3a1 1 0 0 1-1 1H9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    />
  </svg>
)

const KIND_ICON: Record<AssetKind, () => ReactNode> = {
  audio: AudioIcon,
  video: VideoIcon,
  table: TableIcon,
  subtitles: SubtitlesIcon,
  text: FileIcon,
  data: DataIcon,
  other: FileIcon,
}

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
const counted = (n: number, word: string): string => `${nnn(n)} ${n === 1 ? word : `${word}s`}`
const lengthText = (seconds: number): string => (seconds < 60 ? `${seconds.toFixed(2)}s` : spanText(seconds))

function assetMeta(asset: ProjectAsset): string {
  const slash = asset.name.lastIndexOf('/')
  return [
    extensionOf(asset.name) || asset.kind,
    ...(asset.duration !== undefined ? [lengthText(asset.duration)] : []),
    ...(asset.rows !== undefined ? [counted(asset.rows, 'row')] : []),
    ...(slash > 0 ? [asset.name.slice(0, slash)] : []),
  ].join(' · ')
}

type BinTab = 'all' | 'unlinked'

interface Props {
  project: Project
  tables: TableImportResult[]
  onPick: (kind: 'files' | 'folder') => void
  onDrop: (paths: string[]) => void
  busy: boolean
  selectedId: string | null
  onSelect: (asset: ProjectAsset) => void
}

export function BinPanel({ project, tables, onPick, onDrop, busy, selectedId, onSelect }: Props) {
  const [over, setOver] = useState(false)
  const [tab, setTab] = useState<BinTab>('all')
  const assets = useMemo(() => project.assets ?? [], [project.assets])
  const links = useMemo(() => assetLinks(project.cues), [project.cues])
  const audio = useMemo(() => audioSources(looseAudioCues(project.cues, assets)), [project.cues, assets])
  const unlinked = useMemo(() => unlinkedAssets(assets, links), [assets, links])
  const labels = useMemo(() => tableColumnLabels(hasSourceMaterial(project)), [project])
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

  const all = tab === 'all'
  const count = audio.length + videos.length + tables.length + assets.length

  return (
    <section className="panel">
      <div className="phd">
        Bin <span className="n">{nnn(count)}</span>
        <span className="tabs">
          <button className={all ? 'on' : ''} onClick={() => setTab('all')}>
            All
          </button>
          <button className={all ? '' : 'on'} onClick={() => setTab('unlinked')}>
            Unlinked {nnn(unlinked.length)}
          </button>
        </span>
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
        {all &&
          audio.map((row) => (
            <div className="imp-src" key={`a:${row.name}`}>
              <span className="k">
                <FolderIcon />
              </span>
              <div>
                <div className="nm">{row.name}</div>
                <div className="sb">
                  {counted(row.files, 'file')} · {row.formats.join(', ')} · {spanText(row.duration)}
                </div>
              </div>
              <span className="m">{counted(row.lines, 'line')}</span>
            </div>
          ))}

        {all &&
          videos.map((source) => (
            <div className="imp-src" key={`v:${source.id}`}>
              <span className="k">
                <VideoIcon />
              </span>
              <div>
                <div className="nm">{source.name}</div>
                <div className="sb">{sourceLabel(source)}</div>
              </div>
              <span className="m">{counted(regions.get(source.id) ?? 0, 'line')}</span>
            </div>
          ))}

        {all &&
          tables.map((table) => (
            <div className="imp-src" key={`t:${table.path}`}>
              <span className="k">
                <TableIcon />
              </span>
              <div>
                <div className="nm">{table.name}</div>
                <div className="sb">
                  {counted(table.rows, 'row')} ·{' '}
                  {(Object.keys(table.mapping) as TableColumn[]).map((column) => labels[column]).join(', ') ||
                    'no columns'}
                </div>
              </div>
              <span className="m">
                {nnn(table.summary.added)} new
                <br />
                {nnn(table.summary.updated)} updated
                {table.summary.suggested > 0 && (
                  <>
                    <br />
                    {nnn(table.summary.suggested)} suggested
                  </>
                )}
              </span>
            </div>
          ))}

        {(all ? assets : unlinked).map((asset) => {
          const Icon = KIND_ICON[asset.kind]
          const state = links.get(asset.id)
          return (
            <div
              className={'imp-src pick' + (asset.id === selectedId ? ' on' : '')}
              key={asset.id}
              role="button"
              tabIndex={0}
              aria-pressed={asset.id === selectedId}
              onClick={() => onSelect(asset)}
              onKeyDown={(e) => {
                if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return
                e.preventDefault()
                onSelect(asset)
              }}
            >
              <span className="k">
                <Icon />
              </span>
              <div>
                <div className="nm">{asset.name.slice(asset.name.lastIndexOf('/') + 1)}</div>
                <div className="sb">{assetMeta(asset)}</div>
              </div>
              <span className={'m' + (isUnlinked(state) ? ' warn' : '')}>{linkLabel(state)}</span>
            </div>
          )
        })}
      </div>

      <div className="foot">
        {project.languages
          ? `${project.languages.source.toUpperCase()} → ${project.languages.target.toUpperCase()}`
          : ''}
      </div>
    </section>
  )
}
