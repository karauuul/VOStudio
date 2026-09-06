import { useEffect, useState } from 'react'
import type { Project } from '@shared/domain'
import type { LastExport } from '@shared/ipc'
import {
  EXPORT_FORMATS,
  LENGTH_MODES,
  LOUDNESS_MODES,
  lengthMode,
  loudnessMode,
  type ExportSettings,
} from '@shared/export-settings'

interface Props {
  project: Project
  outDir: string
  last: LastExport | null
  onSettings: (patch: Partial<ExportSettings>) => void
  onTemplate: (template: string) => void
  onPickDir: () => void
}

function stamp(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function OutputPanel({ project, outDir, last, onSettings, onTemplate, onPickDir }: Props) {
  const [template, setTemplate] = useState(project.exportTemplate)

  useEffect(() => setTemplate(project.exportTemplate), [project.exportTemplate])

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
          value={loudnessMode(project.export)}
          onChange={(e) => onSettings({ loudness: e.target.value as ExportSettings['loudness'] })}
        >
          {LOUDNESS_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

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

      <div className="exp-sec">Video</div>

      <div className="exp-kvp">
        Container
        <select value="copy" disabled onChange={() => undefined}>
          <option value="copy">Copy video, replace audio</option>
          <option value="audio">Audio only</option>
        </select>
      </div>

      <div className="exp-kvp">
        Name
        <input className="mono" type="text" value="{name}_UK.mp4" disabled readOnly />
      </div>

      <div className="sp" />

      <div className="exp-foot">
        {last ? (
          <span>
            Last export {last.version === undefined ? '—' : <b>v{last.version}</b>} ·{' '}
            {stamp(last.createdAt)}
          </span>
        ) : (
          <span>No export yet</span>
        )}
      </div>
    </section>
  )
}
