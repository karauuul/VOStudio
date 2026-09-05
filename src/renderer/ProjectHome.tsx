import { useCallback, useEffect, useRef, useState } from 'react'
import type { TemplatePreview } from '@shared/ipc'
import type { ProjectSnapshot } from '@shared/project-commands'
import type { ProjectSummary } from '@shared/project-summary'
import { api } from './api'
import { ConfirmDialog } from './Overlay'
import { TemplatePreviewDialog } from './TemplatePreviewDialog'

type Status = (kind: 'ok' | 'err' | 'info', text: string) => void

export function ProjectHome({
  onOpen,
  onStatus,
  onSettings,
}: {
  onOpen: (snapshot: ProjectSnapshot) => void
  onStatus: Status
  onSettings: () => void
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [trash, setTrash] = useState<ProjectSummary | null>(null)
  const [preview, setPreview] = useState<TemplatePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const refresh = useCallback(() => {
    setProjects(null)
    setFailed(null)
    void api['project:list']().then(setProjects, (e: unknown) => setFailed(String(e)))
  }, [])

  useEffect(refresh, [refresh])

  useEffect(() => {
    if (!menuFor) return
    const close = (): void => setMenuFor(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menuFor])

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

  const pickTemplate = (): void =>
    run(async () => {
      const result = await api['project:pickTemplate']()
      if (result) setPreview(result)
    })

  const importTemplate = (current: TemplatePreview): void =>
    run(async () => {
      const result = await api['project:importTemplate'](current.dir)
      const known = new Set(current.warnings.map((w) => `${w.row}:${w.reason}`))
      const fresh = result.warnings.filter((w) => !known.has(`${w.row}:${w.reason}`))
      setPreview(null)
      onOpen(result.snapshot)
      onStatus('ok', `Imported ${result.snapshot.project.cues.length} cues`)
      if (fresh.length > 0) {
        onStatus('info', `${fresh.length} new warnings since preview: ${fresh[0].reason}`)
      }
    })

  const moveToTrash = (project: ProjectSummary): void => {
    setTrash(null)
    run(async () => {
      await api['project:delete'](project.dir)
      setProjects((prev) => prev?.filter((p) => p.dir !== project.dir) ?? prev)
      setSelected((prev) => (prev === project.dir ? null : prev))
      onStatus('ok', `Moved to Trash: ${project.name}`)
    })
  }

  const empty = projects !== null && projects.length === 0

  return (
    <div className="home">
      <div className="home-bar">
        <span className="boot-mark">VO Studio</span>
        <div className="home-actions">
          <button
            className={empty ? 'btn ghost' : 'btn primary'}
            disabled={busy || !selected}
            onClick={() => selected && open(selected)}
          >
            Open
          </button>
          <button
            className={empty ? 'btn primary' : 'btn ghost'}
            disabled={busy}
            onClick={pickTemplate}
          >
            Import template
          </button>
          <button className="btn ghost" onClick={onSettings}>
            Settings
          </button>
        </div>
      </div>

      <div className="home-list">
        {failed !== null && (
          <div className="home-state">
            <span className="t-err">Read failed</span>
            <span className="dim mono">{failed}</span>
            <button className="btn ghost" onClick={refresh}>
              Retry
            </button>
          </div>
        )}
        {failed === null && projects === null && <div className="home-state dim">Loading</div>}
        {empty && <div className="home-state dim">No projects</div>}

        {projects?.map((p) => (
          <div
            key={p.dir}
            className={'home-row' + (selected === p.dir ? ' on' : '')}
            role="button"
            tabIndex={0}
            title={p.dir}
            onClick={() => setSelected(p.dir)}
            onDoubleClick={() => open(p.dir)}
            onFocus={() => setSelected(p.dir)}
            onKeyDown={(e) => {
              if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return
              if (e.target !== e.currentTarget) return
              e.preventDefault()
              open(p.dir)
            }}
          >
            <span className="home-name">{p.name}</span>
            <span className="home-badges">
              {p.stats ? (
                <>
                  <span className="pb">{p.stats.cues} cues</span>
                  <span className="pb ok">{p.stats.voiced} outputs</span>
                  <span className="pb ok">{p.stats.approved} approved</span>
                </>
              ) : (
                <span className="pb warn">Unreadable</span>
              )}
            </span>
            <span className="home-time">
              {p.modifiedAt ? new Date(p.modifiedAt).toLocaleString('en-US') : '—'}
            </span>
            <div className="menu" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className="icon-btn"
                aria-haspopup="menu"
                aria-expanded={menuFor === p.dir}
                aria-label="Project menu"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuFor(menuFor === p.dir ? null : p.dir)
                }}
              >
                ⋯
              </button>
              {menuFor === p.dir && (
                <div
                  className="menu-pop"
                  role="menu"
                  onKeyDown={(e) => {
                    if (e.code !== 'Escape') return
                    e.stopPropagation()
                    setMenuFor(null)
                  }}
                >
                  <button
                    className="menu-item danger"
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuFor(null)
                      e.currentTarget.closest<HTMLElement>('.home-row')?.focus()
                      setTrash(p)
                    }}
                  >
                    Move to Trash
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {trash && (
        <ConfirmDialog
          operation="Move to Trash"
          name={trash.name}
          onClose={() => setTrash(null)}
          choices={[
            { label: 'Move to Trash', kind: 'danger', onClick: () => moveToTrash(trash) },
            { label: 'Cancel', safe: true, onClick: () => setTrash(null) },
          ]}
        />
      )}

      {preview && (
        <TemplatePreviewDialog
          preview={preview}
          busy={busy}
          onCancel={() => setPreview(null)}
          onCreate={() => importTemplate(preview)}
        />
      )}
    </div>
  )
}
