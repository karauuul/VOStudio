import { memo, useCallback, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import type { Cue, MatchRule, Project, ProjectAsset, VoiceSettings } from '@shared/domain'
import { binAddedText, inPlaceKind, routeDrop } from '@shared/asset-readers'
import { reviewGeneration } from '@shared/cue-filter'
import type { TableImportResult } from '@shared/ipc'
import { proposalRefs } from '@shared/linking'
import type { ProjectCommand } from '@shared/project-commands'
import { api, audioUrl } from '../api'
import { clipId, transport } from '../audio/transport'
import { isCueBusyNow, useJobsStore } from '../jobs/store'
import { AssetPreview } from '../import/AssetPreview'
import { BinPanel } from '../import/BinPanel'
import { LinesTable, type GridApi } from '../import/LinesTable'
import { ProjectPanel } from '../import/ProjectPanel'
import type { MenuEntry } from '../shell/ContextMenu'

type Status = (kind: 'ok' | 'err' | 'info', text: string) => void

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
  tables: TableImportResult[]
  onPickTable: () => void
  dispatch: (command: ProjectCommand) => Promise<void>
  onVoiceSettings: (characterId: string, settings: VoiceSettings) => void
  onProvider: (characterId: string, patch: { voiceId?: string }) => void
  onFlushVoice: () => Promise<unknown>
  onCancelVoice: (characterId: string) => void
}

export const ImportRoom = memo(function ImportRoom({
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
  tables,
  onPickTable,
  dispatch,
  onVoiceSettings,
  onProvider,
  onFlushVoice,
  onCancelVoice,
}: Props) {
  const [busy, setBusy] = useState(false)
  const [assetId, setAssetId] = useState<string | null>(null)
  const busyRef = useRef(false)
  const shown = project.assets?.find((a) => a.id === assetId && !inPlaceKind(a.kind))
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

  const importPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      const route = routeDrop(paths)
      if (route.templates.length > 0) {
        const r = await api['import:template'](route.templates[0])
        onStatus(
          'ok',
          `Re-import: ${r.added} added, ${r.updated} updated, ${r.untouched} untouched, ${r.orphaned} orphaned`
        )
        return
      }
      const parts: string[] = []
      if (route.bin.length > 0) {
        const r = await api['assets:add']({ paths: route.bin, skipMedia: true })
        if (r.added.length > 0 || r.skipped.length > 0) parts.push(binAddedText(r))
      }
      if (route.lines.length > 0) {
        const r = await api['import:audio']({ paths: route.lines, rule: matchBy })
        if (r.files > 0 || parts.length === 0) {
          parts.push(
            r.unmatched === undefined
              ? `${r.files} files · ${r.added} lines added, ${r.updated} updated`
              : `${r.files} files · ${r.updated} updated${r.unmatched > 0 ? ` · ${r.unmatched} unmatched` : ''}`
          )
        }
      }
      if (parts.length > 0) onStatus('ok', parts.join(' · '))
    },
    [matchBy, onStatus]
  )

  const drop = useCallback((paths: string[]) => run(() => importPaths(paths)), [run, importPaths])

  const pick = useCallback(
    (kind: 'files' | 'folder') =>
      run(async () => {
        await importPaths(await api['import:pick'](kind))
      }),
    [run, importPaths]
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

  const settle = useCallback(
    (cues: Cue[], accept: boolean) => {
      const items = proposalRefs(accept ? cues.filter((c) => !isCueBusyNow(c.id)) : cues)
      if (items.length === 0) return
      void dispatch({ type: accept ? 'proposal.accept' : 'proposal.reject', items }).then(
        () => onStatus('ok', `${accept ? 'Accepted' : 'Rejected'} ${items.length}`),
        (e: unknown) => onStatus('err', String(e))
      )
    },
    [dispatch, onStatus]
  )

  const selectAsset = useCallback((asset: ProjectAsset) => {
    if (asset.kind === 'audio') void transport.playClip({ id: clipId.original(asset.file.relPath), url: audioUrl(asset.file.relPath) })
    setAssetId((id) => (id === asset.id && !inPlaceKind(asset.kind) ? null : asset.id))
  }, [])

  const menu = useCallback(
    (cues: Cue[]): MenuEntry[] => {
      const ids = cues.map((c) => c.id)
      const proposed = proposalRefs(cues).length > 0
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
        { label: 'Accept proposals', disabled: !proposed, onClick: () => settle(cues, true) },
        { label: 'Reject proposals', disabled: !proposed, onClick: () => settle(cues, false) },
        { sep: true },
        {
          label: 'Transcribe selected',
          confirm: `Transcribe ${untranscribed.length}`,
          disabled: untranscribed.length === 0,
          onClick: () => transcribe(untranscribed, false),
        },
      ]
    },
    [project.characters, onOpenCue, onAssignCharacter, onGenerate, onReviewSelection, transcribe, settle]
  )

  return (
    <div className="main import-grid" hidden={hidden}>
      <BinPanel
        project={project}
        tables={tables}
        onPick={pick}
        onDrop={drop}
        busy={busy}
        selectedId={assetId}
        onSelect={selectAsset}
      />

      <div className="gutter" />

      {shown ? (
        <AssetPreview asset={shown} onClose={() => setAssetId(null)} />
      ) : (
        <LinesTable
          project={project}
          search={search}
          onSearch={onSearch}
          searchRef={searchRef}
          gridRef={gridRef}
          onImportText={onPickTable}
          onTranscribe={transcribe}
          onDetect={detect}
          onOpenCue={onOpenCue}
          menu={menu}
        />
      )}

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
}, (prev, next) => prev.hidden && next.hidden)
