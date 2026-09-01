import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { TemplatePreview } from '@shared/ipc'
import type { ProjectSnapshot } from '@shared/project-commands'
import type { ProjectSummary } from '@shared/project-summary'
import { api } from './api'
import { TemplatePreviewDialog } from './TemplatePreviewDialog'

type Status = (kind: 'ok' | 'err' | 'info', text: string) => void

export function ProjectHome({
  onOpen,
  onStatus,
}: {
  onOpen: (snapshot: ProjectSnapshot) => void
  onStatus: Status
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [preview, setPreview] = useState<TemplatePreview | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const refresh = useCallback(() => {
    void api['project:list']()
      .then(setProjects)
      .catch((e: unknown) => {
        setProjects([])
        onStatus('err', String(e))
      })
  }, [onStatus])

  useEffect(refresh, [refresh])

  const run = useCallback(
    (fn: () => Promise<void>) => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      void fn()
        .catch((e: unknown) => onStatus('err', String(e)))
        .finally(() => {
          busyRef.current = false
          setBusy(false)
        })
    },
    [onStatus]
  )

  const open = (dir: string): void => run(async () => onOpen(await api['project:open'](dir)))

  const create = (): void =>
    run(async () => {
      const trimmed = (name ?? '').trim()
      if (!trimmed) return
      onOpen(await api['project:create'](trimmed))
    })

  const pickTemplate = (): void =>
    run(async () => {
      const result = await api['project:pickTemplate']()
      if (result) setPreview(result)
    })

  const importTemplate = (dir: string): void =>
    run(async () => {
      const snapshot = await api['project:importTemplate'](dir)
      setPreview(null)
      onOpen(snapshot)
      onStatus('ok', `Imported ${snapshot.project.cues.length} cues`)
    })

  const remove = (project: ProjectSummary, e: ReactMouseEvent): void => {
    e.stopPropagation()
    if (busyRef.current) return
    if (!window.confirm(`Delete "${project.name}"?`)) return
    run(async () => {
      await api['project:delete'](project.dir)
      onStatus('ok', `Moved to trash: ${project.name}`)
      setProjects((prev) => prev?.filter((p) => p.dir !== project.dir) ?? prev)
    })
  }

  return (
    <div className="home">
      <div className="home-bar">
        <span className="boot-mark">VO Studio</span>
        <div className="home-actions">
          {name === null ? (
            <button className="btn primary" onClick={() => setName('')} disabled={busy}>
              New
            </button>
          ) : (
            <>
              <input
                type="text"
                autoFocus
                value={name}
                placeholder="Name"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.code === 'Enter' || e.code === 'NumpadEnter') create()
                  else if (e.code === 'Escape') setName(null)
                }}
              />
              <button className="btn primary" onClick={create} disabled={busy || !name.trim()}>
                Create
              </button>
              <button className="btn ghost" onClick={() => setName(null)} disabled={busy}>
                Cancel
              </button>
            </>
          )}
          <button className="btn ghost" disabled={busy} onClick={pickTemplate}>
            Import template
          </button>
        </div>
      </div>

      <div className="home-list">
        {projects?.length === 0 && <div className="home-empty">No projects</div>}
        {projects?.map((p) => (
          <div
            key={p.dir}
            className="home-row"
            role="button"
            tabIndex={0}
            title={p.dir}
            onClick={() => open(p.dir)}
          >
            <span className="home-name">{p.name}</span>
            <span className="home-badges">
              {p.stats ? (
                <>
                  <span className="pb">{p.stats.cues} cues</span>
                  <span className="pb">{p.stats.translated} translated</span>
                  <span className="pb ok">{p.stats.voiced} voiced</span>
                  <span className="pb ok">{p.stats.approved} approved</span>
                </>
              ) : (
                <span className="pb warn">unreadable</span>
              )}
            </span>
            <span className="home-time">
              {p.modifiedAt ? new Date(p.modifiedAt).toLocaleString('en-US') : '—'}
            </span>
            <button
              className="icon-btn"
              title="Delete"
              disabled={busy}
              onClick={(e) => remove(p, e)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {preview && (
        <TemplatePreviewDialog
          preview={preview}
          busy={busy}
          onCancel={() => setPreview(null)}
          onCreate={() => importTemplate(preview.dir)}
        />
      )}
    </div>
  )
}
