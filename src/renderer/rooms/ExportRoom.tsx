import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/domain'
import type { ExportInfo } from '@shared/ipc'
import type { ExportSettings } from '@shared/export-settings'
import type { ProjectCommand } from '@shared/project-commands'
import {
  matchesLineFilter,
  readinessRows,
  summarize,
  type LineFilter,
  type LineRow,
} from '@shared/readiness'
import { matchesSearch } from '@shared/cue-filter'
import { api } from '../api'
import { runPlan, runVideo, type ExportProgress } from '../export/run-export'
import { videoMode, videoName } from '@shared/export-settings'
import { OutputPanel } from '../export/OutputPanel'
import { ReadinessTable } from '../export/ReadinessTable'
import { SummaryPanel } from '../export/SummaryPanel'
import type { StatusKind } from '../useProjectSession'

interface Props {
  hidden: boolean
  project: Project
  onStatus: (kind: StatusKind, text: string) => void
  onOpenCue: (cueId: string) => void
  onCommand: (command: ProjectCommand) => void
  beginExport: () => Promise<boolean>
  endExport: () => void
}

export function ExportRoom({
  hidden,
  project,
  onStatus,
  onOpenCue,
  onCommand,
  beginExport,
  endExport,
}: Props) {
  const [info, setInfo] = useState<ExportInfo | null>(null)
  const [filter, setFilter] = useState<LineFilter>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)

  const refresh = useCallback(() => {
    const n = ++seq.current
    void api['export:info']().then(
      (d) => {
        if (n === seq.current) setInfo(d)
      },
      () => {
        if (n === seq.current) setInfo(null)
      }
    )
  }, [])

  useEffect(() => {
    if (hidden || busy) return
    refresh()
  }, [hidden, busy, refresh, project])

  const rows = useMemo(
    () => readinessRows(project, info?.last?.lines ?? {}),
    [project, info?.last?.lines]
  )
  const summary = useMemo(() => summarize(project, rows), [project, rows])

  const byId = useMemo(() => new Map(project.cues.map((c) => [c.id, c])), [project])
  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (!matchesLineFilter(r, filter)) return false
      const cue = byId.get(r.cueId)
      return cue ? matchesSearch(cue, search) : true
    })
  }, [rows, filter, search, byId])

  const settings = useCallback(
    (patch: Partial<ExportSettings>) => {
      onCommand({
        type: 'project.setExport',
        settings: { ...(project.export ?? {}), ...patch },
      })
    },
    [onCommand, project.export]
  )

  const pickDir = useCallback(() => {
    void api['export:pickDir']().then(
      (dir) => {
        if (dir) settings({ outDir: dir })
      },
      (e: unknown) => onStatus('err', String(e))
    )
  }, [settings, onStatus])

  const openSelected = useCallback(() => {
    if (selected) onOpenCue(selected)
  }, [selected, onOpenCue])

  const videos = useMemo(() => {
    const mode = videoMode(project.export)
    const lang = project.languages?.target ?? ''
    return (project.sources ?? [])
      .map((s) => ({
        id: s.id,
        name: s.name,
        out: videoName(project.export, s.name, lang, mode),
        lines: project.cues.filter((c) => c.region?.sourceId === s.id).length,
      }))
      .filter((v) => v.lines > 0)
  }, [project.sources, project.cues, project.export, project.languages])

  const runExport = useCallback(
    async (changedOnly: boolean) => {
      if (busy) return
      const pick = (r: LineRow): boolean =>
        r.status === 'ready' && (!changedOnly || r.changed)
      const cueIds = rows.filter(pick).map((r) => r.cueId)
      if (cueIds.length === 0) return
      if (!(await beginExport())) return
      setBusy(true)
      setError('')
      setProgress(null)
      try {
        const plan = await api['export:planBatch']({ cueIds })
        const result = await runPlan(plan, setProgress)
        let written = 0
        for (const v of videos) {
          const videoPlan = await api['export:videoPlan'](v.id)
          if (!videoPlan) continue
          await runVideo(videoPlan, setProgress)
          written++
        }
        onStatus(
          result.failed.length > 0 ? 'err' : 'ok',
          result.failed.length > 0
            ? `Exported ${result.written}, failed ${result.failed.length}`
            : `Exported ${result.written}${written > 0 ? ` + ${written} video` : ''} to ${result.outDir}`
        )
      } catch (e) {
        setError(String(e))
      } finally {
        setProgress(null)
        setBusy(false)
        endExport()
      }
    },
    [busy, rows, videos, beginExport, endExport, onStatus]
  )

  return (
    <div className="main exp" hidden={hidden}>
      <OutputPanel
        project={project}
        outDir={info?.outDir ?? '—'}
        last={info?.last ?? null}
        onSettings={settings}
        onTemplate={(template) => onCommand({ type: 'project.setExportTemplate', template })}
        onPickDir={pickDir}
      />

      <div className="gutter" />

      <ReadinessTable
        rows={visible}
        total={project.cues.length}
        counts={summary}
        filter={filter}
        onFilter={setFilter}
        search={search}
        onSearch={setSearch}
        selected={selected}
        onSelect={setSelected}
        onOpen={openSelected}
        {...(info?.last?.version === undefined ? {} : { lastVersion: info.last.version })}
      />

      <div className="gutter" />

      <SummaryPanel
        summary={summary}
        {...(info?.last?.version === undefined ? {} : { lastVersion: info.last.version })}
        videos={videos}
        busy={busy}
        progress={progress}
        error={error}
        onFilter={setFilter}
        onExport={(changedOnly) => void runExport(changedOnly)}
      />
    </div>
  )
}
