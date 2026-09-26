import { useEffect, useState } from 'react'
import type { Project } from '@shared/domain'
import type { LastExport } from '@shared/ipc'
import {
  EXPORT_FORMATS,
  LENGTH_MODES,
  LOUDNESS_MODES,
  LUFS_TARGET_MAX,
  LUFS_TARGET_MIN,
  PEAK_TARGET_MAX,
  PEAK_TARGET_MIN,
  DEFAULT_VIDEO_NAME,
  VIDEO_MODES,
  lengthMode,
  loudnessMode,
  lufsTarget,
  peakTarget,
  videoMode,
  type ExportSettings,
} from '@shared/export-settings'
import { DragNumber } from '../cue/DragNumber'

interface Props {
  project: Project
  outDir: string
  last: LastExport | null
  onSettings: (patch: Partial<ExportSettings>) => void
  onTemplate: (template: string) => void
  onPickDir: () => void
  onReveal: () => void
}

const idle = (): void => {}

function stamp(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function OutputPanel({ project, outDir, last, onSettings, onTemplate, onPickDir, onReveal }: Props) {
  const [template, setTemplate] = useState(project.exportTemplate)
  const [video, setVideo] = useState(project.export?.videoName ?? DEFAULT_VIDEO_NAME)
  const loudness = loudnessMode(project.export)

  useEffect(() => setTemplate(project.exportTemplate), [project.exportTemplate])
  useEffect(
    () => setVideo(project.export?.videoName ?? DEFAULT_VIDEO_NAME),
    [project.export?.videoName]
  )

  const commitVideo = (): void => {
    const next = video.trim()
    if (next && next !== (project.export?.videoName ?? DEFAULT_VIDEO_NAME)) {
      onSettings({ videoName: next })
    } else setVideo(project.export?.videoName ?? DEFAULT_VIDEO_NAME)
  }

  const commit = (): void => {
    const next = template.trim()
    if (next && next !== project.exportTemplate) onTemplate(next)
    else setTemplate(project.exportTemplate)
  }

  return (
    <section className="panel">
      <div className="phd">Output</div>

      <div className="exp-kvp">
        Folder
        <button className="field mono" onClick={onPickDir} title={outDir}>
          {outDir}
        </button>
      </div>

      <div className="exp-kvp">
        Name
        <input
          className="mono"
          type="text"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setTemplate(project.exportTemplate)
          }}
        />
      </div>

      <div className="exp-kvp">
        Format
        <select
          value={project.export?.format ?? EXPORT_FORMATS[0].id}
          onChange={(e) => onSettings({ format: e.target.value as ExportSettings['format'] })}
        >
          {EXPORT_FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="exp-kvp">
        Loudness
        <select
          value={loudness}
          onChange={(e) => onSettings({ loudness: e.target.value as ExportSettings['loudness'] })}
        >
          {LOUDNESS_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {loudness === 'lufs' && (
        <div className="exp-kvp">
          Target
          <DragNumber
            label=""
            unit="LUFS"
            value={lufsTarget(project.export)}
            min={LUFS_TARGET_MIN}
            max={LUFS_TARGET_MAX}
            perPx={0.1}
            decimals={0}
            onInput={idle}
            onCommit={(v) => onSettings({ lufsTarget: v })}
          />
        </div>
      )}

      {loudness === 'peak' && (
        <div className="exp-kvp">
          Target
          <DragNumber
            label=""
            unit="dBFS"
            value={peakTarget(project.export)}
            min={PEAK_TARGET_MIN}
            max={PEAK_TARGET_MAX}
            perPx={0.05}
            decimals={1}
            onInput={idle}
            onCommit={(v) => onSettings({ peakTarget: v })}
          />
        </div>
      )}

      <div className="exp-kvp">
        Length
        <select
          value={lengthMode(project.export)}
          onChange={(e) => onSettings({ length: e.target.value as ExportSettings['length'] })}
        >
          {LENGTH_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {(project.sources ?? []).length > 0 && (
        <>
          <div className="exp-sec">Video</div>

          <div className="exp-kvp">
            Container
            <select
              value={videoMode(project.export)}
              onChange={(e) => onSettings({ video: e.target.value as ExportSettings['video'] })}
            >
              {VIDEO_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="exp-kvp">
            Name
            <input
              className="mono"
              type="text"
              value={video}
              onChange={(e) => setVideo(e.target.value)}
              onBlur={commitVideo}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setVideo(project.export?.videoName ?? DEFAULT_VIDEO_NAME)
              }}
            />
          </div>
        </>
      )}

      <div className="sp" />

      <div className="exp-foot">
        {last ? (
          <>
            <span>
              Last export {last.version === undefined ? '—' : <b>v{last.version}</b>} ·{' '}
              {stamp(last.createdAt)}
            </span>
            <button
              className="ico sm"
              data-hint="Show in folder"
              aria-label="Show in folder"
              onClick={onReveal}
            >
              <svg width="14" height="13" viewBox="0 0 14 13">
                <path
                  d="M1.5 2.5h4l1.2 1.5h5.8v7h-11z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </>
        ) : (
          <span>No export yet</span>
        )}
      </div>
    </section>
  )
}
