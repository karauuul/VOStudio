import { useCallback, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { Cue, MatchRule, Project, VoiceSettings } from '@shared/domain'
import { reviewGeneration } from '@shared/cue-filter'
import type { TableMapping } from '@shared/import-table'
import type { ProjectCommand } from '@shared/project-commands'
import { api } from '../api'
import { isCueBusyNow, useJobsStore } from '../jobs/store'
import { LinesTable, type GridApi, type TableSource } from '../import/LinesTable'
import { ProjectPanel } from '../import/ProjectPanel'
import { SourcesPanel } from '../import/SourcesPanel'
import type { MenuEntry } from '../shell/ContextMenu'

type Status = (kind: 'ok' | 'err' | 'info', text: string) => void

const TABLE_RE = /\.(csv|tsv|txt)$/i
const TEMPLATE_RE = /\.vostudio-src$/i

interface Props {
  hidden: boolean
  project: Project
  search: string
  onSearch: (s: string) => void
  searchRef: RefObject<HTMLInputElement>
  gridRef: MutableRefObject<GridApi | null>
  matchBy: MatchRule
  onMatchBy: (rule: MatchRule) => void
  hasKey: boolean
  onStatus: Status
  onOpenCue: (cueId: string) => void
  onReviewSelection: (cueIds: string[]) => void
  onGenerate: (cues: Cue[]) => void
  onAssignCharacter: (cueIds: string[], characterId: string) => void
  dispatch: (command: ProjectCommand) => Promise<void>
  onVoiceSettings: (characterId: string, settings: VoiceSettings) => void
  onProvider: (characterId: string, patch: { voiceId?: string }) => void
  onFlushVoice: () => Promise<unknown>
  onCancelVoice: (characterId: string) => void
}

export function ImportRoom({
  hidden,
  project,
  search,
  onSearch,
  searchRef,
  gridRef,
  matchBy,
  onMatchBy,
  hasKey,
  onStatus,
  onOpenCue,
  onReviewSelection,
  onGenerate,
  onAssignCharacter,
  dispatch,
  onVoiceSettings,
  onProvider,
  onFlushVoice,
  onCancelVoice,
}: Props) {
  const [tables, setTables] = useState<TableSource[]>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const submitJob = useJobsStore((s) => s.submit)

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

  const importTable = useCallback(
    (path: string, mapping?: TableMapping, replaceTranslations?: boolean) =>
      run(async () => {
        const result = await api['import:table']({
          path,
          rule: matchBy,
          ...(mapping ? { mapping } : {}),
          ...(replaceTranslations ? { replaceTranslations } : {}),
        })
        setTables((prev) => [...prev.filter((t) => t.path !== result.path), result])
        onStatus(
          result.unmatched > 0 ? 'info' : 'ok',
          `${result.name}: ${result.matched} matched, ${result.unmatched} unmatched`
        )
      }),
    [run, matchBy, onStatus]
  )

  const importPaths = useCallback(
    (paths: string[]) => {
      const templates = paths.filter((p) => TEMPLATE_RE.test(p))
      const tablePaths = paths.filter((p) => TABLE_RE.test(p))
      const audio = paths.filter((p) => !TEMPLATE_RE.test(p) && !TABLE_RE.test(p))
      if (templates.length > 0) {
        run(async () => {
          const r = await api['import:template'](templates[0])
          onStatus(
            'ok',
            `Re-import: ${r.added} added, ${r.updated} updated, ${r.untouched} untouched, ${r.orphaned} orphaned`
          )
        })
        return
      }
      if (tablePaths.length > 0) {
        importTable(tablePaths[0])
        return
      }
      if (audio.length === 0) return
      run(async () => {
        const r = await api['import:audio']({ paths: audio, rule: matchBy })
        onStatus('ok', `${r.files} files · ${r.added} lines added, ${r.updated} updated`)
      })
    },
    [run, importTable, matchBy, onStatus]
  )

  const pick = useCallback(
    (kind: 'files' | 'folder') =>
      run(async () => {
        const paths = await api['import:pick'](kind)
        if (paths.length > 0) importPaths(paths)
      }),
    [run, importPaths]
  )

  const pickTable = useCallback(
    (replaceTranslations: boolean) =>
      run(async () => {
        const paths = await api['import:pick']('table')
        if (paths.length > 0) importTable(paths[0], undefined, replaceTranslations)
      }),
    [run, importTable]
  )

  const transcribe = useCallback(
    (cueIds: string[], overwrite: boolean) => {
      if (!hasKey) {
        onStatus('err', 'API key missing — open Settings')
        return
      }
      for (const cueId of cueIds) {
        submitJob({
          kind: 'stt',
          cueId,
          run: async () => {
            await api['provider:transcribe']({ cueIds: [cueId], ...(overwrite ? { overwrite } : {}) })
          },
          onError: (e) => onStatus('err', String(e)),
        })
      }
      onStatus('info', `Queued ${cueIds.length} ${cueIds.length === 1 ? 'job' : 'jobs'}`)
    },
    [hasKey, submitJob, onStatus]
  )

  const detect = useCallback(
    (sourceId: string, mode: 'silence' | 'transcribe') => {
      if (mode === 'transcribe' && !hasKey) {
        onStatus('err', 'API key missing — open Settings')
        return
      }
      run(async () => {
        const r = await api['source:detect']({ sourceId, mode })
        onStatus(
          'ok',
          `${r.added} lines detected · ${r.kept} kept · ${r.removed} replaced`
        )
      })
    },
    [run, hasKey, onStatus]
  )

  const menu = useCallback(
    (cues: Cue[]): MenuEntry[] => {
      const ids = cues.map((c) => c.id)
      const review = reviewGeneration(cues, project.characters, isCueBusyNow)
      const untranscribed = cues.filter((c) => c.referenceAudio && !c.sourceText.trim()).map((c) => c.id)
      return [
        { label: 'Open', hotkey: 'Enter', onClick: () => onOpenCue(ids[0]) },
        { sep: true },
        {
          label: 'Assign character',
          submenu: [
            { label: 'no character', onClick: () => onAssignCharacter(ids, '') },
            ...project.characters.map((c) => ({
              label: c.name,
              onClick: () => onAssignCharacter(ids, c.id),
            })),
          ],
        },
        {
          label: 'Generate selected',
          confirm: `Generate ${review.eligible.length}`,
          disabled: review.eligible.length === 0,
          onClick: () => onGenerate(review.eligible),
        },
        { label: 'Review selection', onClick: () => onReviewSelection(ids) },
        { sep: true },
        {
          label: 'Transcribe selected',
          confirm: `Transcribe ${untranscribed.length}`,
          disabled: untranscribed.length === 0,
          onClick: () => transcribe(untranscribed, false),
        },
      ]
    },
    [project.characters, onOpenCue, onAssignCharacter, onGenerate, onReviewSelection, transcribe]
  )

  const table = tables[tables.length - 1] ?? null

  return (
    <div className="main import-grid" hidden={hidden}>
      <SourcesPanel project={project} tables={tables} onPick={pick} onDrop={importPaths} busy={busy} />

      <div className="gutter" />

      <LinesTable
        project={project}
        search={search}
        onSearch={onSearch}
        searchRef={searchRef}
        gridRef={gridRef}
        table={table}
        onMapping={(mapping) => table && importTable(table.path, mapping)}
        onImportText={pickTable}
        onTranscribe={transcribe}
        onDetect={detect}
        onOpenCue={onOpenCue}
        menu={menu}
      />

      <div className="gutter" />

      <div className="import-right">
        <ProjectPanel
          project={project}
          matchBy={matchBy}
          onMatchBy={onMatchBy}
          hasKey={hasKey}
          dispatch={dispatch}
          onVoiceSettings={onVoiceSettings}
          onProvider={onProvider}
          onFlushVoice={onFlushVoice}
          onCancelVoice={onCancelVoice}
          onStatus={onStatus}
        />
      </div>
    </div>
  )
}
